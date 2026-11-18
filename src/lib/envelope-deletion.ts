import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import { EnvelopeMutationError } from "./envelopes.ts";
import {
  deletePendingFile,
  listEnvelopeStorageKeys,
  queueFileDeletions,
} from "./retention.ts";
import { createEmailService, type EmailService } from "./services/email.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import { recordSystemAuditEvent } from "./services/system-audit.ts";
import { resolveAppUrl } from "./utils/env.ts";

// An administrator may delete any finished envelope, their own or another
// member's, but not at once. Asking schedules it: the envelope stays as it
// is for ENVELOPE_DELETION_WAIT_DAYS, its sender is emailed a link to
// download it, and any administrator can cancel until then. The daily
// cleanup then deletes the signed PDF, the certificates, the fields and the
// envelope's own audit trail, as the retention period does. Asking,
// cancelling and the deletion itself all stay in the install's audit
// trail, the last with the fingerprints the certificate gave.

const FINISHED_STATUSES = ["completed", "declined", "voided"] as const;

export const ENVELOPE_DELETION_REASON_MAX_LENGTH = 1000;

/** How long a scheduled deletion waits, so it can be cancelled. */
export const ENVELOPE_DELETION_WAIT_DAYS = 14;

const DAY_IN_SECONDS = 24 * 60 * 60;

/** How many due deletions, and sender notices, one daily run handles. */
const SCHEDULED_DELETIONS_PER_RUN = 100;

type FinishedEnvelopeRow = {
  evidenceSha256: string | null;
  finishedAt: number | null;
  id: string;
  ownerUserId: string;
  part11: boolean;
  recipientEvidenceSha256: string | null;
  signedPdfSha256: string | null;
  sourcePdfHash: string;
  status: string;
  title: string;
};

type OwnerRow = { email: string; name: string | null; role: string };

type ScheduleRow = {
  deleteAfter: number;
  reason: string | null;
  requestedAt: number;
  requestedByEmail: string;
  requestedByUserId: string;
  senderNotifiedAt: number | null;
};

export type ScheduledEnvelopeDeletion = {
  deleteAfter: number;
  reason: string | null;
  requestedAt: number;
  requestedByEmail: string;
};

export type EnvelopeDeletionRequest = {
  actor: { email: string; userId: string };
  ipAddress?: string | null;
  reason?: unknown;
  userAgent?: string | null;
};

function currentTime(): number {
  return Math.floor(Date.now() / 1000);
}

