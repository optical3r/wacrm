// ============================================================
// OAuth store: every read and write of the oauth_* tables
// (migration 064). Service role only: the tables have RLS on and no
// policies, so the browser never sees them.
//
// Each function takes the client as its first argument, so tests can
// hand in a fake.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  ACCESS_TTL_SECONDS,
  CODE_TTL_SECONDS,
  OAUTH_PREFIX,
  REFRESH_TTL_SECONDS,
  hashSecret,
  newSecret,
} from '@/lib/oauth/core';

export interface OAuthClientRow {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string | null;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none' | 'client_secret_post' | 'client_secret_basic';
  source: 'dcr' | 'cimd';
  created_at?: string;
}

export interface OAuthCodeRow {
  code_hash: string;
  client_id: string;
  account_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string | null;
  allow_writes: boolean;
  expires_at: string;
  used_at: string | null;
}

export interface OAuthGrantRow {
  id: string;
  client_id: string;
  account_id: string;
  user_id: string;
  allow_writes: boolean;
  resource: string | null;
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  revoked_at: string | null;
}

const GRANT_COLUMNS =
  'id, client_id, account_id, user_id, allow_writes, resource, access_expires_at, refresh_expires_at, revoked_at';

function inSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function isPast(iso: string | null | undefined): boolean {
  return !!iso && new Date(iso).getTime() <= Date.now();
}

// ---------- clients -----------------------------------------------------

export async function getClient(db: SupabaseClient, clientId: string): Promise<OAuthClientRow | null> {
  const { data, error } = await db
    .from('oauth_clients')
    .select('client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, source, created_at')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) {
    console.error('[oauth] client lookup failed:', error.message);
    return null;
  }
  return (data as OAuthClientRow | null) ?? null;
}

/** Dynamic client registration. Returns the plaintext secret once. */
export async function registerClient(
  db: SupabaseClient,
  input: {
    clientName: string | null;
    redirectUris: string[];
    authMethod: OAuthClientRow['token_endpoint_auth_method'];
  }
): Promise<{ client: OAuthClientRow; clientSecret: string | null } | null> {
  const clientId = newSecret(OAUTH_PREFIX.client);
  const clientSecret = input.authMethod === 'none' ? null : newSecret(OAUTH_PREFIX.clientSecret);
  const row: OAuthClientRow = {
    client_id: clientId,
    client_secret_hash: clientSecret ? hashSecret(clientSecret) : null,
    client_name: input.clientName,
    redirect_uris: input.redirectUris,
    token_endpoint_auth_method: input.authMethod,
    source: 'dcr',
  };
  const { error } = await db.from('oauth_clients').insert(row);
  if (error) {
    console.error('[oauth] client registration failed:', error.message);
    return null;
  }
  return { client: row, clientSecret };
}

/** Save (or refresh) a client read from its metadata document. */
export async function upsertMetadataClient(
  db: SupabaseClient,
  input: { clientId: string; clientName: string | null; redirectUris: string[] }
): Promise<OAuthClientRow | null> {
  const row: OAuthClientRow = {
    client_id: input.clientId,
    client_secret_hash: null,
    client_name: input.clientName,
    redirect_uris: input.redirectUris,
    token_endpoint_auth_method: 'none',
    source: 'cimd',
  };
  const { error } = await db.from('oauth_clients').upsert(row, { onConflict: 'client_id' });
  if (error) {
    console.error('[oauth] metadata client save failed:', error.message);
    return null;
  }
  return row;
}

// ---------- codes -------------------------------------------------------

export async function createCode(
  db: SupabaseClient,
  input: {
    clientId: string;
    accountId: string;
    userId: string;
    redirectUri: string;
    codeChallenge: string;
    resource: string | null;
    allowWrites: boolean;
  }
): Promise<string | null> {
  const code = newSecret(OAUTH_PREFIX.code);
  const { error } = await db.from('oauth_codes').insert({
    code_hash: hashSecret(code),
    client_id: input.clientId,
    account_id: input.accountId,
    user_id: input.userId,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    resource: input.resource,
    allow_writes: input.allowWrites,
    expires_at: inSeconds(CODE_TTL_SECONDS),
  });
  if (error) {
    console.error('[oauth] code insert failed:', error.message);
    return null;
  }
  return code;
}

/**
 * Mark a code used, atomically: of two concurrent exchanges only one
 * gets the row. `reused` is true when the code exists but was already
 * spent, so the caller can revoke what it produced.
 */
