import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { createApiKey } from "./api-keys.ts";
import {
  apiCreateEnvelopeSchema,
  createEnvelopeForApi,
  type ApiActor,
} from "./api/envelopes.ts";
import { openTestDatabase } from "./db/test-database.ts";
import {
  addEmbedOrigin,
  EmbeddingError,
  issueEmbedLink,
  listEmbedOrigins,
  openEmbedLink,
  removeEmbedOrigin,
} from "./embedding.ts";
import {
  correctSentEnvelopeSigner,
  EnvelopeMutationError,
} from "./envelopes.ts";
import { ReminderMutationError, sendManualEnvelopeNudge } from "./reminders.ts";
import { hashOpaqueToken } from "./services/opaque-tokens.ts";
import { getSigningPayloadForToken, SigningAccessError } from "./signing.ts";
import { setWebhookDrainScheduler } from "./webhooks/outbox.ts";

// Embedded signing against a real Postgres and real files. Run with
// `npm run test:db`.

const SETTINGS = [
  "APP_URL",
  "DATABASE_URL",
  "EMAIL_CAPTURE_DIR",
  "EMAIL_DRIVER",
  "STORAGE_DRIVER",
  "STORAGE_LOCAL_DIR",
] as const;
const ORIGIN = "https://app.example.com";

let database: pg.Pool;
let workDir: string;
let pdf: Uint8Array;
const createdUsers: string[] = [];
const settingsBefore = new Map<string, string | undefined>();

before(async () => {
  database = await openTestDatabase();
  workDir = await mkdtemp(path.join(tmpdir(), "signudoc-embed-"));

  for (const name of SETTINGS) {
    settingsBefore.set(name, process.env[name]);
  }

  process.env.APP_URL = "http://localhost:3000";
  process.env.DATABASE_URL =
    process.env.E2E_DATABASE_URL ??
    "postgres://signudoc:signudoc@127.0.0.1:5432/signudoc_e2e";
  process.env.EMAIL_CAPTURE_DIR = path.join(workDir, "outbox");
  process.env.EMAIL_DRIVER = "capture";
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_DIR = path.join(workDir, "storage");
  setWebhookDrainScheduler(() => undefined);

  const document = await PDFDocument.create();

  document.addPage([612, 792]);
  pdf = await document.save();
});

afterEach(async () => {
  await database.query(`delete from embed_allowed_origins`);
});

after(async () => {
  setWebhookDrainScheduler(null);
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();

  for (const [name, value] of settingsBefore) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  await rm(workDir, { force: true, recursive: true });
});

