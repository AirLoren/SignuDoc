import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import { deleteFinishedEnvelope } from "./envelope-deletion.ts";
import { EnvelopeMutationError } from "./envelopes.ts";
import { getRecipientCertificateKey } from "./services/storage-keys.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import {
  listSystemAuditEvents,
  verifySystemAuditChain,
} from "./services/system-audit.ts";

// An administrator deleting a finished envelope by hand, against a real
// Postgres. Run with `npm run test:db`.

const SOURCE_HASH = "a".repeat(64);
const SIGNED_HASH = "b".repeat(64);
const EVIDENCE_HASH = "c".repeat(64);

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
        signed_pdf_sha256, evidence_sha256, part11
      ) values (
        $1, $2, 'Lease', $3, $4, 'lease.pdf', 4, 1, $14, $5,
        $6, $7, $8, $9, $10, $11, $12, $13
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

async function filesExist(keys: readonly string[]) {
  return Promise.all(
    keys.map(async (key) => (await storageService.headObject(key)).exists),
  );
}

function deleteAs(
  actor: { email: string; userId: string },
  envelopeId: string,
  reason?: string,
) {
  return deleteFinishedEnvelope(
    envelopeId,
    { actor, ipAddress: "203.0.113.9", reason, userAgent: "Test browser" },
    { database, storageService },
  );
}

function rejectsWith(statusCode: number) {
  return (error: unknown) =>
    error instanceof EnvelopeMutationError && error.statusCode === statusCode;
}

for (const status of ["completed", "declined", "voided"] as const) {
  test(`an administrator deletes a ${status} envelope, its files go and the deletion is recorded`, async () => {
    const admin = await createUser("admin");
    const envelope = await createEnvelope(admin.userId, { status });

    assert.ok((await filesExist(envelope.stored)).every(Boolean));

    await deleteAs(admin, envelope.envelopeId, "Kept long enough.");

    assert.equal(await envelopeExists(envelope.envelopeId), false);
    assert.deepEqual(
      await filesExist(envelope.stored),
      envelope.stored.map(() => false),
    );

    const [event] = await listSystemAuditEvents({ limit: 1 }, database);

    assert.equal(event?.event, "envelope_deleted");
    assert.equal(event?.actorUserId, admin.userId);
    assert.equal(event?.actorEmail, admin.email);
    assert.equal(event?.ipAddress, "203.0.113.9");
    assert.deepEqual(
      {
        envelopeId: event?.metadata?.envelopeId,
        evidenceSha256: event?.metadata?.evidenceSha256,
        reason: event?.metadata?.reason,
        sourcePdfHash: event?.metadata?.sourcePdfHash,
        status: event?.metadata?.status,
        title: event?.metadata?.title,
      },
      {
        envelopeId: envelope.envelopeId,
        evidenceSha256: EVIDENCE_HASH,
        reason: "Kept long enough.",
        sourcePdfHash: SOURCE_HASH,
        status,
        title: "Lease",
      },
    );
    assert.equal((await verifySystemAuditChain(database)).ok, true);
  });
}

test("someone who is not an administrator cannot delete a finished envelope", async () => {
  const user = await createUser("user");
  const envelope = await createEnvelope(user.userId, { status: "completed" });
  const before = await listSystemAuditEvents({ limit: 1 }, database);

  await assert.rejects(deleteAs(user, envelope.envelopeId), rejectsWith(403));

  assert.equal(await envelopeExists(envelope.envelopeId), true);
  assert.ok((await filesExist(envelope.stored)).every(Boolean));
  assert.deepEqual(await listSystemAuditEvents({ limit: 1 }, database), before);
});

test("an envelope still out for signature, or a draft, is not deleted this way", async () => {
  const admin = await createUser("admin");

  for (const status of ["sent", "draft"] as const) {
    const envelope = await createEnvelope(admin.userId, { status });

    await assert.rejects(
      deleteAs(admin, envelope.envelopeId),
      rejectsWith(409),
    );
    assert.equal(await envelopeExists(envelope.envelopeId), true);
    assert.ok((await filesExist(envelope.stored)).every(Boolean));
  }
});

test("an administrator cannot delete another account's envelope", async () => {
  const owner = await createUser("admin");
  const other = await createUser("admin");
  const envelope = await createEnvelope(owner.userId, { status: "completed" });

  await assert.rejects(deleteAs(other, envelope.envelopeId), rejectsWith(404));
  assert.equal(await envelopeExists(envelope.envelopeId), true);
});

test("a Part 11 record needs a reason before it is deleted", async () => {
  const admin = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, {
    part11: true,
    status: "completed",
  });

  await assert.rejects(
    deleteAs(admin, envelope.envelopeId, "   "),
    rejectsWith(400),
  );
  assert.equal(await envelopeExists(envelope.envelopeId), true);

  await deleteAs(admin, envelope.envelopeId, "Retention period over.");

  assert.equal(await envelopeExists(envelope.envelopeId), false);

  const [event] = await listSystemAuditEvents({ limit: 1 }, database);

  assert.equal(event?.metadata?.part11, true);
  assert.equal(event?.metadata?.reason, "Retention period over.");
});

test("a reason that is not text, or too long, is refused", async () => {
  const admin = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, { status: "voided" });

  await assert.rejects(
    deleteFinishedEnvelope(
      envelope.envelopeId,
      { actor: admin, reason: 42 },
      { database, storageService },
    ),
    rejectsWith(400),
  );
  await assert.rejects(
    deleteAs(admin, envelope.envelopeId, "x".repeat(1001)),
    rejectsWith(400),
  );
  assert.equal(await envelopeExists(envelope.envelopeId), true);
});

test("when a file cannot be deleted, nothing is deleted and nothing is recorded", async () => {
  const admin = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, { status: "completed" });
  const before = await listSystemAuditEvents({ limit: 1 }, database);
  const failingStorage = {
    ...storageService,
    deleteObject: async () => {
      throw new Error("Storage is down.");
    },
  } as StorageService;

  await assert.rejects(
    deleteFinishedEnvelope(
      envelope.envelopeId,
      { actor: admin },
      { database, storageService: failingStorage },
    ),
    /Storage is down/,
  );
  assert.equal(await envelopeExists(envelope.envelopeId), true);
  assert.deepEqual(await listSystemAuditEvents({ limit: 1 }, database), before);
});
