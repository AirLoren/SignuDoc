import { ZodError } from "zod";

import type { ApiKeyScope } from "../api-keys.ts";
import {
  requireApiKey,
  withRateLimitHeaders,
  type RateLimitState,
} from "../auth/api-key.ts";
import { DownloadAccessError } from "../downloads.ts";
import {
  EnvelopeDocumentAccessError,
  EnvelopeMutationError,
} from "../envelopes.ts";
import { ReminderMutationError } from "../reminders.ts";
import { logRouteError } from "../security/logging.ts";
import { consumeRateLimit } from "../security/rate-limit.ts";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "../security/request.ts";
import { DocumentImportError } from "../services/document-import.ts";
import { PendingUploadError } from "../services/pending-uploads.ts";
import { TemplateError } from "../templates.ts";
import { scheduleWebhookDrainIfDue } from "../webhooks/deliver.ts";
import { describeZodError, type ApiActor } from "./envelopes.ts";
import { apiError, apiJson, codeForStatus } from "./http.ts";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  hashRequest,
  readIdempotencyKey,
  releaseIdempotencyKey,
} from "./idempotency.ts";

// The frame every /api/v1 route runs in: the key is checked, errors the
// app's own functions throw become API errors, and rate limit headers go
// on whatever comes back.

export type ApiContext = {
  actor: ApiActor;
  rateLimit: RateLimitState;
  request: Request;
};

/** Turns an error from the app's functions into an API error, or null. */
export function apiErrorFor(error: unknown): Response | null {
  if (error instanceof ZodError) {
    return apiError(400, "invalid_request", describeZodError(error));
  }

  if (error instanceof DocumentImportError) {
    return error.code === "too_large"
      ? apiError(413, "payload_too_large", error.message)
      : apiError(400, "invalid_request", error.message);
  }

  if (error instanceof PendingUploadError) {
    return apiError(400, "invalid_request", error.message);
  }

  if (
    error instanceof EnvelopeMutationError ||
    error instanceof EnvelopeDocumentAccessError ||
    error instanceof DownloadAccessError ||
    error instanceof TemplateError ||
    error instanceof ReminderMutationError
  ) {
    return apiError(
      error.statusCode,
      codeForStatus(error.statusCode),
      error.message,
    );
  }

  return null;
}

export async function handleApi(
  request: Request,
  scope: ApiKeyScope,
  category: string,
  handler: (context: ApiContext) => Promise<Response>,
): Promise<Response> {
  const principal = await requireApiKey(request, scope);

  if (principal instanceof Response) {
    return principal;
  }

  const context: ApiContext = {
    actor: {
      apiKeyId: principal.apiKey.id,
      email: principal.user.email,
      ipAddress: getClientIpAddress(request.headers),
      name: principal.user.name,
      userAgent: getRequestUserAgent(request.headers),
      userId: principal.user.id,
    },
    rateLimit: principal.rateLimit,
    request,
  };

  // A request from an app is a good moment to send webhook retries that
  // are due, so they need not wait for the daily cron.
  scheduleWebhookDrainIfDue();

  try {
    return withRateLimitHeaders(await handler(context), principal.rateLimit);
  } catch (error) {
    const known = apiErrorFor(error);

    if (known) {
      return withRateLimitHeaders(known, principal.rateLimit);
    }

    logRouteError(error, {
      category,
      ipAddress: context.actor.ipAddress,
      message: "Unexpected failure in an API request.",
      metadata: { apiKeyId: principal.apiKey.id },
      path: getRequestPathname(request),
      userId: principal.user.id,
    });

    return withRateLimitHeaders(
      apiError(
        500,
        "internal_error",
        "Something went wrong on the install. Try again later.",
      ),
      principal.rateLimit,
    );
  }
}

/**
 * Runs `run` once per Idempotency-Key. Without the header it simply runs.
 * Only a response the caller can act on is kept: a 5xx lets the key go, so
 * a retry runs again.
 */
export async function runIdempotently(
  context: ApiContext,
  route: string,
  body: Uint8Array | string,
  run: () => Promise<{ body: unknown; status: number }>,
): Promise<Response> {
  const key = readIdempotencyKey(context.request.headers);

  if (key === undefined) {
    return apiError(
      400,
      "invalid_request",
      "Idempotency-Key must be 1 to 255 characters.",
    );
  }

  if (key === null) {
    const result = await runCatching(run);

    return apiJson(result.body, { status: result.status });
  }

  const claim = {
    apiKeyId: context.actor.apiKeyId,
    key,
    requestHash: hashRequest(route, body),
  };
  const previous = await claimIdempotencyKey(claim);

  switch (previous.kind) {
    case "mismatch":
      return apiError(
        422,
        "idempotency_key_reused",
        "This Idempotency-Key was used with a different request.",
      );
    case "in_progress":
      return apiError(
        409,
        "wrong_state",
        "A request with this Idempotency-Key is still being worked on. Try again shortly.",
        { "retry-after": "2" },
      );
    case "replay":
      return apiJson(previous.response, {
        headers: { "idempotent-replayed": "true" },
        status: previous.statusCode,
      });
    case "new":
      break;
  }

  let result: { body: unknown; status: number };

  try {
    result = await runCatching(run);
  } catch (error) {
    await releaseIdempotencyKey(claim).catch(() => undefined);
    throw error;
  }

  if (result.status >= 500) {
    await releaseIdempotencyKey(claim).catch(() => undefined);
  } else {
    await completeIdempotencyKey({
      apiKeyId: claim.apiKeyId,
      key,
      response: result.body,
      statusCode: result.status,
    });
  }

  return apiJson(result.body, { status: result.status });
}

/** Known errors become a kept response; anything else is thrown on. */
async function runCatching(
  run: () => Promise<{ body: unknown; status: number }>,
): Promise<{ body: unknown; status: number }> {
  try {
    return await run();
  } catch (error) {
    const known = apiErrorFor(error);

    if (!known) {
      throw error;
    }

    return { body: await known.json(), status: known.status };
  }
}

/**
 * Counts this request against a per-key limit on creating or sending. These
 * are looser than the web app's per-person limits, since an app sends in
 * bulk, but still stop a leaked key from flooding inboxes.
 */
export async function applyAccountLimit(
  context: ApiContext,
  input: { key: string; limit: number; windowMs: number },
): Promise<Response | null> {
  const decision = await consumeRateLimit({
    key: `${input.key}:${context.actor.apiKeyId}`,
    limit: input.limit,
    windowMs: input.windowMs,
  });

  return decision.allowed
    ? null
    : apiError(
        429,
        "rate_limited",
        "This key has created or sent too many envelopes for now. Wait and try again.",
        { "retry-after": String(decision.retryAfterSeconds) },
      );
}
