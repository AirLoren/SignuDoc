import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import {
  cancelEnvelopeDeletion,
  deleteScheduledEnvelope,
  ENVELOPE_DELETION_WAIT_DAYS,
  getScheduledEnvelopeDeletion,
  runScheduledEnvelopeDeletions,
  scheduleEnvelopeDeletion,
} from "./envelope-deletion.ts";
import { EnvelopeMutationError } from "./envelopes.ts";
import {
  deletePendingFiles,
  queueFileDeletions,
  runRetentionSweep,
} from "./retention.ts";
import type {
  EmailService,
  TransactionalEmailMessage,
} from "./services/email.ts";
import { getRecipientCertificateKey } from "./services/storage-keys.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import {
  listSystemAuditEvents,
  verifySystemAuditChain,
} from "./services/system-audit.ts";

// An administrator scheduling a finished envelope's deletion, cancelling
// it, and the daily cleanup deleting it once the wait is over, against a
// real Postgres. Run with `npm run test:db`.

const SOURCE_HASH = "a".repeat(64);
const SIGNED_HASH = "b".repeat(64);
const EVIDENCE_HASH = "c".repeat(64);
const RECIPIENT_EVIDENCE_HASH = "d".repeat(64);
// The install audit trail's lock (services/system-audit.ts).
const SYSTEM_AUDIT_LOCK_ID = 746108325;
const DAY = 24 * 60 * 60;
const WAIT = ENVELOPE_DELETION_WAIT_DAYS * DAY;

let database: pg.Pool;
let storageDir: string;
let storageService: StorageService;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-deletion-"));
  Object.assign(process.env, {
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: storageDir,
  });
  storageService = createStorageService();
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

async function createUser(role: "admin" | "user") {
  const id = randomUUID();
  const email = `${id}@example.test`;

  createdUsers.push(id);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Avery Admin', $2, $3)`,
    [id, email, role],
  );

  return { email, userId: id };
}