function formatDay(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function parseReason(reason: unknown, part11: boolean): string | null {
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    throw new EnvelopeMutationError("The reason must be text.", 400);
  }

  const trimmed = typeof reason === "string" ? reason.trim() : "";

  if (trimmed.length > ENVELOPE_DELETION_REASON_MAX_LENGTH) {
    throw new EnvelopeMutationError(
      `Keep the reason under ${String(ENVELOPE_DELETION_REASON_MAX_LENGTH)} characters.`,
      400,
    );
  }

  if (part11 && trimmed.length === 0) {
    throw new EnvelopeMutationError(
      "Give a reason for deleting this Part 11 record.",
      400,
    );
  }

  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Locks a finished envelope for an administrator, or for the daily cleanup
 * when `actorUserId` is null, in the one order everything here uses.
 *
 * The account rows come before the envelope row: the sender's, then the
 * administrator's. Taking away a role, and closing an account, hold that
 * account's row (FOR UPDATE) before they take the audit trail lock and
 * move its envelopes, so the two wait in turn here instead of each holding
 * what the other needs. Read under these locks, the administrator's role is
 * the one in force: a change since the page loaded is honored. The
 * envelope row comes next, then the install's audit trail lock.
 */
async function lockFinishedEnvelope(
  tx: DbExecutor,
  envelopeId: string,
  actorUserId: string | null,
): Promise<{ envelope: FinishedEnvelopeRow; owner: OwnerRow | null }> {
  // Whose envelope it is, read first without a lock, so that the sender's
  // account row can be taken before the envelope row.
  const located = await queryOne<{ ownerUserId: string }>(
    tx,
    `SELECT user_id AS "ownerUserId" FROM envelopes WHERE id = $1`,
    [envelopeId],
  );

  if (!located) {
    throw new EnvelopeMutationError("Envelope not found.", 404);
  }

  const owner = await queryOne<OwnerRow>(
    tx,
    `SELECT email, name, role FROM public."user" WHERE id = $1 FOR SHARE`,
    [located.ownerUserId],
  );
  let actorIsAdmin = true;

  if (actorUserId !== null) {
    const actorIsOwner = located.ownerUserId === actorUserId;
    const actorRole = actorIsOwner
      ? owner
      : await queryOne<{ role: string }>(
          tx,
          `SELECT role FROM public."user" WHERE id = $1 FOR SHARE`,
          [actorUserId],
        );

    actorIsAdmin = actorRole?.role === "admin";

    // Someone else's envelope is not there for anyone but an
    // administrator.
    if (!actorIsOwner && !actorIsAdmin) {
      throw new EnvelopeMutationError("Envelope not found.", 404);
    }
  }

  const envelope = await queryOne<FinishedEnvelopeRow>(
    tx,
    `
      SELECT
        id,
        user_id AS "ownerUserId",
        title,
        status,
        part11,
        source_pdf_hash AS "sourcePdfHash",
        signed_pdf_sha256 AS "signedPdfSha256",
        evidence_sha256 AS "evidenceSha256",
        recipient_evidence_sha256 AS "recipientEvidenceSha256",
        COALESCE(completed_at, declined_at, voided_at) AS "finishedAt"
      FROM envelopes
      WHERE id = $1
      FOR UPDATE
    `,
    [envelopeId],
  );

  if (!envelope) {
    throw new EnvelopeMutationError("Envelope not found.", 404);
  }

  if (envelope.ownerUserId !== located.ownerUserId) {
    // Handed to another administrator in the moment between.
    throw new EnvelopeMutationError(
      "This envelope just moved to another account. Reload the page and try again.",
      409,
    );
  }

  if (!(FINISHED_STATUSES as readonly string[]).includes(envelope.status)) {
    throw new EnvelopeMutationError(
      envelope.status === "sent"
        ? "This envelope is still out for signature. Void it first."
        : "Only finished envelopes can be deleted this way.",
      409,
    );
  }

  if (!actorIsAdmin) {
    throw new EnvelopeMutationError(
      "Only an administrator can delete a finished envelope.",
      403,
    );
  }

  return { envelope, owner };
}

const SCHEDULE_COLUMNS = `
  requested_by_user_id AS "requestedByUserId",
  requested_by_email AS "requestedByEmail",
  requested_at AS "requestedAt",
  delete_after AS "deleteAfter",
  reason,
  sender_notified_at AS "senderNotifiedAt"
`;

/** The deletion scheduled for an envelope, if there is one. */
export async function getScheduledEnvelopeDeletion(
  envelopeId: string,
  database: DbExecutor = getDb(),
): Promise<ScheduledEnvelopeDeletion | null> {
  const row = await queryOne<ScheduleRow>(
    database,
    `SELECT ${SCHEDULE_COLUMNS} FROM scheduled_envelope_deletions WHERE envelope_id = $1`,
    [envelopeId],
  );

  return row
    ? {
        deleteAfter: row.deleteAfter,
        reason: row.reason,
        requestedAt: row.requestedAt,
        requestedByEmail: row.requestedByEmail,
      }
    : null;
}

function envelopeLink(envelopeId: string): string | null {
  const appUrl = resolveAppUrl();

  return appUrl ? `${appUrl}/envelopes/${envelopeId}` : null;
}

/** Tells the sender that their envelope will be deleted, and when. */
async function sendDeletionNotice(
  {
    deleteAfter,
    envelopeId,
    ownerEmail,
    ownerName,
    requestedAt,
    requestedByEmail,
    title,
  }: {
    deleteAfter: number;
    envelopeId: string;
    ownerEmail: string;
    ownerName: string | null;
    requestedAt: number;
    requestedByEmail: string;
    title: string;
  },
  database: DbExecutor,
  emailService: EmailService,
): Promise<void> {
  const link = envelopeLink(envelopeId);

  await emailService.send(
    {
      subject: `"${title}" will be deleted on ${formatDay(deleteAfter)}`,
      template: "deletion_notice",
      textBody: [
        `Hello ${ownerName?.trim() || ownerEmail},`,
        "",
        `An administrator of your organization (${requestedByEmail}) has scheduled "${title}" and its audit trail to be deleted on or after ${formatDay(deleteAfter)}.`,
        "",
        "Download the signed PDF and the certificate before then if you need to keep them. If this is a mistake, ask an administrator: they can cancel it until that day.",
        ...(link ? ["", link] : []),
      ].join("\n"),
      to: ownerEmail,
    },
    { idempotencyKey: `deletion-notice/${envelopeId}/${String(requestedAt)}` },
  );

  await database.query(
    `
      UPDATE scheduled_envelope_deletions
      SET sender_notified_at = $1
      WHERE envelope_id = $2 AND requested_at = $3
    `,
    [currentTime(), envelopeId, requestedAt],
  );
}

/**
 * Schedules a completed, declined or voided envelope, the administrator's
 * own or another member's, to be deleted once the waiting period is over,
 * and emails its sender a link to download it.
 */
export async function scheduleEnvelopeDeletion(
  envelopeId: string,
  { actor, ipAddress = null, reason, userAgent = null }: EnvelopeDeletionRequest,
  {
    database = getDb(),
    emailService,
    now = currentTime(),
  }: {
    database?: DbPool;
    emailService?: EmailService;
    now?: number;
  } = {},
): Promise<ScheduledEnvelopeDeletion> {
  const deleteAfter = now + ENVELOPE_DELETION_WAIT_DAYS * DAY_IN_SECONDS;
  const scheduled = await withTransaction(async (tx) => {
    const { envelope, owner } = await lockFinishedEnvelope(
      tx,
      envelopeId,
      actor.userId,
    );
    const deletionReason = parseReason(reason, envelope.part11);
    const senderIsActor = envelope.ownerUserId === actor.userId;
    const inserted = await tx.query(
      `
        INSERT INTO scheduled_envelope_deletions (
          envelope_id, requested_by_user_id, requested_by_email,
          requested_at, delete_after, reason, sender_notified_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (envelope_id) DO NOTHING
      `,
      [
        envelope.id,
        actor.userId,
        actor.email,
        now,
        deleteAfter,
        deletionReason,
        // Nobody to tell when the sender asked themselves.
        senderIsActor ? now : null,
      ],
    );

    if (inserted.rowCount !== 1) {
      throw new EnvelopeMutationError(
        "This envelope is already scheduled to be deleted.",
        409,
      );
    }

    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.userId,
        event: "envelope_deletion_scheduled",
        ipAddress,
        metadata: {
          deleteAfter,
          envelopeId: envelope.id,
          ownerEmail: owner?.email ?? null,
          ownerUserId: envelope.ownerUserId,
          part11: envelope.part11,
          reason: deletionReason,
          status: envelope.status,
          title: envelope.title,
        },
        targetUserId: envelope.ownerUserId,
        userAgent,
      },
      tx,
    );

    return {
      notice:
        !senderIsActor && owner
          ? {
              deleteAfter,
              envelopeId: envelope.id,
              ownerEmail: owner.email,
              ownerName: owner.name,
              requestedAt: now,
              requestedByEmail: actor.email,
              title: envelope.title,
            }
          : null,
      reason: deletionReason,
    };
  }, database);

  // The schedule stands whatever happens to the email; the daily cleanup
  // tries again until it goes out.
  if (scheduled.notice) {
    try {
      await sendDeletionNotice(
        scheduled.notice,
        database,
        emailService ?? createEmailService(),
      );
    } catch (error) {
      console.error(
        `Telling the sender about the deletion of envelope ${envelopeId} failed:`,
        error,
      );
    }
  }

  return {
    deleteAfter,
    reason: scheduled.reason,
    requestedAt: now,
    requestedByEmail: actor.email,
  };
}

