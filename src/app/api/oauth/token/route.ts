// ============================================================
// POST /api/oauth/token — exchange a code, or refresh.
//
//   grant_type=authorization_code  code + code_verifier (PKCE S256) +
//                                  redirect_uri + client_id
//   grant_type=refresh_token       refresh_token + client_id
//
// Access tokens last 1 hour; refresh tokens 60 days and are replaced
// on every use. A refresh token used twice revokes the connection; so
// does a code used twice.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { authenticateClient } from '@/lib/oauth/client-auth';
import { hashSecret, scopeString, verifyPkce } from '@/lib/oauth/core';
import { clientIp, oauthError, oauthJson, preflight, readParams } from '@/lib/oauth/http';
import { hitRateLimit } from '@/lib/auth/api-context';
import {
  consumeCode,
  createGrant,
  isPast,
  isWorkspaceAdmin,
  revokeGrantsFromCode,
  rotateRefreshToken,
  type IssuedTokens,
} from '@/lib/oauth/store';

export const runtime = 'nodejs';

function tokenResponse(t: IssuedTokens): Response {
  return oauthJson({
    access_token: t.accessToken,
    token_type: 'Bearer',
    expires_in: t.expiresIn,
    refresh_token: t.refreshToken,
    scope: scopeString(t.allowWrites),
  });
}

const TOKEN_CALLS_PER_MINUTE = 60;

export async function POST(request: Request) {
  const limit = await hitRateLimit(`oauth-token:${clientIp(request)}`, TOKEN_CALLS_PER_MINUTE);
  if (!limit.success) return oauthError('too_many_requests', 'Too many requests, try again later', 429);

  const params = await readParams(request);
  const db = supabaseAdmin();

  const client = await authenticateClient(db, request, params);
  if (!client) return oauthError('invalid_client', 'Unknown client or wrong credentials', 401);

  if (params.grant_type === 'authorization_code') {
    const code = params.code;
    if (!code) return oauthError('invalid_request', 'code is required');
    const codeHash = hashSecret(code);
    const { row, reused } = await consumeCode(db, codeHash);
    if (!row) {
      if (reused) await revokeGrantsFromCode(db, codeHash);
      return oauthError('invalid_grant', 'The code is invalid, expired or already used');
    }
    if (row.client_id !== client.client_id) return oauthError('invalid_grant', 'The code was issued to another client');
    if (isPast(row.expires_at)) return oauthError('invalid_grant', 'The code expired');
    if (params.redirect_uri !== row.redirect_uri) return oauthError('invalid_grant', 'redirect_uri does not match');
    if (!verifyPkce(params.code_verifier, row.code_challenge)) {
      return oauthError('invalid_grant', 'PKCE verification failed');
    }
    // The person may have lost admin rights in the last minutes.
    if (!(await isWorkspaceAdmin(db, row.account_id, row.user_id))) {
      return oauthError('invalid_grant', 'The user can no longer connect apps to this workspace');
    }
    const tokens = await createGrant(db, row);
    if (!tokens) return oauthError('server_error', 'Could not issue tokens', 500);
    return tokenResponse(tokens);
  }

  if (params.grant_type === 'refresh_token') {
    if (!params.refresh_token) return oauthError('invalid_request', 'refresh_token is required');
    const outcome = await rotateRefreshToken(db, params.refresh_token, client.client_id);
    if (!outcome.ok) return oauthError('invalid_grant', 'The refresh token is invalid, expired or revoked');
    return tokenResponse(outcome.tokens);
  }

  return oauthError('unsupported_grant_type', 'Supported: authorization_code, refresh_token');
}

export const OPTIONS = preflight;
