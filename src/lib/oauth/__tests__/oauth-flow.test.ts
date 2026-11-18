// End-to-end OAuth flow against the in-memory database: register,
// consent, code exchange, MCP auth, refresh rotation, reuse detection,
// revocation and workspace isolation.

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeSupabase } from '@/lib/api/core/__tests__/fake-supabase';

const ORIGIN = 'https://crm.example.com';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AGENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fake: any;
let sessionUser: { id: string } | null = null;

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => fake }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: sessionUser } }) } }),
}));
vi.mock('@/lib/webhooks/ssrf', () => ({ isDeliverableUrl: async () => true }));

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-for-oauth';

const { POST: register } = await import('@/app/api/oauth/register/route');
const { POST: token } = await import('@/app/api/oauth/token/route');
const { POST: revoke } = await import('@/app/api/oauth/revoke/route');
const { POST: authorize } = await import('@/app/api/oauth/authorize/route');
const { signConsentTicket, validateAuthorizeRequest } = await import('@/lib/oauth/authorize');
const { authenticateApi } = await import('@/lib/auth/api-context');
const { ApiError } = await import('@/lib/api/v1/respond');

const VERIFIER = 'v'.repeat(30) + 'erifier-0123456789-abcdef';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

function seed() {
  fake = createFakeSupabase({
    accounts: [
      { id: A, name: 'Ótica A', plan: 'pro', status: 'active', api_enabled: true },
      { id: B, name: 'Loja B', plan: 'starter', status: 'active', api_enabled: true },
    ],
    account_memberships: [
      { account_id: A, user_id: OWNER, role: 'owner' },
      { account_id: B, user_id: OWNER, role: 'admin' },
      { account_id: A, user_id: AGENT, role: 'agent' },
    ],
    contacts: [
      { id: 'c-a', account_id: A, name: 'Cliente A' },
      { id: 'c-b', account_id: B, name: 'Cliente B' },
    ],
    oauth_clients: [],
    oauth_codes: [],
    oauth_grants: [],
    api_request_log: [],
  });
}

function form(body: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body).toString(),
  });
}

