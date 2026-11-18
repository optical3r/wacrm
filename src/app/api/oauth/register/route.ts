// ============================================================
// POST /api/oauth/register — dynamic client registration (RFC 7591).
//
// claude.ai, Claude Code and other MCP clients register themselves
// here before the first login. Registering grants nothing: a person
// still has to log in and approve the app on the consent screen.
// Limited per IP; apps that never get connected are cleaned up after
// 30 days (migration 064).
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { hitRateLimit } from '@/lib/auth/api-context';
import { MAX_REDIRECT_URIS, cleanClientName, isValidRedirectUri } from '@/lib/oauth/core';
import { clientIp, oauthError, oauthJson, preflight } from '@/lib/oauth/http';
import { registerClient, type OAuthClientRow } from '@/lib/oauth/store';

export const runtime = 'nodejs';

const AUTH_METHODS = new Set(['none', 'client_secret_post', 'client_secret_basic']);
const REGISTRATIONS_PER_HOUR = 30;

export async function POST(request: Request) {
  const limit = await hitRateLimit(`oauth-register:${clientIp(request)}`, REGISTRATIONS_PER_HOUR, 3600);
  if (!limit.success) return oauthError('too_many_requests', 'Too many registrations, try again later', 429);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return oauthError('invalid_client_metadata', 'Body must be JSON');
  }
  if (!body || typeof body !== 'object') return oauthError('invalid_client_metadata', 'Body must be a JSON object');

  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return oauthError('invalid_redirect_uri', `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs`);
  }
  if (!uris.every(isValidRedirectUri)) {
    return oauthError('invalid_redirect_uri', 'Each redirect URI must be https, or http on localhost');
  }

  const method = body.token_endpoint_auth_method ?? 'none';
  if (typeof method !== 'string' || !AUTH_METHODS.has(method)) {
    return oauthError('invalid_client_metadata', 'Unsupported token_endpoint_auth_method');
  }
  const grantTypes = body.grant_types ?? ['authorization_code', 'refresh_token'];
  if (
    !Array.isArray(grantTypes) ||
    !grantTypes.every((g) => g === 'authorization_code' || g === 'refresh_token')
  ) {
    return oauthError('invalid_client_metadata', 'Supported grant_types: authorization_code, refresh_token');
  }
  const responseTypes = body.response_types ?? ['code'];
  if (!Array.isArray(responseTypes) || !responseTypes.every((r) => r === 'code')) {
    return oauthError('invalid_client_metadata', 'Supported response_types: code');
  }

  const result = await registerClient(supabaseAdmin(), {
    clientName: cleanClientName(body.client_name),
    redirectUris: [...new Set(uris as string[])],
    authMethod: method as OAuthClientRow['token_endpoint_auth_method'],
  });
  if (!result) return oauthError('server_error', 'Could not register the client', 500);

  const { client, clientSecret } = result;
  return oauthJson(
    {
      client_id: client.client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_name: client.client_name ?? undefined,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    201
  );
}

export const OPTIONS = preflight;
