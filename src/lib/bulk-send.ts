import { createHash, randomUUID } from "node:crypto";

import { ZodError } from "zod";

import {
  type BulkSendResult,
  type BulkSendRowResult,
  MAX_BULK_SEND_ROWS,
  parseBulkSendCsv,
  summarizeBulkSendRows,
  validateBulkSendRows,
} from "./bulk-send-csv.ts";
import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
} from "./db/connection.ts";
import {
  EnvelopeMutationError,
  getPrepareEnvelopeDataForUser,
  replaceDraftEnvelopeSigners,
  sendDraftEnvelope,
} from "./envelopes.ts";
import { describePart11SignerProblem, findSignerAccounts } from "./part11.ts";
import {
  bulkSendRequestSchema,
  type BulkSendRequest,
} from "./schemas/bulk-send.ts";
import { logRouteError } from "./security/logging.ts";
import { DocumentImportError } from "./services/document-import.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import { readStoredSettings } from "./settings.ts";
import {
  createDraftFromTemplate,
  describeUnsendableTemplate,
  getTemplateForBulkSend,
  TemplateError,
} from "./templates.ts";
import { type SignatureMeaning } from "./types/domain.ts";

// Send one template to many people: each CSV row becomes its own envelope,
// created from the template and sent the same way a hand-sent draft is.
// Rows are checked first. One row that fails does not take the others with it.
// A confirmed batch is stored by key so a retry does not send the same
// envelopes again.

export const missingBulkSendBatchKeyMessage =
  "This send is missing its batch key.";

export const bulkSendBatchMismatchMessage =
  "This batch key was used with a different list.";

export const bulkSendInvitationUnconfirmedMessage =
  "This envelope was marked sent but the invitation was not recorded. Check your documents before sending this row again.";

export class BulkSendError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "BulkSendError";
    this.statusCode = statusCode;
  }
}

export type BulkSendSender = {
  email: string;
  ipAddress?: string | null;
  name: string;
  userAgent?: string | null;
};

type BulkSendOptions = {
  database?: DbPool;
  sender?: BulkSendSender;
  storageService?: StorageService;
};

type StoredBatch = {
  id: string;
  requestFingerprint: string;
  rows: Map<number, StoredBatchRow>;
};

type StoredBatchRow = {
  envelopeId: string | null;
  reason: string | null;
  status: "failed" | "processing" | "sent" | "skipped";
};

type SendRowContext = {
  batchId: string;
  copyRecipients: NonNullable<BulkSendRequest["copyRecipients"]>;
  database: DbPool;
  expiresInDays: BulkSendRequest["expiresInDays"];
  progress: { envelopeId: string | null };
  reminderIntervalDays: BulkSendRequest["reminderIntervalDays"];
  requireEmailCode: boolean;
  sender: BulkSendSender;
  signatureMeaning: SignatureMeaning | null;
  storageService: StorageService;
  templateId: string;
  userId: string;
};

const TERMINAL_ROW_STATUSES = new Set(["failed", "sent", "skipped"]);

function describeSendFailure(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues[0]?.message ?? "Invalid signer details.";
  }

  if (
    error instanceof BulkSendError ||
    error instanceof TemplateError ||
    error instanceof EnvelopeMutationError ||
    error instanceof DocumentImportError
  ) {
    return error.message;
  }

  return "Unable to send this envelope.";
}

function isExpectedSendFailure(error: unknown): boolean {
  return (
    error instanceof ZodError ||
    error instanceof TemplateError ||
    error instanceof EnvelopeMutationError ||
    error instanceof DocumentImportError ||
    error instanceof BulkSendError
  );
}

function withReason(row: BulkSendRowResult, reason: string): BulkSendRowResult {
  return {
    ...row,
    envelopeId: null,
    envelopePath: null,
    reason,
    status: "skipped",
  };
}

async function applyPart11Problems(
  rows: readonly BulkSendRowResult[],
  signatureMeaning: SignatureMeaning | null | undefined,
  database: DbExecutor,
): Promise<BulkSendRowResult[]> {
  const emails = rows.flatMap((row) =>
    row.status === "ok" ? row.signers.map((signer) => signer.email) : [],
  );
  const accounts = await findSignerAccounts(emails, database);

  return rows.map((row) => {
    if (row.status !== "ok") {
      return row;
    }

    for (const signer of row.signers) {
      const problem = describePart11SignerProblem(
        {
          email: signer.email,
          name: signer.name,
          signatureMeaning: signatureMeaning ?? null,
        },
        accounts.get(signer.email.toLowerCase()),
      );

      if (problem) {
        return withReason(row, problem);
      }
    }

    return row;
  });
}

