// POST /api/oauth/revoke — RFC 7009. Revoking either token of a
// connection ends the whole connection. Always 200, so the endpoint
// says nothing about which tokens exist.

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { authenticateClient } from '@/lib/oauth/client-auth';
import { oauthError, preflight, readParams, CORS_HEADERS } from '@/lib/oauth/http';
import { findGrantByAnyToken, revokeGrant } from '@/lib/oauth/store';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const params = await readParams(request);
  const db = supabaseAdmin();
  const client = await authenticateClient(db, request, params);
  if (!client) return oauthError('invalid_client', 'Unknown client or wrong credentials', 401);

  if (params.token) {
    const grant = await findGrantByAnyToken(db, params.token);
    if (grant && grant.client_id === client.client_id) await revokeGrant(db, grant.id);
  }
  return new Response(null, { status: 200, headers: { 'cache-control': 'no-store', ...CORS_HEADERS } });
}

export const OPTIONS = preflight;
