import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { afterStatement, openTestDatabase } from "./db/test-database.ts";
import { getSenderEnvelopeDownload } from "./downloads.ts";
import { ELECTRONIC_RECORDS_DISCLOSURE_VERSION } from "./electronic-records-disclosure.ts";
import { EnvelopeMutationError, voidSentEnvelope } from "./envelopes.ts";
import { verifyAuditChain } from "./services/audit.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import { buildEnvelopeCertificateKey } from "./services/storage-keys.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import {
  declineSigningForToken,
  recordSignerConsent,
  SigningMutationError,
  submitSigningForToken,
} from "./signing.ts";

// Two things ending the same envelope at once, against a real Postgres. An
// envelope's certificates are stored under fixed keys, so the one that loses
// must leave alone the files the one that won saved. Run with
// `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

const DAY = 24 * 60 * 60;

// A PNG of one transparent pixel, standing in for a drawn signature.
const DRAWN_SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let database: pg.Pool;
let storageDir: string;
let storageService: StorageService;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  // The seal and the emails read the install's settings through the shared
  // pool.
  globalThis.__signudocPgPool = database;

  // A void and a decline read their storage and email from the environment.
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-certificates-"));
  Object.assign(process.env, {
    EMAIL_CAPTURE_DIR: path.join(storageDir, "outbox"),
    EMAIL_DRIVER: "capture",
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

/** An envelope waiting on its one signer, with a real document behind it. */
async function createSignableEnvelope() {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const signerId = randomUUID();
  const fieldId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const link = await issueSigningLink({ expiresInSeconds: DAY, issuedAt: now });
  const sourcePdf = await PDFDocument.create();

  sourcePdf.addPage([612, 792]);

  const sourcePdfBytes = await sourcePdf.save();
  const sourcePdfKey = `test/${envelopeId}.pdf`;

  await storageService.putObject({
    body: sourcePdfBytes,
    contentType: "application/pdf",
    key: sourcePdfKey,
  });

  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
    [userId, `${userId}@example.test`],
  );
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at, expires_at
      ) values ($1, $2, 'Lease', 'sent', $3, 'lease.pdf', $4, 1, $5, $6, $7)
    `,
    [
      envelopeId,
      userId,
      sourcePdfKey,
      sourcePdfBytes.length,
      createHash("sha256").update(sourcePdfBytes).digest("hex"),
      now,
      now + DAY,
    ],
  );
  await database.query(
    `
      insert into envelope_pages (id, envelope_id, page_number, width_pt, height_pt)
      values ($1, $2, 1, 612, 792)
    `,
    [randomUUID(), envelopeId],
  );
  await database.query(
    `
      insert into signers (
        id, envelope_id, name, email, sign_order, status,
        signing_token_hash, signing_token_expires_at, last_notified_at
      ) values ($1, $2, 'Riley Recipient', $3, 1, 'notified', $4, $5, $6)
    `,
    [
      signerId,
      envelopeId,
      `${signerId}@example.test`,
      link.tokenHash,
      link.exp,
      now,
    ],
  );
  await database.query(
    `
      insert into fields (
        id, envelope_id, signer_id, type, page, x, y, width, height
      ) values ($1, $2, $3, 'signature', 1, 0.1, 0.1, 0.2, 0.1)
    `,
    [fieldId, envelopeId, signerId],
  );
  await recordSignerConsent(
    link.token,
    { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
    { database },
  );

  return { envelopeId, fieldId, token: link.token, userId };
}

type Envelope = Awaited<ReturnType<typeof createSignableEnvelope>>;

function voidEnvelope(envelope: Envelope, pool: pg.Pool = database) {
  return voidSentEnvelope(
    envelope.userId,
    envelope.envelopeId,
    { senderEmail: "sam@example.test", senderName: "Sam Sender" },
    { database: pool },
  );
}

function declineEnvelope(envelope: Envelope, pool: pg.Pool = database) {
  return declineSigningForToken(
    envelope.token,
    { reason: "Not what we agreed." },
    { database: pool },
  );
}

function signEnvelope(envelope: Envelope, pool: pg.Pool = database) {
  return submitSigningForToken(
    envelope.token,
    {
      clientTimezoneOffsetMinutes: 0,
      fields: [
        {
          fieldId: envelope.fieldId,
          imageDataUrl: DRAWN_SIGNATURE,
          inputMethod: "drawn",
          type: "signature",
        },
      ],
    },
    { database: pool },
  );
}

/** Resolves once another session is held up behind a lock. */
async function waitForLockWaiter() {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const waiting = await database.query(
      `
        select 1
        from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
        limit 1
      `,
    );

    if (waiting.rowCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * The same database, except that `start()` gets under way right after the
 * one using it has written `status`, and before it commits. What `start()`
 * began is then either over or waiting for the envelope: it saw the envelope
 * still out for signature, and loses.
 */
function withRivalAfter(
  status: "declined" | "signed" | "voided",
  start: () => Promise<unknown>,
) {
  const started: { rival?: Promise<unknown> } = {};
  const pool = afterStatement(
    database,
    (text) => !started.rival && text.includes(`status = '${status}'`),
    async () => {
      started.rival = start();
      await Promise.race([
        started.rival.then(
          () => undefined,
          () => undefined,
        ),
        waitForLockWaiter(),
      ]);
    },
  );

  return { pool, started };
}

/**
 * The envelope ended the way the winner ended it, and both of its
 * certificates are the files the winner stored: still there, and still the
 * ones whose fingerprints the envelope's row holds.
 */
async function assertCertificatesKept(envelope: Envelope, status: string) {
  const row = await database.query<{
    evidence_key: string | null;
    evidence_sha256: string | null;
    recipient_evidence_sha256: string | null;
    status: string;
  }>(
    `
      select status, evidence_key, evidence_sha256, recipient_evidence_sha256
      from envelopes
      where id = $1
    `,
    [envelope.envelopeId],
  );
  const stored = row.rows[0]!;
  const internalKey = buildEnvelopeCertificateKey({
    ...envelope,
    audience: "internal",
  });
  const recipientKey = buildEnvelopeCertificateKey({
    ...envelope,
    audience: "recipient",
  });

  assert.equal(stored.status, status);
  assert.equal(stored.evidence_key, internalKey);

  for (const [key, sha256] of [
    [internalKey, stored.evidence_sha256],
    [recipientKey, stored.recipient_evidence_sha256],
  ] as const) {
    assert.equal(
      (await storageService.headObject(key)).exists,
      true,
      `${key} is gone`,
    );
    assert.equal(
      createHash("sha256")
        .update((await storageService.getObject(key)).body)
        .digest("hex"),
      sha256,
    );
  }

  const download = await getSenderEnvelopeDownload(
    envelope.userId,
    envelope.envelopeId,
    "evidence",
    { database },
  );

  assert.equal(download.key, internalKey);
  assert.equal(
    (await verifyAuditChain(envelope.envelopeId, database)).ok,
    true,
  );
}

async function assertRefused(
  rival: Promise<unknown> | undefined,
  errorClass: typeof EnvelopeMutationError | typeof SigningMutationError,
) {
  assert.ok(rival, "the winner's status was never written");
  await assert.rejects(
    rival,
    (error: unknown) => error instanceof errorClass && error.statusCode === 409,
  );
}

test("of two voids at once, the second leaves the first one's certificates alone", async () => {
  const envelope = await createSignableEnvelope();
  const { pool, started } = withRivalAfter("voided", () =>
    voidEnvelope(envelope),
  );

  await voidEnvelope(envelope, pool);

  await assertRefused(started.rival, EnvelopeMutationError);
  await assertCertificatesKept(envelope, "voided");
});

test("a decline that loses to a void leaves the void's certificates alone", async () => {
  const envelope = await createSignableEnvelope();
  const { pool, started } = withRivalAfter("voided", () =>
    declineEnvelope(envelope),
  );

  await voidEnvelope(envelope, pool);

  await assertRefused(started.rival, SigningMutationError);
  await assertCertificatesKept(envelope, "voided");
});

test("a void that loses to a decline leaves the decline's certificates alone", async () => {
  const envelope = await createSignableEnvelope();
  const { pool, started } = withRivalAfter("declined", () =>
    voidEnvelope(envelope),
  );

  await declineEnvelope(envelope, pool);

  await assertRefused(started.rival, EnvelopeMutationError);
  await assertCertificatesKept(envelope, "declined");
});

test("a void that loses to the last signature leaves the finished certificates alone", async () => {
  const envelope = await createSignableEnvelope();
  const { pool, started } = withRivalAfter("signed", () =>
    voidEnvelope(envelope),
  );

  await signEnvelope(envelope, pool);

  await assertRefused(started.rival, EnvelopeMutationError);
  await assertCertificatesKept(envelope, "completed");
});