function envelopePath(envelopeId: string): string {
  return `/envelopes/${envelopeId}`;
}

function fingerprintBulkSendRequest(
  templateId: string,
  input: BulkSendRequest,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        copyRecipients: input.copyRecipients ?? [],
        csv: input.csv,
        expiresInDays: input.expiresInDays ?? null,
        reminderIntervalDays: input.reminderIntervalDays ?? null,
        requireEmailCode: input.requireEmailCode === true,
        signatureMeaning: input.signatureMeaning ?? null,
        templateId,
      }),
    )
    .digest("hex");
}

function sentRow(
  row: BulkSendRowResult,
  envelopeId: string,
): BulkSendRowResult {
  return {
    ...row,
    envelopeId,
    envelopePath: envelopePath(envelopeId),
    reason: null,
    status: "sent",
  };
}

function failedRow(
  row: BulkSendRowResult,
  envelopeId: string | null,
  error: unknown,
): BulkSendRowResult {
  return {
    ...row,
    envelopeId,
    envelopePath: envelopeId ? envelopePath(envelopeId) : null,
    reason: describeSendFailure(error),
    status: "failed",
  };
}

async function withBatchLock<T>(
  pool: DbPool,
  lockKey: string,
  run: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 19))", [
      lockKey,
    ]);

    try {
      return await run();
    } finally {
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 19))",
        [lockKey],
      );
    }
  } finally {
    client.release();
  }
}

async function loadBatch(
  userId: string,
  batchKey: string,
  database: DbExecutor,
): Promise<StoredBatch | null> {
  const batch = await queryOne<{
    id: string;
    requestFingerprint: string;
  }>(
    database,
    `
      SELECT id, request_fingerprint AS "requestFingerprint"
      FROM bulk_send_batches
      WHERE user_id = $1 AND batch_key = $2
    `,
    [userId, batchKey],
  );

  if (!batch) {
    return null;
  }

  const rows = await queryMany<{
    envelopeId: string | null;
    reason: string | null;
    rowNumber: number;
    status: StoredBatchRow["status"];
  }>(
    database,
    `
      SELECT
        row_number AS "rowNumber",
        status,
        envelope_id AS "envelopeId",
        reason
      FROM bulk_send_batch_rows
      WHERE batch_id = $1
    `,
    [batch.id],
  );

  return {
    id: batch.id,
    requestFingerprint: batch.requestFingerprint,
    rows: new Map(
      rows.map((row) => [
        row.rowNumber,
        {
          envelopeId: row.envelopeId,
          reason: row.reason,
          status: row.status,
        },
      ]),
    ),
  };
}

async function insertBatch(
  userId: string,
  templateId: string,
  batchKey: string,
  requestFingerprint: string,
  database: DbExecutor,
): Promise<StoredBatch> {
  const id = randomUUID();

  await database.query(
    `
      INSERT INTO bulk_send_batches (
        id,
        user_id,
        template_id,
        batch_key,
        request_fingerprint
      )
      VALUES ($1, $2, $3, $4, $5)
    `,
    [id, userId, templateId, batchKey, requestFingerprint],
  );

  return { id, requestFingerprint, rows: new Map() };
}

async function ensureBatch(
  userId: string,
  templateId: string,
  batchKey: string,
  requestFingerprint: string,
  database: DbExecutor,
): Promise<StoredBatch> {
  const existing = await loadBatch(userId, batchKey, database);

  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new BulkSendError(bulkSendBatchMismatchMessage, 409);
    }

    return existing;
  }

  try {
    return await insertBatch(
      userId,
      templateId,
      batchKey,
      requestFingerprint,
      database,
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      const raced = await loadBatch(userId, batchKey, database);

      if (raced) {
        if (raced.requestFingerprint !== requestFingerprint) {
          throw new BulkSendError(bulkSendBatchMismatchMessage, 409);
        }

        return raced;
      }
    }

    throw error;
  }
}

async function saveBatchRow(
  batchId: string,
  row: BulkSendRowResult,
  status: StoredBatchRow["status"],
  database: DbExecutor,
): Promise<void> {
  await database.query(
    `
      INSERT INTO bulk_send_batch_rows (
        batch_id,
        row_number,
        status,
        envelope_id,
        reason
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (batch_id, row_number)
      DO UPDATE SET
        status = EXCLUDED.status,
        envelope_id = EXCLUDED.envelope_id,
        reason = EXCLUDED.reason
    `,
    [batchId, row.rowNumber, status, row.envelopeId, row.reason],
  );
}