/**
 * Cancels a scheduled deletion. Any administrator may, whoever asked for
 * it. A sender who was told it would go is told it will not.
 */
export async function cancelEnvelopeDeletion(
  envelopeId: string,
  {
    actor,
    ipAddress = null,
    userAgent = null,
  }: Omit<EnvelopeDeletionRequest, "reason">,
  {
    database = getDb(),
    emailService,
  }: {
    database?: DbPool;
    emailService?: EmailService;
  } = {},
): Promise<{ envelopeId: string }> {
  const cancelled = await withTransaction(async (tx) => {
    const { envelope, owner } = await lockFinishedEnvelope(
      tx,
      envelopeId,
      actor.userId,
    );
    const schedule = await queryOne<ScheduleRow>(
      tx,
      `
        DELETE FROM scheduled_envelope_deletions
        WHERE envelope_id = $1
        RETURNING ${SCHEDULE_COLUMNS}
      `,
      [envelope.id],
    );

    if (!schedule) {
      throw new EnvelopeMutationError(
        "This envelope is not scheduled to be deleted.",
        409,
      );
    }

    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.userId,
        event: "envelope_deletion_cancelled",
        ipAddress,
        metadata: {
          deleteAfter: schedule.deleteAfter,
          envelopeId: envelope.id,
          ownerEmail: owner?.email ?? null,
          ownerUserId: envelope.ownerUserId,
          requestedByEmail: schedule.requestedByEmail,
          title: envelope.title,
        },
        targetUserId: envelope.ownerUserId,
        userAgent,
      },
      tx,
    );

    return {
      // Only a sender who was told, and is someone else.
      notify:
        owner &&
        envelope.ownerUserId !== actor.userId &&
        envelope.ownerUserId !== schedule.requestedByUserId &&
        schedule.senderNotifiedAt !== null
          ? { email: owner.email, name: owner.name, title: envelope.title }
          : null,
    };
  }, database);

  if (cancelled.notify) {
    const link = envelopeLink(envelopeId);

    try {
      await (emailService ?? createEmailService()).send({
        subject: `"${cancelled.notify.title}" will not be deleted`,
        template: "deletion_notice",
        textBody: [
          `Hello ${cancelled.notify.name?.trim() || cancelled.notify.email},`,
          "",
          `An administrator of your organization (${actor.email}) has cancelled the deletion of "${cancelled.notify.title}". It stays as it is.`,
          ...(link ? ["", link] : []),
        ].join("\n"),
        to: cancelled.notify.email,
      });
    } catch (error) {
      console.error(
        `Telling the sender about the cancelled deletion of envelope ${envelopeId} failed:`,
        error,
      );
    }
  }

  return { envelopeId };
}

