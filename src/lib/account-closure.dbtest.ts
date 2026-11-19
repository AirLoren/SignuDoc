import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type pg from "pg";

import { requestAccountClosure } from "./account.ts";
import { openTestDatabase } from "./db/test-database.ts";
import { listSystemAuditEvents } from "./services/system-audit.ts";

// Asking for an account to be closed, against a real Postgres: the request
// goes in the install's audit trail with where it came from. Run with
// `npm run test:db`.

let database: pg.Pool;
let outboxDir: string;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  outboxDir = await mkdtemp(path.join(tmpdir(), "signudoc-closure-"));
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
  await rm(outboxDir, { force: true, recursive: true });
});

test("a closure request records where it was made from", async () => {
  const userId = randomUUID();

  createdUsers.push(userId);
  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, 'Closing Person', $2, 'user', true)
    `,
    [userId, `${userId}@example.test`],
  );

  await requestAccountClosure(
    userId,
    { confirmation: "close my account" },
    {
      client: { ipAddress: "192.0.2.80", userAgent: "closure dbtest" },
      database,
      env: {
        EMAIL_CAPTURE_DIR: outboxDir,
        EMAIL_DRIVER: "capture",
        SUPPORT_EMAIL: "support@example.test",
      },
    },
  );

  const recorded = (
    await listSystemAuditEvents({ limit: 1000 }, database)
  ).filter(
    (event) =>
      event.event === "account_closure_requested" &&
      event.targetUserId === userId,
  );

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.actorUserId, userId);
  assert.equal(recorded[0]?.ipAddress, "192.0.2.80");
  assert.equal(recorded[0]?.userAgent, "closure dbtest");
});