async function registerClient(extra: Record<string, unknown> = {}) {
  const res = await register(
    new Request(`${ORIGIN}/api/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], ...extra }),
    })
  );
  return { res, body: (await res.json()) as Record<string, string> };
}

const authParams = (clientId: string, extra: Record<string, string> = {}) => ({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: REDIRECT,
  code_challenge: CHALLENGE,
  code_challenge_method: 'S256',
  state: 'st-123',
  resource: `${ORIGIN}/api/mcp`,
  ...extra,
});

/** Consent as `user` on `account`; returns the code from the redirect. */
async function consent(clientId: string, account: string, access: 'read' | 'write', user = OWNER) {
  const v = await validateAuthorizeRequest(fake, authParams(clientId), ORIGIN);
  if (!v.ok) throw new Error('validation failed');
  sessionUser = { id: user };
  const fd = new FormData();
  fd.set('ticket', signConsentTicket(user, v.request));
  fd.set('account_id', account);
  fd.set('access', access);
  fd.set('decision', 'allow');
  const res = await authorize(
    new Request(`${ORIGIN}/api/oauth/authorize`, { method: 'POST', headers: { origin: ORIGIN }, body: fd })
  );
  return res;
}

async function codeFor(clientId: string, account = A, access: 'read' | 'write' = 'read') {
  const res = await consent(clientId, account, access);
  expect(res.status).toBe(303);
  const loc = new URL(res.headers.get('location')!);
  expect(loc.searchParams.get('state')).toBe('st-123');
  expect(loc.searchParams.get('iss')).toBe(ORIGIN);
  return loc.searchParams.get('code')!;
}

async function exchange(clientId: string, code: string, verifier = VERIFIER) {
  const res = await token(
    form({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId })
  );
  return { res, body: (await res.json()) as Record<string, string | number> };
}

const mcpReq = (access: string) =>
  new Request(`${ORIGIN}/api/mcp`, { method: 'POST', headers: { authorization: `Bearer ${access}` } });

beforeEach(() => {
  seed();
  sessionUser = null;
});

describe('registration', () => {
  it('registers a public client', async () => {
    const { res, body } = await registerClient();
    expect(res.status).toBe(201);
    expect(body.client_id).toMatch(/^lcc_/);
    expect(body.client_secret).toBeUndefined();
    expect(fake.tables.oauth_clients[0].client_secret_hash).toBeNull();
  });

  it('refuses a non-https redirect', async () => {
    const { res } = await registerClient({ redirect_uris: ['http://evil.example/cb'] });
    expect(res.status).toBe(400);
  });

  it('issues a secret only as a hash', async () => {
    const { body } = await registerClient({ token_endpoint_auth_method: 'client_secret_post' });
    expect(body.client_secret).toMatch(/^lccs_/);
    expect(JSON.stringify(fake.tables.oauth_clients)).not.toContain(body.client_secret);
  });
});

describe('authorization request', () => {
  it('shows an error (no redirect) for an unknown app or a foreign redirect', async () => {
    const unknown = await validateAuthorizeRequest(fake, authParams('lcc_nope'), ORIGIN);
    expect(unknown).toMatchObject({ ok: false, kind: 'fatal' });
    const { body } = await registerClient();
    const foreign = await validateAuthorizeRequest(
      fake,
      authParams(body.client_id, { redirect_uri: 'https://evil.example/cb' }),
      ORIGIN
    );
    expect(foreign).toMatchObject({ ok: false, kind: 'fatal' });
  });

  it('sends PKCE and resource errors back to the app', async () => {
    const { body } = await registerClient();
    const noPkce = await validateAuthorizeRequest(fake, authParams(body.client_id, { code_challenge_method: 'plain' }), ORIGIN);
    expect(noPkce).toMatchObject({ ok: false, kind: 'redirect', error: 'invalid_request' });
    const otherResource = await validateAuthorizeRequest(
      fake,
      authParams(body.client_id, { resource: 'https://other.example/api/mcp' }),
      ORIGIN
    );
    expect(otherResource).toMatchObject({ ok: false, kind: 'redirect', error: 'invalid_target' });
  });

  it('reads a client metadata document', async () => {
    const clientId = 'https://claude.ai/oauth/claude-code-client-metadata';
    const fetcher = (async () =>
      new Response(JSON.stringify({ client_id: clientId, client_name: 'Claude Code', redirect_uris: ['http://localhost:1/callback'] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const v = await validateAuthorizeRequest(
      fake,
      authParams(clientId, { redirect_uri: 'http://localhost:4567/callback' }),
      ORIGIN,
      fetcher
    );
    expect(v.ok).toBe(true);
    expect(fake.tables.oauth_clients[0]).toMatchObject({ client_id: clientId, source: 'cimd' });
  });

  it('refuses a metadata document that names another client', async () => {
    const clientId = 'https://claude.ai/oauth/meta';
    const fetcher = (async () =>
      new Response(JSON.stringify({ client_id: 'https://evil.example/meta', redirect_uris: [REDIRECT] }))) as unknown as typeof fetch;
    const v = await validateAuthorizeRequest(fake, authParams(clientId), ORIGIN, fetcher);
    expect(v).toMatchObject({ ok: false, kind: 'fatal' });
  });

  it('refuses a ticket signed for someone else, and an agent', async () => {
    const { body } = await registerClient();
    const v = await validateAuthorizeRequest(fake, authParams(body.client_id), ORIGIN);
    if (!v.ok) throw new Error();
    sessionUser = { id: AGENT };
    const fd = new FormData();
    fd.set('ticket', signConsentTicket(OWNER, v.request));
    fd.set('account_id', A);
    fd.set('decision', 'allow');
    const res = await authorize(new Request(`${ORIGIN}/api/oauth/authorize`, { method: 'POST', body: fd }));
    expect(res.status).toBe(400);

    const asAgent = await consent(body.client_id, A, 'read', AGENT);
    expect(asAgent.status).toBe(403);
    expect(fake.tables.oauth_codes).toHaveLength(0);
  });

  it('refuses a post from another origin', async () => {
    const { body } = await registerClient();
    const v = await validateAuthorizeRequest(fake, authParams(body.client_id), ORIGIN);
    if (!v.ok) throw new Error();
    sessionUser = { id: OWNER };
    const fd = new FormData();
    fd.set('ticket', signConsentTicket(OWNER, v.request));
    fd.set('account_id', A);
    fd.set('decision', 'allow');
    const res = await authorize(
      new Request(`${ORIGIN}/api/oauth/authorize`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: fd })
    );
    expect(res.status).toBe(403);
  });

  it('sends access_denied back when the person cancels', async () => {
    const { body } = await registerClient();
    const v = await validateAuthorizeRequest(fake, authParams(body.client_id), ORIGIN);
    if (!v.ok) throw new Error();
    sessionUser = { id: OWNER };
    const fd = new FormData();
    fd.set('ticket', signConsentTicket(OWNER, v.request));
    fd.set('decision', 'deny');
    const res = await authorize(new Request(`${ORIGIN}/api/oauth/authorize`, { method: 'POST', body: fd }));
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });
});

describe('tokens', () => {
  it('exchanges a code once, with PKCE, and the token works only on the MCP', async () => {
    const { body: client } = await registerClient();
    const code = await codeFor(client.client_id);

    const bad = await exchange(client.client_id, code, 'x'.repeat(50));
    expect(bad.res.status).toBe(400);

    // The failed try spent the code: a fresh one is needed.
    const code2 = await codeFor(client.client_id);
    const { res, body } = await exchange(client.client_id, code2);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'labcrm:read' });
    expect(String(body.access_token)).toMatch(/^lcoa_/);
    expect(JSON.stringify(fake.tables.oauth_grants)).not.toContain(String(body.access_token));

    const ctx = await authenticateApi(mcpReq(String(body.access_token)), { allowOAuth: true });
    expect(ctx).toMatchObject({ authType: 'oauth', accountId: A, createdBy: OWNER, mcp: { enabled: true, allowWrites: false } });
    expect(ctx.scopes.every((s) => s.endsWith(':read'))).toBe(true);

    await expect(authenticateApi(mcpReq(String(body.access_token)))).rejects.toBeInstanceOf(ApiError);
  });

  it('a code used twice revokes what it produced', async () => {
    const { body: client } = await registerClient();
    const code = await codeFor(client.client_id);
    const first = await exchange(client.client_id, code);
    expect(first.res.status).toBe(200);
    const second = await exchange(client.client_id, code);
    expect(second.res.status).toBe(400);
    await expect(
      authenticateApi(mcpReq(String(first.body.access_token)), { allowOAuth: true })
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses a code from another client or another redirect', async () => {
    const { body: c1 } = await registerClient();
    const { body: c2 } = await registerClient();
    const code = await codeFor(c1.client_id);
    expect((await exchange(c2.client_id, code)).res.status).toBe(400);

    const code2 = await codeFor(c1.client_id);
    const res = await token(
      form({ grant_type: 'authorization_code', code: code2, code_verifier: VERIFIER, redirect_uri: 'https://claude.ai/other', client_id: c1.client_id })
    );
    expect(res.status).toBe(400);
  });

  it('a confidential client must present its secret', async () => {
    const { body: client } = await registerClient({ token_endpoint_auth_method: 'client_secret_basic' });
    const code = await codeFor(client.client_id);
    const noSecret = await exchange(client.client_id, code);
    expect(noSecret.res.status).toBe(401);
    const code2 = await codeFor(client.client_id);
    const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
    const res = await token(
      form({ grant_type: 'authorization_code', code: code2, code_verifier: VERIFIER, redirect_uri: REDIRECT }, { authorization: `Basic ${basic}` })
    );
    expect(res.status).toBe(200);
  });

  it('rotates refresh tokens and revokes the connection on reuse', async () => {
    const { body: client } = await registerClient();
    const { body: first } = await exchange(client.client_id, await codeFor(client.client_id, A, 'write'));
    expect(first.scope).toBe('labcrm:read labcrm:write');

    const r1 = await token(form({ grant_type: 'refresh_token', refresh_token: String(first.refresh_token), client_id: client.client_id }));
    expect(r1.status).toBe(200);
    const second = (await r1.json()) as Record<string, string>;
    expect(second.refresh_token).not.toBe(first.refresh_token);

    // The old access token is gone; the new one works with writes.
    await expect(authenticateApi(mcpReq(String(first.access_token)), { allowOAuth: true })).rejects.toBeInstanceOf(ApiError);
    const ctx = await authenticateApi(mcpReq(second.access_token), { allowOAuth: true });
    expect(ctx.mcp.allowWrites).toBe(true);

    // Replaying the first refresh token kills the whole connection.
    const replay = await token(form({ grant_type: 'refresh_token', refresh_token: String(first.refresh_token), client_id: client.client_id }));
    expect(replay.status).toBe(400);
    await expect(authenticateApi(mcpReq(second.access_token), { allowOAuth: true })).rejects.toBeInstanceOf(ApiError);
    const after = await token(form({ grant_type: 'refresh_token', refresh_token: second.refresh_token, client_id: client.client_id }));
    expect(after.status).toBe(400);
  });

  it('revocation ends the connection', async () => {
    const { body: client } = await registerClient();
    const { body } = await exchange(client.client_id, await codeFor(client.client_id));
    const res = await revoke(form({ token: String(body.refresh_token), client_id: client.client_id }));
    expect(res.status).toBe(200);
    await expect(authenticateApi(mcpReq(String(body.access_token)), { allowOAuth: true })).rejects.toBeInstanceOf(ApiError);
  });

  it('losing the admin role cuts the app off', async () => {
    const { body: client } = await registerClient();
    const { body } = await exchange(client.client_id, await codeFor(client.client_id));
    fake.tables.account_memberships.find((m: { user_id: string; account_id: string }) => m.user_id === OWNER && m.account_id === A).role = 'agent';
    await expect(authenticateApi(mcpReq(String(body.access_token)), { allowOAuth: true })).rejects.toBeInstanceOf(ApiError);
  });

  it('the API switch of the workspace applies', async () => {
    const { body: client } = await registerClient();
    const { body } = await exchange(client.client_id, await codeFor(client.client_id));
    fake.tables.accounts.find((a: { id: string }) => a.id === A).api_enabled = false;
    await expect(authenticateApi(mcpReq(String(body.access_token)), { allowOAuth: true })).rejects.toBeInstanceOf(ApiError);
  });
});

describe('workspace isolation', () => {
  it('a token for workspace B never sees workspace A', async () => {
    const { body: client } = await registerClient();
    const { body } = await exchange(client.client_id, await codeFor(client.client_id, B));
    const ctx = await authenticateApi(mcpReq(String(body.access_token)), { allowOAuth: true });
    expect(ctx.accountId).toBe(B);
    expect(ctx.plan).toBe('starter');
    const { data } = await ctx.db.from('contacts').select('*');
    expect((data as Array<{ id: string }>).map((c) => c.id)).toEqual(['c-b']);
  });
});
