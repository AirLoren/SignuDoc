import { apiJson } from "@/lib/api/http";
import { requireApiKey, withRateLimitHeaders } from "@/lib/auth/api-key";

// Which key this is and whom it acts as. The simplest way to check that a
// key works.
export async function GET(request: Request) {
  const principal = await requireApiKey(request, "read");

  if (principal instanceof Response) {
    return principal;
  }

  return withRateLimitHeaders(
    apiJson({
      key: {
        id: principal.apiKey.id,
        name: principal.apiKey.name,
        scope: principal.apiKey.scope,
      },
      user: {
        email: principal.user.email,
        id: principal.user.id,
        name: principal.user.name,
      },
    }),
    principal.rateLimit,
  );
}
