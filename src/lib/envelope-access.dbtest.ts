import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import { resolveEnvelopeViewerAccess } from "./envelope-access.ts";
import { listAllEnvelopesForAdmin, listEnvelopesForUser } from "./envelopes.ts";

// Who can see an envelope: its sender, and any administrator. Run with
// `npm run test:db`.

let database: pg.Pool;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
});

async function createUser(role: "admin" | "user", name: string) {
  const id = randomUUID();
  const email = `${id}@example.test`;

  createdUsers.push(id);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, $2, $3, $4)`,
    [id, name, email, role],
  );

  return { email, name, userId: id };
}

async function createEnvelope(userId: string, title: string) {
  const envelopeId = randomUUID();

  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash
      ) values ($1, $2, $3, 'draft', $4, 'doc.pdf', 4, 1, $5)
    `,
    [
      envelopeId,
      userId,
      title,
      `users/${userId}/envelopes/${envelopeId}/source.pdf`,
      "a".repeat(64),
    ],
  );

  return envelopeId;
}

test("the sender sees their own envelope", async () => {
  const sender = await createUser("user", "Sam Sender");
  const envelopeId = await createEnvelope(sender.userId, "Lease");

  assert.deepEqual(
    await resolveEnvelopeViewerAccess(sender.userId, envelopeId, database),
    {
      ownerEmail: sender.email,
      ownerName: "Sam Sender",
      ownerUserId: sender.userId,
      viewerIsOwner: true,
    },
  );
});

test("an administrator sees another member's envelope, and whose it is", async () => {
  const sender = await createUser("user", "Sam Sender");
  const admin = await createUser("admin", "Avery Admin");
  const envelopeId = await createEnvelope(sender.userId, "Lease");

  assert.deepEqual(
    await resolveEnvelopeViewerAccess(admin.userId, envelopeId, database),
    {
      ownerEmail: sender.email,
      ownerName: "Sam Sender",
      ownerUserId: sender.userId,
      viewerIsOwner: false,
    },
  );
});

test("another member who is not an administrator does not see it", async () => {
  const sender = await createUser("admin", "Sam Sender");
  const other = await createUser("user", "Olive Other");
  const envelopeId = await createEnvelope(sender.userId, "Lease");

  assert.equal(
    await resolveEnvelopeViewerAccess(other.userId, envelopeId, database),
    null,
  );
  assert.equal(
    await resolveEnvelopeViewerAccess(other.userId, randomUUID(), database),
    null,
  );
});

test("an administrator's list of every envelope names each sender", async () => {
  const first = await createUser("user", "Sam Sender");
  const second = await createUser("admin", "");
  const firstEnvelope = await createEnvelope(first.userId, "First lease");
  const secondEnvelope = await createEnvelope(second.userId, "Second lease");

  const all = await listAllEnvelopesForAdmin({ limit: 100 }, database);
  const byId = new Map(all.map((envelope) => [envelope.id, envelope]));

  assert.equal(
    byId.get(firstEnvelope)?.senderLabel,
    `Sam Sender (${first.email})`,
  );
  // No name: the address alone.
  assert.equal(byId.get(secondEnvelope)?.senderLabel, second.email);

  // A sender's own list stays theirs, without the sender on each card.
  const own = await listEnvelopesForUser(first.userId, {}, database);

  assert.deepEqual(
    own.map((envelope) => envelope.id),
    [firstEnvelope],
  );
  assert.equal(own[0]?.senderLabel, undefined);
});
