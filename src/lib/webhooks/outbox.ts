import { afterCommit, type DbExecutor } from "../db/connection.ts";
import type { AuditEventType } from "../types/domain.ts";
import { scheduleWebhookDrain } from "./deliver.ts";
import { webhookEventForAuditEvent } from "./events.ts";

// The outbox: recordAuditEvent calls this with the transaction it writes
// the audit row in, so a delivery exists exactly when its event does. The
// payload is built later, by the first try, from the envelope as it stands
// after the commit (see deliver.ts).
//
// On an install without webhook endpoints this is one INSERT ... SELECT
// over an empty table, which costs nothing worth measuring.

type DrainScheduler = () => void;

let drainScheduler: DrainScheduler = scheduleWebhookDrain;

/**
 * Who starts sending once new deliveries have committed. Tests replace it
 * to send on their own terms; null puts the default back.
 */
export function setWebhookDrainScheduler(scheduler: DrainScheduler | null) {
  drainScheduler = scheduler ?? scheduleWebhookDrain;
}

export async function enqueueWebhookDeliveries(
  input: {
    auditEventId: string;
    createdAt: number;
    envelopeId: string;
    event: AuditEventType;
    metadata: Record<string, unknown> | null;
  },
  database: DbExecutor,
): Promise<number> {
  const type = webhookEventForAuditEvent(input.event);

  if (!type) {
    return 0;
  }

  const signerId =
    typeof input.metadata?.signerId === "string"
      ? input.metadata.signerId
      : null;
  const result = await database.query(
    `
      INSERT INTO webhook_deliveries (
        id, endpoint_id, event_type, envelope_id, audit_event_id, signer_id,
        status, attempts, next_attempt_at, created_at, updated_at
      )
      SELECT
        'msg_' || replace(gen_random_uuid()::text, '-', ''),
        id, $1, $2, $3, $4, 'pending', 0, $5, $5, $5
      FROM webhook_endpoints
      WHERE enabled AND $1 = ANY(events)
    `,
    // Due now. The audit event's own time can be a second ahead, since
    // events on one envelope never share a second.
    [
      type,
      input.envelopeId,
      input.auditEventId,
      signerId,
      Math.min(input.createdAt, Math.floor(Date.now() / 1000)),
    ],
  );
  const queued = result.rowCount ?? 0;

  if (queued > 0) {
    afterCommit(database, () => {
      drainScheduler();
    });
  }

  return queued;
}