async function invitationWasRecorded(
  envelopeId: string,
  database: DbExecutor,
): Promise<boolean> {
  const row = await queryOne<{ ok: number }>(
    database,
    `
      SELECT 1 AS ok
      FROM audit_events
      WHERE envelope_id = $1
        AND event = 'email_sent'
        AND metadata->>'template' = 'signing_invitation'
      LIMIT 1
    `,
    [envelopeId],
  );

  return row !== null;
}

function restoreStoredRow(
  row: BulkSendRowResult,
  stored: StoredBatchRow,
): BulkSendRowResult {
  if (stored.status === "sent" && stored.envelopeId) {
    return sentRow(row, stored.envelopeId);
  }

  if (stored.status === "skipped") {
    return {
      ...row,
      envelopeId: null,
      envelopePath: null,
      reason: stored.reason,
      status: "skipped",
    };
  }

  return {
    ...row,
    envelopeId: stored.envelopeId,
    envelopePath: stored.envelopeId ? envelopePath(stored.envelopeId) : null,
    reason: stored.reason ?? "Unable to send this envelope.",
    status: "failed",
  };
}

async function sendOneRow(
  row: BulkSendRowResult,
  stored: StoredBatchRow | undefined,
  context: SendRowContext,
): Promise<BulkSendRowResult> {
  const {
    batchId,
    copyRecipients,
    database,
    expiresInDays,
    progress,
    reminderIntervalDays,
    requireEmailCode,
    sender,
    signatureMeaning,
    storageService,
    templateId,
    userId,
  } = context;
  const needsSignerUpdate =
    copyRecipients.length > 0 || requireEmailCode || signatureMeaning !== null;
  let envelopeId = stored?.envelopeId ?? null;

  progress.envelopeId = envelopeId;

  if (envelopeId && (await invitationWasRecorded(envelopeId, database))) {
    return sentRow(row, envelopeId);
  }

  if (envelopeId) {
    const prepared = await getPrepareEnvelopeDataForUser(userId, envelopeId, {
      database,
    });

    if (!prepared) {
      envelopeId = null;
      progress.envelopeId = null;
    } else if (prepared.status !== "draft") {
      throw new BulkSendError(bulkSendInvitationUnconfirmedMessage, 409);
    }
  }

  if (!envelopeId) {
    const draft = await createDraftFromTemplate(
      userId,
      templateId,
      {
        signers: row.signers.map((signer) => ({
          email: signer.email,
          name: signer.name,
        })),
        title: row.title,
      },
      { database, storageService },
    );

    envelopeId = draft.envelopeId;
    progress.envelopeId = envelopeId;
  }

  const processing = {
    ...row,
    envelopeId,
    envelopePath: envelopePath(envelopeId),
  };

  await saveBatchRow(batchId, processing, "processing", database);

  if (needsSignerUpdate) {
    const prepared = await getPrepareEnvelopeDataForUser(userId, envelopeId, {
      database,
    });

    if (!prepared) {
      throw new EnvelopeMutationError("Envelope not found.", 404);
    }

    if (prepared.status === "draft") {
      await replaceDraftEnvelopeSigners(
        userId,
        envelopeId,
        {
          copyRecipients,
          signers: [...prepared.signers]
            .sort((left, right) => left.order - right.order)
            .map((signer) => ({
              email: signer.email,
              id: signer.id,
              name: signer.name,
              requireEmailCode,
              signatureMeaning,
            })),
        },
        database,
      );
    }
  }

  try {
    await sendDraftEnvelope(
      userId,
      envelopeId,
      {
        expiresInDays,
        ipAddress: sender.ipAddress,
        reminderIntervalDays,
        senderEmail: sender.email,
        senderName: sender.name,
        signatureLevel: "simple",
        userAgent: sender.userAgent,
      },
      { database },
    );
  } catch (error) {
    if (
      error instanceof EnvelopeMutationError &&
      (error.message === "Only draft envelopes can be sent." ||
        error.message === "This envelope has already been sent.") &&
      (await invitationWasRecorded(envelopeId, database))
    ) {
      return sentRow(row, envelopeId);
    }

    throw error;
  }

  return sentRow(row, envelopeId);
}