/** An envelope with its files stored, in the given state. */
async function createEnvelope(
  userId: string,
  {
    part11 = false,
    status,
  }: {
    part11?: boolean;
    status: "completed" | "declined" | "draft" | "sent" | "voided";
  },
) {
  const envelopeId = randomUUID();
  const base = `users/${userId}/envelopes/${envelopeId}`;
  const keys = {
    evidence: `${base}/evidence/internal.pdf`,
    signed: `${base}/signed.pdf`,
    source: `${base}/source.pdf`,
  };
  const finished = status !== "draft" && status !== "sent";
  const stored = [keys.source];

  if (finished) {
    stored.push(
      keys.evidence,
      getRecipientCertificateKey(keys.evidence),
      ...(status === "completed" ? [keys.signed] : []),
    );
  }

  for (const key of stored) {
    await storageService.putObject({
      body: new Uint8Array([37, 80, 68, 70]),
      contentType: "application/pdf",
      key,
    });
  }

  const now = Math.floor(Date.now() / 1000);

  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
        completed_at, declined_at, voided_at, signed_pdf_key, evidence_key,
        signed_pdf_sha256, evidence_sha256, part11, recipient_evidence_sha256
      ) values (
        $1, $2, 'Lease', $3, $4, 'lease.pdf', 4, 1, $14, $5,
        $6, $7, $8, $9, $10, $11, $12, $13, $15
      )
    `,
    [
      envelopeId,
      userId,
      status,
      keys.source,
      status === "draft" ? null : now - 100,
      status === "completed" ? now : null,
      status === "declined" ? now : null,
      status === "voided" ? now : null,
      status === "completed" ? keys.signed : null,
      finished ? keys.evidence : null,
      status === "completed" ? SIGNED_HASH : null,
      finished ? EVIDENCE_HASH : null,
      part11,
      SOURCE_HASH,
      finished ? RECIPIENT_EVIDENCE_HASH : null,
    ],
  );
  await database.query(
    `
      insert into signers (id, envelope_id, name, email, sign_order, status)
      values ($1, $2, 'Riley Recipient', 'riley@example.test', 1, $3)
    `,
    [randomUUID(), envelopeId, status === "completed" ? "signed" : "pending"],
  );

  return { envelopeId, stored };
}

async function envelopeExists(envelopeId: string) {
  const result = await database.query(`select 1 from envelopes where id = $1`, [
    envelopeId,
  ]);

  return result.rowCount === 1;
}

async function pendingFileDeletions(envelopeId: string) {
  const result = await database.query<{ storage_key: string }>(
    `select storage_key from pending_file_deletions where envelope_id = $1`,
    [envelopeId],
  );

  return result.rows.map((row) => row.storage_key);
}

async function filesExist(keys: readonly string[]) {
  return Promise.all(
    keys.map(async (key) => (await storageService.headObject(key)).exists),
  );
}

let sent: TransactionalEmailMessage[] = [];

function createOutbox(fail = false): EmailService {
  return {
    async send(message) {
      if (fail) {
        throw new Error("Email is down.");
      }

      sent.push(message);
      return { accepted: [message.to], rejected: [] };
    },
    async sendBatch(messages) {
      return Promise.all(messages.map((message) => this.send(message)));
    },
  };
}

function emailsTo(address: string) {
  return sent.filter((message) => message.to === address);
}

function scheduleAs(
  actor: { email: string; userId: string },
  envelopeId: string,
  reason?: unknown,
  { emailService = createOutbox(), now = Math.floor(Date.now() / 1000) } = {},
) {
  return scheduleEnvelopeDeletion(
    envelopeId,
    { actor, ipAddress: "203.0.113.9", reason, userAgent: "Test browser" },
    { database, emailService, now },
  );
}

function cancelAs(actor: { email: string; userId: string }, envelopeId: string) {
  return cancelEnvelopeDeletion(
    envelopeId,
    { actor, ipAddress: "203.0.113.9", userAgent: "Test browser" },
    { database, emailService: createOutbox() },
  );
}

function deleteWhenDue(
  envelopeId: string,
  now: number,
  storage: StorageService = storageService,
) {
  return deleteScheduledEnvelope(envelopeId, {
    database,
    now,
    storageService: storage,
  });
}

function rejectsWith(statusCode: number) {
  return (error: unknown) =>
    error instanceof EnvelopeMutationError && error.statusCode === statusCode;
}

async function latestEvent() {
  const [event] = await listSystemAuditEvents({ limit: 1 }, database);

  return event;
}

for (const status of ["completed", "declined", "voided"] as const) {
  test(`a ${status} envelope is scheduled, waits ${String(ENVELOPE_DELETION_WAIT_DAYS)} days, then goes with its files, all on record`, async () => {
    const admin = await createUser("admin");
    const envelope = await createEnvelope(admin.userId, { status });
    const now = Math.floor(Date.now() / 1000);

    const scheduled = await scheduleAs(
      admin,
      envelope.envelopeId,
      "Kept long enough.",
      { now },
    );

    assert.equal(scheduled.deleteAfter, now + WAIT);
    // Nothing goes yet.
    assert.equal(await envelopeExists(envelope.envelopeId), true);
    assert.ok((await filesExist(envelope.stored)).every(Boolean));

    const request = await latestEvent();

    assert.equal(request?.event, "envelope_deletion_scheduled");
    assert.equal(request?.actorUserId, admin.userId);
    assert.equal(request?.ipAddress, "203.0.113.9");
    assert.equal(request?.metadata?.deleteAfter, now + WAIT);
    assert.equal(request?.metadata?.reason, "Kept long enough.");

    // A day early, still nothing.
    assert.equal(await deleteWhenDue(envelope.envelopeId, now + WAIT - DAY), false);
    assert.equal(await envelopeExists(envelope.envelopeId), true);

    assert.equal(await deleteWhenDue(envelope.envelopeId, now + WAIT), true);
    assert.equal(await envelopeExists(envelope.envelopeId), false);
    assert.equal(await getScheduledEnvelopeDeletion(envelope.envelopeId, database), null);
    assert.deepEqual(
      await filesExist(envelope.stored),
      envelope.stored.map(() => false),
    );
    assert.deepEqual(await pendingFileDeletions(envelope.envelopeId), []);

    const event = await latestEvent();

    assert.equal(event?.event, "envelope_deleted");
    // Under the administrator who asked for it.
    assert.equal(event?.actorUserId, admin.userId);
    assert.equal(event?.actorEmail, admin.email);
    assert.deepEqual(
      {
        envelopeId: event?.metadata?.envelopeId,
        evidenceSha256: event?.metadata?.evidenceSha256,
        reason: event?.metadata?.reason,
        recipientEvidenceSha256: event?.metadata?.recipientEvidenceSha256,
        requestedAt: event?.metadata?.requestedAt,
        sourcePdfHash: event?.metadata?.sourcePdfHash,
        status: event?.metadata?.status,
        title: event?.metadata?.title,
      },
      {
        envelopeId: envelope.envelopeId,
        evidenceSha256: EVIDENCE_HASH,
        reason: "Kept long enough.",
        recipientEvidenceSha256: RECIPIENT_EVIDENCE_HASH,
        requestedAt: now,
        sourcePdfHash: SOURCE_HASH,
        status,
        title: "Lease",
      },
    );
    assert.equal((await verifySystemAuditChain(database)).ok, true);
  });
}

test("someone who is not an administrator cannot schedule a deletion", async () => {
  const user = await createUser("user");
  const envelope = await createEnvelope(user.userId, { status: "completed" });
  const before = await listSystemAuditEvents({ limit: 1 }, database);

  await assert.rejects(scheduleAs(user, envelope.envelopeId), rejectsWith(403));

  assert.equal(await getScheduledEnvelopeDeletion(envelope.envelopeId, database), null);
  assert.deepEqual(await listSystemAuditEvents({ limit: 1 }, database), before);
});

test("an envelope still out for signature, or a draft, is not scheduled", async () => {
  const admin = await createUser("admin");

  for (const status of ["sent", "draft"] as const) {
    const envelope = await createEnvelope(admin.userId, { status });

    await assert.rejects(
      scheduleAs(admin, envelope.envelopeId),
      rejectsWith(409),
    );
    assert.equal(
      await getScheduledEnvelopeDeletion(envelope.envelopeId, database),
      null,
    );
  }
});

test("another member's envelope: its sender is emailed, and the records name them", async () => {
  sent = [];
  const owner = await createUser("user");
  const admin = await createUser("admin");
  const envelope = await createEnvelope(owner.userId, { status: "completed" });
  const now = Math.floor(Date.now() / 1000);

  await scheduleAs(admin, envelope.envelopeId, "Asked to by legal.", { now });

  const [notice] = emailsTo(owner.email);

  assert.equal(notice?.template, "deletion_notice");
  assert.match(notice?.subject ?? "", /^"Lease" will be deleted on \d{4}-\d{2}-\d{2}$/);
  assert.match(notice?.textBody ?? "", new RegExp(admin.email.replace(/[.]/g, "\\.")));
  // The reason is for administrators.
  assert.doesNotMatch(notice?.textBody ?? "", /legal/);

  const request = await latestEvent();

  assert.equal(request?.targetUserId, owner.userId);
  assert.equal(request?.metadata?.ownerEmail, owner.email);

  await deleteWhenDue(envelope.envelopeId, now + WAIT);

  const event = await latestEvent();

  assert.equal(event?.event, "envelope_deleted");
  assert.equal(event?.actorUserId, admin.userId);
  assert.equal(event?.metadata?.ownerUserId, owner.userId);
  assert.equal(event?.metadata?.ownerEmail, owner.email);
  assert.equal(event?.metadata?.reason, "Asked to by legal.");
  assert.equal(event?.metadata?.senderNotified, true);
});

test("an administrator's own envelope sends no email", async () => {
  sent = [];
  const admin = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, { status: "completed" });

  await scheduleAs(admin, envelope.envelopeId);

  assert.deepEqual(emailsTo(admin.email), []);
});

test("someone who is not an administrator cannot find another member's envelope", async () => {
  const owner = await createUser("admin");
  const other = await createUser("user");
  const envelope = await createEnvelope(owner.userId, { status: "completed" });

  await assert.rejects(scheduleAs(other, envelope.envelopeId), rejectsWith(404));
  await assert.rejects(cancelAs(other, envelope.envelopeId), rejectsWith(404));
  await assert.rejects(scheduleAs(owner, randomUUID()), rejectsWith(404));
});

test("a deletion already scheduled is not scheduled twice", async () => {
  const admin = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, { status: "completed" });

  await scheduleAs(admin, envelope.envelopeId);
  await assert.rejects(scheduleAs(admin, envelope.envelopeId), rejectsWith(409));
});

test("any administrator can cancel, the sender is told, and nothing is deleted", async () => {
  sent = [];
  const owner = await createUser("user");
  const admin = await createUser("admin");
  const otherAdmin = await createUser("admin");
  const envelope = await createEnvelope(owner.userId, { status: "completed" });
  const now = Math.floor(Date.now() / 1000);

  await scheduleAs(admin, envelope.envelopeId, "Tidying up.", { now });
  await cancelAs(otherAdmin, envelope.envelopeId);

  assert.equal(await getScheduledEnvelopeDeletion(envelope.envelopeId, database), null);

  const event = await latestEvent();

  assert.equal(event?.event, "envelope_deletion_cancelled");
  assert.equal(event?.actorUserId, otherAdmin.userId);
  assert.equal(event?.metadata?.requestedByEmail, admin.email);
  assert.deepEqual(
    emailsTo(owner.email).map((message) => message.subject),
    ['"Lease" will be deleted on ' + new Date((now + WAIT) * 1000).toISOString().slice(0, 10), '"Lease" will not be deleted'],
  );

  // The day it would have gone, it stays.
  assert.equal(await deleteWhenDue(envelope.envelopeId, now + WAIT), false);
  assert.equal(await envelopeExists(envelope.envelopeId), true);
  assert.ok((await filesExist(envelope.stored)).every(Boolean));

  // Nothing left to cancel; a member cannot cancel at all.
  await assert.rejects(cancelAs(admin, envelope.envelopeId), rejectsWith(409));
  await assert.rejects(cancelAs(owner, envelope.envelopeId), rejectsWith(403));
  await assert.rejects(scheduleAs(owner, envelope.envelopeId), rejectsWith(403));
});

test("a Part 11 record needs a reason before it is scheduled", async () => {
  const admin = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, {
    part11: true,
    status: "completed",
  });
  const now = Math.floor(Date.now() / 1000);

  await assert.rejects(
    scheduleAs(admin, envelope.envelopeId, "   "),
    rejectsWith(400),
  );
  assert.equal(await getScheduledEnvelopeDeletion(envelope.envelopeId, database), null);

  await scheduleAs(admin, envelope.envelopeId, "Retention period over.", { now });
  await deleteWhenDue(envelope.envelopeId, now + WAIT);

  assert.equal(await envelopeExists(envelope.envelopeId), false);

  const event = await latestEvent();

  assert.equal(event?.metadata?.part11, true);
  assert.equal(event?.metadata?.reason, "Retention period over.");
});

test("a reason that is not text, or too long, is refused", async () => {
  const admin = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, { status: "voided" });

  await assert.rejects(scheduleAs(admin, envelope.envelopeId, 42), rejectsWith(400));
  await assert.rejects(
    scheduleAs(admin, envelope.envelopeId, "x".repeat(1001)),
    rejectsWith(400),
  );
  assert.equal(await getScheduledEnvelopeDeletion(envelope.envelopeId, database), null);
});

test("when the email to the sender fails, the deletion is still scheduled and the daily run sends it", async () => {
  sent = [];
  const owner = await createUser("user");
  const admin = await createUser("admin");
  const envelope = await createEnvelope(owner.userId, { status: "declined" });
  const now = Math.floor(Date.now() / 1000);
  const originalConsoleError = console.error;

  console.error = () => {};

  try {
    await scheduleAs(admin, envelope.envelopeId, undefined, {
      emailService: createOutbox(true),
      now,
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.ok(await getScheduledEnvelopeDeletion(envelope.envelopeId, database));
  assert.deepEqual(emailsTo(owner.email), []);

  const summary = await runScheduledEnvelopeDeletions({
    database,
    emailService: createOutbox(),
    now: now + DAY,
    storageService,
  });

  assert.ok(summary.noticesSent >= 1);
  assert.equal(emailsTo(owner.email).length, 1);

  // Told once: the next run does not send it again.
  await runScheduledEnvelopeDeletions({
    database,
    emailService: createOutbox(),
    now: now + 2 * DAY,
    storageService,
  });
  assert.equal(emailsTo(owner.email).length, 1);

  // And once the wait is over, the run deletes it.
  const final = await runScheduledEnvelopeDeletions({
    database,
    emailService: createOutbox(),
    now: now + WAIT,
    storageService,
  });

  assert.ok(final.deleted >= 1);
  assert.deepEqual(final.failures, []);
  assert.equal(await envelopeExists(envelope.envelopeId), false);
});

test("when a file cannot be deleted, the envelope is still deleted and recorded, and the next cleanup deletes the file", async () => {
  const admin = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, { status: "completed" });
  const now = Math.floor(Date.now() / 1000);
  const failingStorage = {
    ...storageService,
    deleteObject: async () => {
      throw new Error("Storage is down.");
    },
  } as StorageService;
  const logged: unknown[][] = [];
  const originalConsoleError = console.error;

  await scheduleAs(admin, envelope.envelopeId, undefined, { now });

  console.error = (...args: unknown[]) => {
    logged.push(args);
  };

  try {
    await deleteWhenDue(envelope.envelopeId, now + WAIT, failingStorage);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(await envelopeExists(envelope.envelopeId), false);

  const event = await latestEvent();

  assert.equal(event?.event, "envelope_deleted");
  assert.equal(event?.metadata?.envelopeId, envelope.envelopeId);
  for (const key of envelope.stored) {
    assert.ok(
      logged.some((args) => String(args[0]).includes(key)),
      `expected ${key} to be logged`,
    );
  }
  assert.ok((await filesExist(envelope.stored)).every(Boolean));
  assert.ok(
    (await pendingFileDeletions(envelope.envelopeId)).length >=
      envelope.stored.length,
  );

  // Storage is back: the daily cleanup finishes the job.
  const summary = await runRetentionSweep({ database, storageService });

  assert.ok(summary.pendingFileDeletionsDone >= envelope.stored.length);
  assert.deepEqual(
    await filesExist(envelope.stored),
    envelope.stored.map(() => false),
  );
  assert.deepEqual(await pendingFileDeletions(envelope.envelopeId), []);
});

test("a deletion that is not due touches no file", async () => {
  const admin = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, { status: "completed" });
  const now = Math.floor(Date.now() / 1000);
  let deletes = 0;
  const countingStorage = {
    ...storageService,
    deleteObject: async (key: string) => {
      deletes += 1;
      return storageService.deleteObject(key);
    },
  } as StorageService;

  // Not scheduled at all, then scheduled but not due.
  assert.equal(await deleteWhenDue(envelope.envelopeId, now + WAIT, countingStorage), false);
  await scheduleAs(admin, envelope.envelopeId, undefined, { now });
  assert.equal(await deleteWhenDue(envelope.envelopeId, now, countingStorage), false);
  assert.equal(deletes, 0);
  assert.equal(await envelopeExists(envelope.envelopeId), true);
  assert.ok((await filesExist(envelope.stored)).every(Boolean));
});

test("an administrator whose role is being taken away waits for it, and is then refused", async () => {
  const admin = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, { status: "completed" });
  const demotion = await database.connect();

  try {
    // As taking the role away does: the account row first.
    await demotion.query("begin");
    await demotion.query(
      `select id from public."user" where id = $1 for update`,
      [admin.userId],
    );

    const scheduling = scheduleAs(admin, envelope.envelopeId, "Done.");

    await delay(300);
    await demotion.query(
      `update public."user" set role = 'user' where id = $1`,
      [admin.userId],
    );
    await demotion.query("commit");

    await assert.rejects(scheduling, rejectsWith(403));
  } finally {
    demotion.release();
  }

  assert.equal(await getScheduledEnvelopeDeletion(envelope.envelopeId, database), null);
});

test("a request running while the administrator's handed-over envelopes move does not deadlock", async () => {
  const admin = await createUser("admin");
  const keeper = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, { status: "completed" });
  const demotion = await database.connect();

  try {
    // In the order taking the role away uses: the account row, the audit
    // trail lock, then the envelopes it moves to the administrator who stays.
    await demotion.query("begin");
    await demotion.query(
      `select id from public."user" where id = $1 for update`,
      [admin.userId],
    );
    await demotion.query(
      `update public."user" set role = 'user' where id = $1`,
      [admin.userId],
    );
    await demotion.query("select pg_advisory_xact_lock($1)", [
      SYSTEM_AUDIT_LOCK_ID,
    ]);

    const scheduling = scheduleAs(admin, envelope.envelopeId, "Done.");

    await delay(300);
    await demotion.query(`update envelopes set user_id = $1 where id = $2`, [
      keeper.userId,
      envelope.envelopeId,
    ]);
    await demotion.query("commit");

    // It moved while the request waited: told to look again.
    await assert.rejects(scheduling, rejectsWith(409));
  } finally {
    demotion.release();
  }

  assert.equal(await getScheduledEnvelopeDeletion(envelope.envelopeId, database), null);
});

test("a scheduled deletion still runs after the administrator who asked loses the role", async () => {
  const admin = await createUser("admin");
  const keeper = await createUser("admin");
  const envelope = await createEnvelope(keeper.userId, { status: "completed" });
  const now = Math.floor(Date.now() / 1000);

  await scheduleAs(admin, envelope.envelopeId, "Asked for.", { now });
  await database.query(`update public."user" set role = 'user' where id = $1`, [
    admin.userId,
  ]);

  assert.equal(await deleteWhenDue(envelope.envelopeId, now + WAIT), true);
  assert.equal(await envelopeExists(envelope.envelopeId), false);
});

test("a file that keeps failing goes to the back of the queue, so the others are still reached", async () => {
  const envelopeId = randomUUID();
  const stuck = `test/${envelopeId}/stuck.pdf`;
  const healthy = `test/${envelopeId}/healthy.pdf`;
  // Older than anything else in the queue, so both come first.
  const longAgo = 1;

  for (const key of [stuck, healthy]) {
    await storageService.putObject({
      body: new Uint8Array([37, 80, 68, 70]),
      contentType: "application/pdf",
      key,
    });
  }
  await queueFileDeletions(envelopeId, [stuck], longAgo, database);
  await queueFileDeletions(envelopeId, [healthy], longAgo + 1, database);

  const stuckStorage = {
    ...storageService,
    deleteObject: async (key: string) => {
      if (key === stuck) {
        throw new Error("Storage refuses this one.");
      }

      return storageService.deleteObject(key);
    },
  } as StorageService;
  const originalConsoleError = console.error;

  console.error = () => {};

  try {
    // One at a time: the stuck file first, then, as it was just tried, the
    // healthy one.
    assert.equal(await deletePendingFiles(database, stuckStorage, 1), 0);
    assert.equal(await deletePendingFiles(database, stuckStorage, 1), 1);
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(await filesExist([stuck, healthy]), [true, false]);
  assert.deepEqual(await pendingFileDeletions(envelopeId), [stuck]);

  await deletePendingFiles(database, storageService);
  assert.deepEqual(await pendingFileDeletions(envelopeId), []);
});
