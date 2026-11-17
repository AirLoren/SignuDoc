import { apiError } from "@/lib/api/http";
import {
  apiSendOptionsSchema,
  describeZodError,
  getApiEnvelope,
  sendEnvelopeForApi,
} from "@/lib/api/envelopes";
import { applyAccountLimit, handleApi, runIdempotently } from "@/lib/api/route";

type Context = { params: Promise<{ id: string }> };

// Sends a draft to its first signer.
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;

  return handleApi(
    request,
    "write",
    "api_envelope_send_failure",
    async (api) => {
      const limited = await applyAccountLimit(api, {
        key: "api-envelope-send",
        limit: 100,
        windowMs: 60 * 60 * 1000,
      });

      if (limited) {
        return limited;
      }

      const text = await request.text();
      let body: unknown;

      try {
        body = text.trim() ? (JSON.parse(text) as unknown) : {};
      } catch {
        return apiError(400, "invalid_request", "The body is not valid JSON.");
      }

      const options = apiSendOptionsSchema.safeParse(body);

      if (!options.success) {
        return apiError(
          400,
          "invalid_request",
          describeZodError(options.error),
        );
      }

      return runIdempotently(
        api,
        `POST /api/v1/envelopes/${id}/send`,
        text,
        async () => {
          await sendEnvelopeForApi(api.actor, id, options.data);

          const envelope = await getApiEnvelope(api.actor.userId, id);

          return envelope
            ? { body: envelope, status: 200 }
            : {
                body: {
                  error: { code: "not_found", message: "Envelope not found." },
                },
                status: 404,
              };
        },
      );
    },
  );
}
