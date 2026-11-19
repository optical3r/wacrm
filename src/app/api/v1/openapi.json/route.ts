// GET /api/v1/openapi.json — the API reference as OpenAPI 3.1, built
// from the code (src/lib/api/openapi.ts). Public: it describes the API,
// it gives no access. /docs/api renders the same data.

import { buildOpenApi } from '@/lib/api/openapi';

export function GET(request: Request) {
  return new Response(JSON.stringify(buildOpenApi(new URL(request.url).origin), null, 2), {
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    },
  });
}
