import type { SupabaseClient } from '@supabase/supabase-js';

import { hashSecret, safeEqual } from '@/lib/oauth/core';
import { presentedClient } from '@/lib/oauth/http';
import { getClient, type OAuthClientRow } from '@/lib/oauth/store';

/**
 * Authenticate the app on the token and revoke endpoints. A public app
 * (no secret) only names itself; it is protected by PKCE instead. An
 * app that was given a secret must present it.
 */
export async function authenticateClient(
  db: SupabaseClient,
  request: Request,
  params: Record<string, string>
): Promise<OAuthClientRow | null> {
  const { clientId, clientSecret } = presentedClient(request, params);
  if (!clientId) return null;
  const client = await getClient(db, clientId);
  if (!client) return null;
  if (client.client_secret_hash) {
    if (!clientSecret || !safeEqual(hashSecret(clientSecret), client.client_secret_hash)) return null;
  }
  return client;
}
