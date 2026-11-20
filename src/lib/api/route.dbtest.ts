import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { after, before, test } from "node:test";

import type pg from "pg";

import { createApiKey } from "../api-keys.ts";
import { replaceDbPoolForTests } from "../db/connection.ts";
import { openTestDatabase } from "../db/test-database.ts";
import { ReminderMutationError } from "../reminders.ts";
import { claimIdempotencyKey, hashRequest } from "./idempotency.ts";
import type * as RouteModule from "./route.ts";

// The API's shared route code against a real Postgres. Run with
// `npm run test:db`.

// The API's responses come from next/server, which Next.js resolves for
// itself. Plain Node needs the file name.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^next\/[a-z-]+$/.test(specifier)) {
      return nextResolve(`${specifier}.js`, context);
    }

    return nextResolve(specifier, context);
  },
});

let database: pg.Pool;
let replaced: pg.Pool | null = null;
let route: typeof RouteModule;
const createdUsers: string[] = [];
const createdKeys: string[] = [];

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
  route = await import("./route.ts");
});

after(async () => {
  // api_idempotency has no foreign key to the key, so its rows go first.
  await database.query(
    `delete from public.api_idempotency where api_key_id = any($1)`,
    [createdKeys],
  );
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  replaceDbPoolForTests(replaced ?? database);
  await database.end();
});

async function createContext(idempotencyKey: string) {
  const id = randomUUID();
  const email = `${id}@example.test`;

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, $2, $3, 'admin', true)
    `,
    [id, `Person ${id.slice(0, 4)}`, email],
  );

  const { summary } = await createApiKey(
    { email, userId: id },
    { expiresInDays: null, name: "Route test", scope: "write" },
    database,
  );

  createdKeys.push(summary.id);

  return {
    actor: {
      apiKeyId: summary.id,
      email,
      ipAddress: null,
      name: "Route test",
      userAgent: null,
      userId: id,
    },
    rateLimit: { limit: 120, remaining: 119, resetSeconds: 60 },
    request: new Request("http://localhost:3000/api/v1/envelopes", {
      headers: { "idempotency-key": idempotencyKey },
      method: "POST",
    }),
  };
}

test("a request whose envelope could not be noted keeps its key, so a retry cannot make a second one", async () => {
  const key = `order-${randomUUID()}`;
  const context = await createContext(key);
  const body = '{"title":"Lease"}';

  await assert.rejects(
    route.runIdempotently(
      context,
      "POST /api/v1/envelopes",
      body,
      async (remember) => {
        // Postgres refuses a NUL in text, so noting the envelope fails the
        // way it would if the database went away right after the send.
        await remember("envelope\u0000id");

        return { body: {}, status: 201 };
      },
    ),
  );

  assert.deepEqual(
    await claimIdempotencyKey(
      {
        apiKeyId: context.actor.apiKeyId,
        key,
        requestHash: hashRequest("POST /api/v1/envelopes", body),
      },
      database,
    ),
    { kind: "in_progress" },
  );
});

test("a request that fails before making anything lets its key go", async () => {
  const key = `order-${randomUUID()}`;
  const context = await createContext(key);
  const body = '{"title":"Lease"}';

  await assert.rejects(
    route.runIdempotently(context, "POST /api/v1/envelopes", body, async () => {
      throw new Error("The install had a problem.");
    }),
  );

  const claim = await claimIdempotencyKey(
    {
      apiKeyId: context.actor.apiKeyId,
      key,
      requestHash: hashRequest("POST /api/v1/envelopes", body),
    },
    database,
  );

  assert.equal(claim.kind, "new");
});

test("a reminder sent too soon says when the next one can go", async () => {
  const now = Math.floor(Date.now() / 1000);
  const response = route.apiErrorFor(
    new ReminderMutationError("You can send another reminder later.", 429, {
      nextAvailableAt: now + 3600,
      nextAvailableAtLabel: "later",
    }),
  );

  assert.equal(response?.status, 429);

  const wait = Number(response?.headers.get("retry-after"));

  assert.ok(wait > 3590 && wait <= 3600, `retry-after was ${String(wait)}`);
  assert.deepEqual(await response?.json(), {
    error: {
      code: "rate_limited",
      message: "You can send another reminder later.",
    },
  });
});

test("only refusals a retry would get again are kept for the key", () => {
  assert.equal(route.isKept(400), true);
  assert.equal(route.isKept(409), true);
  assert.equal(route.isKept(429), false);
  assert.equal(route.isKept(503), false);
});

test("the embed-link limit refuses in its own words, with Retry-After", async () => {
  const context = await createContext(`unused-${randomUUID()}`);
  const limit = {
    ...route.API_EMBED_LINK_LIMIT,
    key: `test-embed-link-${randomUUID()}`,
    limit: 1,
  };

  assert.equal(await route.applyAccountLimit(context, limit), null);

  const refused = await route.applyAccountLimit(context, limit);

  assert.equal(refused?.status, 429);
  assert.ok(Number(refused?.headers.get("retry-after")) > 0);
  assert.deepEqual(await refused?.json(), {
    error: {
      code: "rate_limited",
      message:
        "This key has asked for too many signing links for now. Wait and try again.",
    },
  });
});