async function createAdmin(): Promise<ApiActor> {
  const userId = randomUUID();
  const email = `${userId}@example.test`;

  createdUsers.push(userId);
  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, 'Ops Admin', $2, 'admin', true)
    `,
    [userId, email],
  );

  const { summary } = await createApiKey(
    { email, userId },
    { expiresInDays: null, name: "Portal", scope: "write" },
    database,
  );

  return {
    apiKeyId: summary.id,
    email,
    ipAddress: null,
    name: "Ops Admin",
    userAgent: null,
    userId,
  };
}

function request(options: { accessCode?: string; delivery?: string } = {}) {
  const tag = randomUUID().slice(0, 8);

  return apiCreateEnvelopeSchema.parse({
    fields: [
      {
        height: 0.05,
        page: 1,
        signer: "a",
        type: "signature",
        width: 0.3,
        x: 0.1,
        y: 0.7,
      },
      {
        height: 0.05,
        page: 1,
        signer: "b",
        type: "signature",
        width: 0.3,
        x: 0.5,
        y: 0.7,
      },
    ],
    send: {
      delivery: options.delivery ?? "embedded",
      permittedUseConfirmed: true,
    },
    signers: [
      {
        email: `first-${tag}@example.test`,
        name: "First Signer",
        ref: "a",
        ...(options.accessCode ? { accessCode: options.accessCode } : {}),
      },
      { email: `second-${tag}@example.test`, name: "Second Signer", ref: "b" },
    ],
    title: "Portal agreement",
  });
}

async function create(
  actor: ApiActor,
  options?: Parameters<typeof request>[0],
) {
  return createEnvelopeForApi(
    actor,
    request(options),
    { body: pdf, contentType: "application/pdf", filename: "a.pdf" },
    database,
  );
}

async function invitationsTo(email: string): Promise<number> {
  const dir = process.env.EMAIL_CAPTURE_DIR!;
  const files = await readdir(dir).catch(() => [] as string[]);
  let count = 0;

  for (const file of files) {
    const message = JSON.parse(
      await readFile(path.join(dir, file), "utf8"),
    ) as {
      template?: string;
      to?: string | string[];
    };

    if (
      message.template === "signing_invitation" &&
      [message.to].flat().includes(email)
    ) {
      count += 1;
    }
  }

  return count;
}

function tokenOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
}

test("only an administrator lists sites, and only exact https origins", async () => {
  const admin = await createAdmin();

  await assert.rejects(
    addEmbedOrigin(admin, "https://app.example.com/path", { database }),
    (error: unknown) =>
      error instanceof EmbeddingError && error.statusCode === 400,
  );
  assert.equal(
    await addEmbedOrigin(admin, "https://App.Example.com/", { database }),
    ORIGIN,
  );
  // Adding it again changes nothing.
  await addEmbedOrigin(admin, ORIGIN, { database });
  assert.deepEqual(
    (await listEmbedOrigins(database)).map((row) => row.origin),
    [ORIGIN],
  );

  await database.query(`update public."user" set role = 'user' where id = $1`, [
    admin.userId,
  ]);
  await assert.rejects(
    removeEmbedOrigin(admin, ORIGIN, database),
    (error: unknown) =>
      error instanceof EmbeddingError && error.statusCode === 403,
  );
});

test("an embedded send is refused while no site is allowed, or with signer checks", async () => {
  const admin = await createAdmin();

  await assert.rejects(
    create(admin),
    (error: unknown) =>
      error instanceof EnvelopeMutationError &&
      /Embedded signing is off/.test(error.message),
  );

  await addEmbedOrigin(admin, ORIGIN, { database });
  await assert.rejects(
    create(admin, { accessCode: "1234" }),
    (error: unknown) =>
      error instanceof EnvelopeMutationError &&
      /access codes/.test(error.message),
  );
});

test("an embedded envelope emails no invitation, and the app gets a link for the signer whose turn it is", async () => {
  const admin = await createAdmin();

  await addEmbedOrigin(admin, ORIGIN, { database });

  const envelope = await create(admin);
  const [first, second] = envelope.signers;

  assert.equal(envelope.delivery, "embedded");
  assert.equal(envelope.status, "sent");
  assert.equal(await invitationsTo(first!.email), 0);

  // Not yet the second signer's turn; an unlisted site is refused.
  await assert.rejects(
    issueEmbedLink(
      {
        envelopeId: envelope.id,
        origin: ORIGIN,
        signerId: second!.id,
        userId: admin.userId,
      },
      { database },
    ),
    (error: unknown) =>
      error instanceof EmbeddingError && error.statusCode === 409,
  );
  await assert.rejects(
    issueEmbedLink(
      {
        envelopeId: envelope.id,
        origin: "https://other.example.com",
        signerId: first!.id,
        userId: admin.userId,
      },
      { database },
    ),
    (error: unknown) =>
      error instanceof EmbeddingError && error.statusCode === 403,
  );
  // Someone else's envelope is not found.
  const stranger = await createAdmin();

  await assert.rejects(
    issueEmbedLink(
      {
        envelopeId: envelope.id,
        origin: ORIGIN,
        signerId: first!.id,
        userId: stranger.userId,
      },
      { database },
    ),
    (error: unknown) =>
      error instanceof EmbeddingError && error.statusCode === 404,
  );

  const link = await issueEmbedLink(
    {
      envelopeId: envelope.id,
      origin: ORIGIN,
      signerId: first!.id,
      userId: admin.userId,
    },
    { database },
  );
  const url = new URL(link.url);

  assert.equal(url.searchParams.get("origin"), ORIGIN);
  assert.match(url.pathname, /^\/embed\/sign\//);
  assert.ok(Date.parse(link.expiresAt) - Date.now() <= 15 * 60 * 1000 + 1000);

  const token = tokenOf(link.url);

  assert.deepEqual(
    await openEmbedLink(token, "https://other.example.com", database),
    {
      ok: false,
      reason: "wrong_origin",
    },
  );
  assert.deepEqual(await openEmbedLink(token, ORIGIN, database), { ok: true });

  // Opening it gave it a signing session, not just 15 minutes.
  const expiry = await database.query<{ expiresAt: number }>(
    `select signing_token_expires_at as "expiresAt" from signers where id = $1`,
    [first!.id],
  );

  assert.ok(expiry.rows[0]!.expiresAt - Date.now() / 1000 > 60 * 60);

  const payload = await getSigningPayloadForToken(token, { database });

  assert.equal(payload.signer.id, first!.id);

  // A new link replaces the last one.
  const replacement = await issueEmbedLink(
    {
      envelopeId: envelope.id,
      origin: ORIGIN,
      signerId: first!.id,
      userId: admin.userId,
    },
    { database },
  );

  await assert.rejects(
    getSigningPayloadForToken(token, { database }),
    (error: unknown) =>
      error instanceof SigningAccessError && error.state === "expired",
  );
  assert.ok(
    await getSigningPayloadForToken(tokenOf(replacement.url), { database }),
  );
});

test("an embedded link not opened in time stops working", async () => {
  const admin = await createAdmin();

  await addEmbedOrigin(admin, ORIGIN, { database });

  const envelope = await create(admin);
  const link = await issueEmbedLink(
    {
      envelopeId: envelope.id,
      origin: ORIGIN,
      signerId: envelope.signers[0]!.id,
      userId: admin.userId,
    },
    { database },
  );
  const token = tokenOf(link.url);

  await database.query(
    `update signers set signing_token_expires_at = $2 where signing_token_hash = $1`,
    [hashOpaqueToken(token), Math.floor(Date.now() / 1000) - 1],
  );
  // Opening it late does not bring it back.
  await openEmbedLink(token, ORIGIN, database);
  await assert.rejects(
    getSigningPayloadForToken(token, { database }),
    (error: unknown) =>
      error instanceof SigningAccessError && error.state === "expired",
  );
});

test("an emailed envelope gets no embed links, and an embedded one no reminders or corrections", async () => {
  const admin = await createAdmin();

  await addEmbedOrigin(admin, ORIGIN, { database });

  const emailed = await create(admin, { delivery: "email" });

  assert.equal(emailed.delivery, "email");
  // The capture check above would see an invitation if one went out.
  assert.equal(await invitationsTo(emailed.signers[0]!.email), 1);
  await assert.rejects(
    issueEmbedLink(
      {
        envelopeId: emailed.id,
        origin: ORIGIN,
        signerId: emailed.signers[0]!.id,
        userId: admin.userId,
      },
      { database },
    ),
    (error: unknown) =>
      error instanceof EmbeddingError && error.statusCode === 409,
  );

  const embedded = await create(admin);
  const sender = { senderEmail: admin.email, senderName: admin.name };

  await assert.rejects(
    sendManualEnvelopeNudge(admin.userId, embedded.id, sender, { database }),
    (error: unknown) =>
      error instanceof ReminderMutationError && error.statusCode === 409,
  );
  await assert.rejects(
    correctSentEnvelopeSigner(
      admin.userId,
      embedded.id,
      embedded.signers[0]!.id,
      { email: "new@example.test", name: "New Name" },
      sender,
      { database },
    ),
    (error: unknown) =>
      error instanceof EnvelopeMutationError && error.statusCode === 409,
  );
});