export async function consumeCode(
  db: SupabaseClient,
  codeHash: string
): Promise<{ row: OAuthCodeRow | null; reused: boolean }> {
  const { data, error } = await db
    .from('oauth_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('code_hash', codeHash)
    .is('used_at', null)
    .select('code_hash, client_id, account_id, user_id, redirect_uri, code_challenge, resource, allow_writes, expires_at, used_at')
    .maybeSingle();
  if (error) {
    console.error('[oauth] code consume failed:', error.message);
    return { row: null, reused: false };
  }
  if (data) return { row: data as OAuthCodeRow, reused: false };
  const { data: spent } = await db.from('oauth_codes').select('code_hash').eq('code_hash', codeHash).maybeSingle();
  return { row: null, reused: !!spent };
}

// ---------- grants and tokens ---------------------------------------------

export interface IssuedTokens {
  grantId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  allowWrites: boolean;
}

function freshTokens() {
  const accessToken = newSecret(OAUTH_PREFIX.access);
  const refreshToken = newSecret(OAUTH_PREFIX.refresh);
  return {
    accessToken,
    refreshToken,
    columns: {
      access_hash: hashSecret(accessToken),
      access_expires_at: inSeconds(ACCESS_TTL_SECONDS),
      refresh_hash: hashSecret(refreshToken),
      refresh_expires_at: inSeconds(REFRESH_TTL_SECONDS),
    },
  };
}

export async function createGrant(db: SupabaseClient, code: OAuthCodeRow): Promise<IssuedTokens | null> {
  const t = freshTokens();
  const { data, error } = await db
    .from('oauth_grants')
    .insert({
      client_id: code.client_id,
      account_id: code.account_id,
      user_id: code.user_id,
      allow_writes: code.allow_writes,
      resource: code.resource,
      origin_code_hash: code.code_hash,
      ...t.columns,
    })
    .select('id')
    .single();
  if (error || !data) {
    console.error('[oauth] grant insert failed:', error?.message);
    return null;
  }
  // Connecting the same app again (same person, same workspace)
  // replaces the old connection instead of leaving it alive beside it.
  await db
    .from('oauth_grants')
    .update({ revoked_at: new Date().toISOString(), access_hash: null, refresh_hash: null })
    .eq('client_id', code.client_id)
    .eq('account_id', code.account_id)
    .eq('user_id', code.user_id)
    .neq('id', data.id)
    .is('revoked_at', null);

  return {
    grantId: data.id as string,
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    expiresIn: ACCESS_TTL_SECONDS,
    allowWrites: code.allow_writes,
  };
}

export async function revokeGrantsFromCode(db: SupabaseClient, codeHash: string): Promise<void> {
  await db
    .from('oauth_grants')
    .update({ revoked_at: new Date().toISOString() })
    .eq('origin_code_hash', codeHash)
    .is('revoked_at', null);
}

export type RefreshOutcome =
  | { ok: true; tokens: IssuedTokens; grant: OAuthGrantRow }
  | { ok: false; reason: 'unknown' | 'reused' | 'expired' | 'revoked' | 'wrong_client' };

/**
 * Swap a refresh token for a new pair. The old refresh token stops
 * working at once. Presenting a refresh token that was already swapped
 * means someone copied it: the whole grant is revoked.
 */
export async function rotateRefreshToken(
  db: SupabaseClient,
  refreshToken: string,
  clientId: string
): Promise<RefreshOutcome> {
  const hash = hashSecret(refreshToken);
  const { data: grant } = await db.from('oauth_grants').select(GRANT_COLUMNS).eq('refresh_hash', hash).maybeSingle();

  if (!grant) {
    const { data: replayed } = await db
      .from('oauth_grants')
      .select('id')
      .eq('previous_refresh_hash', hash)
      .is('revoked_at', null)
      .maybeSingle();
    if (replayed) {
      await revokeGrant(db, replayed.id as string);
      return { ok: false, reason: 'reused' };
    }
    return { ok: false, reason: 'unknown' };
  }

  const g = grant as OAuthGrantRow;
  if (g.revoked_at) return { ok: false, reason: 'revoked' };
  if (g.client_id !== clientId) return { ok: false, reason: 'wrong_client' };
  if (isPast(g.refresh_expires_at)) return { ok: false, reason: 'expired' };

  const t = freshTokens();
  const { data: updated, error } = await db
    .from('oauth_grants')
    .update({ ...t.columns, previous_refresh_hash: hash })
    .eq('id', g.id)
    // Compare-and-swap: a concurrent refresh that won leaves no row here.
    .eq('refresh_hash', hash)
    .select('id')
    .maybeSingle();
  if (error || !updated) return { ok: false, reason: 'unknown' };

  return {
    ok: true,
    grant: g,
    tokens: {
      grantId: g.id,
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      expiresIn: ACCESS_TTL_SECONDS,
      allowWrites: g.allow_writes,
    },
  };
}

/** The live grant behind an access token, or null. */
export async function findGrantByAccessToken(
  db: SupabaseClient,
  accessToken: string
): Promise<OAuthGrantRow | null> {
  const { data, error } = await db
    .from('oauth_grants')
    .select(GRANT_COLUMNS)
    .eq('access_hash', hashSecret(accessToken))
    .maybeSingle();
  if (error) {
    console.error('[oauth] token lookup failed:', error.message);
    return null;
  }
  const g = data as OAuthGrantRow | null;
  if (!g || g.revoked_at || isPast(g.access_expires_at)) return null;
  return g;
}

/** The grant behind an access or refresh token, live or not. */
export async function findGrantByAnyToken(db: SupabaseClient, token: string): Promise<OAuthGrantRow | null> {
  const hash = hashSecret(token);
  const column = token.startsWith(OAUTH_PREFIX.refresh) ? 'refresh_hash' : 'access_hash';
  const { data } = await db.from('oauth_grants').select(GRANT_COLUMNS).eq(column, hash).maybeSingle();
  return (data as OAuthGrantRow | null) ?? null;
}

export async function revokeGrant(db: SupabaseClient, grantId: string): Promise<void> {
  const { error } = await db
    .from('oauth_grants')
    .update({ revoked_at: new Date().toISOString(), access_hash: null, refresh_hash: null })
    .eq('id', grantId)
    .is('revoked_at', null);
  if (error) console.error('[oauth] revoke failed:', error.message);
}

export function touchGrant(db: SupabaseClient, grantId: string): void {
  void db
    .from('oauth_grants')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', grantId)
    .then(({ error }) => {
      if (error) console.warn('[oauth] last_used_at bump failed:', error.message);
    });
}

/** Whether the person may still connect apps to this workspace. */
export async function isWorkspaceAdmin(db: SupabaseClient, accountId: string, userId: string): Promise<boolean> {
  const { data, error } = await db
    .from('account_memberships')
    .select('role')
    .eq('account_id', accountId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return false;
  return data.role === 'owner' || data.role === 'admin';
}
