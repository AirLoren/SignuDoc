import {
  type DbPool,
  getDb,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import { EnvelopeMutationError } from "./envelopes.ts";
import { deleteEnvelopesAndFiles } from "./retention.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import { recordSystemAuditEvent } from "./services/system-audit.ts";

// An administrator may delete a finished envelope of theirs by hand: the
// signed PDF, the certificates, the fields and the envelope's own audit
// trail all go, as they do when the retention period deletes it. What was
// deleted, by whom and why stays in the install's audit trail, with the
// fingerprints the certificate gave, so the deletion itself is on record.

const FINISHED_STATUSES = ["completed", "declined", "voided"] as const;

export const ENVELOPE_DELETION_REASON_MAX_LENGTH = 1000;

type FinishedEnvelopeRow = {
  evidenceSha256: string | null;
  finishedAt: number | null;
  id: string;
  part11: boolean;
  signedPdfSha256: string | null;
  sourcePdfHash: string;
  status: string;
  title: string;
};

export type FinishedEnvelopeDeletion = {
  actor: { email: string; userId: string };
  ipAddress?: string | null;
  reason?: unknown;
  userAgent?: string | null;
};

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
 * Deletes a completed, declined or voided envelope the administrator owns,
 * with its files, and records the deletion in the install's audit trail.
 */
export async function deleteFinishedEnvelope(
  envelopeId: string,
  {
    actor,
    ipAddress = null,
    reason,
    userAgent = null,
  }: FinishedEnvelopeDeletion,
  {
    database = getDb(),
    storageService = createStorageService(),
  }: {
    database?: DbPool;
    storageService?: StorageService;
  } = {},
): Promise<{ deletedEnvelopeId: string }> {
  return withTransaction(async (tx) => {
    // The envelope row first, as everything that changes an envelope takes
    // it; the install's audit trail lock comes after.
    const envelope = await queryOne<FinishedEnvelopeRow>(
      tx,
      `
        SELECT
          id,
          title,
          status,
          part11,
          source_pdf_hash AS "sourcePdfHash",
          signed_pdf_sha256 AS "signedPdfSha256",
          evidence_sha256 AS "evidenceSha256",
          COALESCE(completed_at, declined_at, voided_at) AS "finishedAt"
        FROM envelopes
        WHERE id = $1 AND user_id = $2
        FOR UPDATE
      `,
      [envelopeId, actor.userId],
    );

    if (!envelope) {
      throw new EnvelopeMutationError("Envelope not found.", 404);
    }

    if (!(FINISHED_STATUSES as readonly string[]).includes(envelope.status)) {
      throw new EnvelopeMutationError(
        envelope.status === "sent"
          ? "This envelope is still out for signature. Void it first."
          : "Only finished envelopes can be deleted this way.",
        409,
      );
    }

    // Asked again here, not only by the route: the role is read from the
    // database, and a change since the page loaded is honored.
    const actorRole = await queryOne<{ role: string }>(
      tx,
      `SELECT role FROM public."user" WHERE id = $1`,
      [actor.userId],
    );

    if (actorRole?.role !== "admin") {
      throw new EnvelopeMutationError(
        "Only an administrator can delete a finished envelope.",
        403,
      );
    }

    const deletionReason = parseReason(reason, envelope.part11);

    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.userId,
        event: "envelope_deleted",
        ipAddress,
        metadata: {
          envelopeId: envelope.id,
          evidenceSha256: envelope.evidenceSha256,
          finishedAt: envelope.finishedAt,
          part11: envelope.part11,
          reason: deletionReason,
          signedPdfSha256: envelope.signedPdfSha256,
          sourcePdfHash: envelope.sourcePdfHash,
          status: envelope.status,
          title: envelope.title,
        },
        userAgent,
      },
      tx,
    );

    // Files first, then the row, all while the row is held: if a file
    // cannot be deleted, the whole deletion rolls back and can be tried
    // again.
    const deleted = await deleteEnvelopesAndFiles(
      [envelope.id],
      tx,
      storageService,
    );

    if (deleted !== 1) {
      throw new EnvelopeMutationError("Envelope not found.", 404);
    }

    return { deletedEnvelopeId: envelope.id };
  }, database);
}