/**
 * Reads a CSV of people for a template the user owns. With confirm, each
 * valid row is turned into an envelope and sent. Invalid rows are skipped
 * and a failure on one row does not roll back the others. Confirming again
 * with the same batch key returns the stored results.
 */
export async function bulkSendFromTemplate(
  userId: string,
  templateId: string,
  input: unknown,
  {
    database = getDb(),
    sender,
    storageService = createStorageService(),
  }: BulkSendOptions = {},
): Promise<BulkSendResult> {
  const parsedInput = bulkSendRequestSchema.parse(input);
  const template = await getTemplateForBulkSend(userId, templateId, database);

  if (!template) {
    throw new TemplateError("Template not found.", 404);
  }

  const unsendable = describeUnsendableTemplate(
    template.roles,
    template.fields,
  );

  if (unsendable) {
    throw new BulkSendError(unsendable, 400);
  }

  if (parsedInput.confirm && parsedInput.permittedUseConfirmed !== true) {
    throw new BulkSendError(
      "Confirm that these envelopes are ordinary business agreements before sending.",
      400,
    );
  }

  if (parsedInput.confirm && !parsedInput.batchKey) {
    throw new BulkSendError(missingBulkSendBatchKeyMessage, 400);
  }

  if (parsedInput.confirm && !sender) {
    throw new BulkSendError("Unable to send this envelope.", 500);
  }

  const parsedCsv = parseBulkSendCsv(
    parsedInput.csv,
    template.roles,
    template.name,
  );

  if (parsedCsv.error) {
    throw new BulkSendError(parsedCsv.error, 400);
  }

  const copyRecipientEmails = (parsedInput.copyRecipients ?? []).map(
    (recipient) => recipient.email,
  );
  let rows = validateBulkSendRows(parsedCsv.rows, copyRecipientEmails);
  const part11 = (await readStoredSettings(database))?.part11Mode ?? false;

  if (part11) {
    rows = await applyPart11Problems(
      rows,
      parsedInput.signatureMeaning,
      database,
    );
  }

  const resultFor = (nextRows: BulkSendRowResult[]): BulkSendResult => ({
    error: null,
    maxRows: MAX_BULK_SEND_ROWS,
    rows: nextRows,
    summary: summarizeBulkSendRows(nextRows),
    templateId: template.id,
    templateName: template.name,
  });

  if (!parsedInput.confirm) {
    return resultFor(rows);
  }

  const batchKey = parsedInput.batchKey!;
  const copyRecipients = parsedInput.copyRecipients ?? [];
  const requireEmailCode = parsedInput.requireEmailCode === true;
  const signatureMeaning = parsedInput.signatureMeaning ?? null;
  const fingerprint = fingerprintBulkSendRequest(template.id, parsedInput);

  return withBatchLock(database, `${userId}:${batchKey}`, async () => {
    const batch = await ensureBatch(
      userId,
      template.id,
      batchKey,
      fingerprint,
      database,
    );
    const sent: BulkSendRowResult[] = [];

    for (const row of rows) {
      const stored = batch.rows.get(row.rowNumber);

      if (stored && TERMINAL_ROW_STATUSES.has(stored.status)) {
        sent.push(restoreStoredRow(row, stored));
        continue;
      }

      if (row.status !== "ok") {
        await saveBatchRow(batch.id, row, "skipped", database);
        sent.push(row);
        continue;
      }

      const progress = { envelopeId: stored?.envelopeId ?? null };

      try {
        const result = await sendOneRow(row, stored, {
          batchId: batch.id,
          copyRecipients,
          database,
          expiresInDays: parsedInput.expiresInDays,
          progress,
          reminderIntervalDays: parsedInput.reminderIntervalDays,
          requireEmailCode,
          sender: sender!,
          signatureMeaning,
          storageService,
          templateId,
          userId,
        });

        await saveBatchRow(batch.id, result, "sent", database);
        sent.push(result);
      } catch (error) {
        if (!isExpectedSendFailure(error)) {
          logRouteError(error, {
            category: "template_bulk_send_row_failure",
            message:
              "Unexpected failure while sending one row of a template batch.",
            metadata: {
              envelopeId: progress.envelopeId,
              rowNumber: row.rowNumber,
              templateId: template.id,
            },
            userId,
          });
        }

        const failed = failedRow(row, progress.envelopeId, error);

        await saveBatchRow(batch.id, failed, "failed", database);
        sent.push(failed);
      }
    }

    return resultFor(sent);
  });
}