/**
 * Deletes one envelope whose scheduled deletion is due, with its files,
 * and records the deletion in the install's audit trail under the
 * administrator who asked for it. False when there was nothing due: it was
 * cancelled, or is not due yet.
 */
export async function deleteScheduledEnvelope(
  envelopeId: string,
  {
    database = getDb(),
    now = currentTime(),
    storageService = createStorageService(),
  }: {
    database?: DbPool;
    now?: number;
    storageService?: StorageService;
  } = {},
): Promise<boolean> {
  const result = await withTransaction(async (tx) => {
    const { envelope, owner } = await lockFinishedEnvelope(
      tx,
      envelopeId,
      null,
    );
    // Cancelled, or not due, by the time it was locked: nothing to do.
    const schedule = await queryOne<ScheduleRow>(
      tx,
      `
        SELECT ${SCHEDULE_COLUMNS}
        FROM scheduled_envelope_deletions
        WHERE envelope_id = $1 AND delete_after <= $2
        FOR UPDATE
      `,
      [envelope.id, now],
    );

    if (!schedule) {
      return null;
    }

    await recordSystemAuditEvent(
      {
        actorEmail: schedule.requestedByEmail,
        actorUserId: schedule.requestedByUserId,
        event: "envelope_deleted",
        metadata: {
          envelopeId: envelope.id,
          evidenceSha256: envelope.evidenceSha256,
          finishedAt: envelope.finishedAt,
          ownerEmail: owner?.email ?? null,
          ownerUserId: envelope.ownerUserId,
          part11: envelope.part11,
          reason: schedule.reason,
          recipientEvidenceSha256: envelope.recipientEvidenceSha256,
          requestedAt: schedule.requestedAt,
          senderNotified: schedule.senderNotifiedAt !== null,
          signedPdfSha256: envelope.signedPdfSha256,
          sourcePdfHash: envelope.sourcePdfHash,
          status: envelope.status,
          title: envelope.title,
        },
        targetUserId: envelope.ownerUserId,
      },
      tx,
    );

    // The row, the record of its deletion and the list of its files commit
    // together. The files cannot roll back with them, so they go only after
    // the commit; one that cannot be deleted then stays on the list, and
    // the daily cleanup tries it again.
    const storageKeys = await listEnvelopeStorageKeys(envelope.id, tx);

    await queueFileDeletions(envelope.id, storageKeys, now, tx);
    await tx.query(`DELETE FROM envelopes WHERE id = $1`, [envelope.id]);

    return storageKeys;
  }, database);

  if (!result) {
    return false;
  }

  for (const key of result) {
    await deletePendingFile(key, database, storageService);
  }

  return true;
}

