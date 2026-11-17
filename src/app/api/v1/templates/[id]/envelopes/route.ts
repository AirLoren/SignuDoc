import { z } from "zod";

import { apiError } from "@/lib/api/http";
import {
  apiSendOptionsSchema,
  describeZodError,
  getApiEnvelope,
  markEnvelopeAsApiMade,
  MAX_API_METADATA_BYTES,
  sendEnvelopeForApi,
} from "@/lib/api/envelopes";
import { applyAccountLimit, handleApi, runIdempotently } from "@/lib/api/route";
import { deleteDraftEnvelope } from "@/lib/envelopes";
import { createDraftFromTemplate } from "@/lib/templates";

type Context = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  metadata: z
    .record(z.string(), z.unknown())
    .refine(
      (value) =>
        Buffer.byteLength(JSON.stringify(value), "utf8") <=
        MAX_API_METADATA_BYTES,
      { message: "Metadata must be at most 2048 bytes of JSON." },
    )
    .optional(),
  send: apiSendOptionsSchema.optional(),
  signers: z.array(z.object({ email: z.string(), name: z.string() })).min(1),
  title: z.string(),
});

// Starts an envelope from a saved template: one signer per role, in the
// template's order. Sends it too when asked.
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;

  return handleApi(
    request,
    "write",
    "api_template_use_failure",
    async (api) => {
      const limited = await applyAccountLimit(api, {
        key: "api-envelope-create",
        limit: 60,
        windowMs: 10 * 60 * 1000,
      });

      if (limited) {
        return limited;
      }

      const text = await request.text();
      let parsed: unknown;

      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        return apiError(400, "invalid_request", "The body is not valid JSON.");
      }

      const body = bodySchema.safeParse(parsed);

      if (!body.success) {
        return apiError(400, "invalid_request", describeZodError(body.error));
      }

      return runIdempotently(
        api,
        `POST /api/v1/templates/${id}/envelopes`,
        text,
        async () => {
          const draft = await createDraftFromTemplate(api.actor.userId, id, {
            signers: body.data.signers,
            title: body.data.title,
          });

          try {
            await markEnvelopeAsApiMade(
              draft.envelopeId,
              api.actor.apiKeyId,
              body.data.metadata ?? null,
            );

            if (body.data.send) {
              await sendEnvelopeForApi(
                api.actor,
                draft.envelopeId,
                body.data.send,
              );
            }
          } catch (error) {
            await deleteDraftEnvelope(api.actor.userId, draft.envelopeId).catch(
              () => undefined,
            );
            throw error;
          }

          return {
            body: await getApiEnvelope(api.actor.userId, draft.envelopeId),
            status: 201,
          };
        },
      );
    },
  );
}