export type ScheduledDeletionSummary = {
  deleted: number;
  failures: string[];
  noticeFailures: string[];
  noticesSent: number;
};

/**
 * The daily part: emails any sender not yet told, then deletes the
 * envelopes whose wait is over.
 */
export async function runScheduledEnvelopeDeletions({
  database = getDb(),
  emailService,
  now = currentTime(),
  storageService = createStorageService(),
}: {
  database?: DbPool;
  emailService?: EmailService;
  now?: number;
  storageService?: StorageService;
} = {}): Promise<ScheduledDeletionSummary> {
  const summary: ScheduledDeletionSummary = {
    deleted: 0,
    failures: [],
    noticeFailures: [],
    noticesSent: 0,
  };
  const unsent = await queryMany<
    ScheduleRow & {
      envelopeId: string;
      ownerEmail: string;
      ownerName: string | null;
      title: string;
    }
  >(
    database,
    `
      SELECT
        s.envelope_id AS "envelopeId",
        ${SCHEDULE_COLUMNS},
        e.title,
        u.email AS "ownerEmail",
        u.name AS "ownerName"
      FROM scheduled_envelope_deletions s
      JOIN envelopes e ON e.id = s.envelope_id
      JOIN public."user" u ON u.id = e.user_id
      WHERE s.sender_notified_at IS NULL AND s.delete_after > $1
      ORDER BY s.requested_at ASC
      LIMIT ${String(SCHEDULED_DELETIONS_PER_RUN)}
    `,
    [now],
  );
  let service = emailService;

  for (const row of unsent) {
    try {
      await sendDeletionNotice(
        {
          deleteAfter: row.deleteAfter,
          envelopeId: row.envelopeId,
          ownerEmail: row.ownerEmail,
          ownerName: row.ownerName,
          requestedAt: row.requestedAt,
          requestedByEmail: row.requestedByEmail,
          title: row.title,
        },
        database,
        (service ??= createEmailService()),
      );
      summary.noticesSent += 1;
    } catch (error) {
      summary.noticeFailures.push(row.envelopeId);
      console.error(
        `Telling the sender about the deletion of envelope ${row.envelopeId} failed:`,
        error,
      );
    }
  }

  const due = await queryMany<{ envelopeId: string }>(
    database,
    `
      SELECT envelope_id AS "envelopeId"
      FROM scheduled_envelope_deletions
      WHERE delete_after <= $1
      ORDER BY delete_after ASC, envelope_id ASC
      LIMIT ${String(SCHEDULED_DELETIONS_PER_RUN)}
    `,
    [now],
  );

  for (const { envelopeId } of due) {
    try {
      if (
        await deleteScheduledEnvelope(envelopeId, {
          database,
          now,
          storageService,
        })
      ) {
        summary.deleted += 1;
      }
    } catch (error) {
      summary.failures.push(envelopeId);
      console.error(
        `The scheduled deletion of envelope ${envelopeId} failed:`,
        error,
      );
    }
  }

  return summary;
}
