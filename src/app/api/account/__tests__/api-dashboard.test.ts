// The Configurações › API e MCP routes read service-role tables: each
// must stay inside the caller's workspace.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeSupabase } from '@/lib/api/core/__tests__/fake-supabase';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fake: any;
let role = 'admin';

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => fake }));
vi.mock('@/lib/auth/account', async () => {
  const { ForbiddenError } = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account');
  return {
    requireRole: async () => {
      if (role !== 'admin') throw new ForbiddenError('Insufficient role');
      return { accountId: A, userId: 'u-a', role, supabase: fake };
    },
    toErrorResponse: (await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account')).toErrorResponse,
  };
});

const apps = await import('@/app/api/account/oauth-apps/route');
const usage = await import('@/app/api/account/api-usage/route');
const deliveries = await import('@/app/api/account/webhooks/[id]/deliveries/route');

beforeEach(() => {
  role = 'admin';
  const future = new Date(Date.now() + 86400_000).toISOString();
  fake = createFakeSupabase({
    oauth_clients: [{ client_id: 'c1', client_name: 'Claude' }],
    oauth_grants: [
      { id: 'g-a', client_id: 'c1', account_id: A, user_id: 'u-a', allow_writes: false, refresh_expires_at: future, revoked_at: null },
      { id: 'g-b', client_id: 'c1', account_id: B, user_id: 'u-b', allow_writes: true, refresh_expires_at: future, revoked_at: null },
    ],
    profiles: [{ user_id: 'u-a', full_name: 'Pessoa A' }],
    api_keys: [
      { id: 'k-a', account_id: A, name: 'n8n' },
      { id: 'k-b', account_id: B, name: 'segredo de B' },
    ],
    api_request_log: [
      { account_id: A, key_id: 'k-a', via: 'api', method: 'GET', route: '/api/v1/contacts', status: 500, created_at: '2026-11-19T10:00:00Z' },
      { account_id: B, key_id: 'k-b', via: 'api', method: 'GET', route: '/api/v1/b', status: 500, created_at: '2026-11-19T10:00:00Z' },
    ],
    webhook_deliveries: [
      { id: 1, endpoint_id: 'w-a', account_id: A, event: 'deal.created', ok: true },
      { id: 2, endpoint_id: 'w-b', account_id: B, event: 'deal.created', ok: false },
    ],
  });
  // The summary RPC as Postgres would answer it for account A only.
  fake.rpc = async (fn: string, args: { p_account: string }) =>
    fn === 'api_usage_summary' && args.p_account === A
      ? { data: [{ key_id: 'k-a', oauth_grant_id: null, via: 'api', calls: '7', errors: '1', last_at: '2026-11-19T10:00:00Z' }], error: null }
      : { data: [], error: null };
});

describe('connected apps', () => {
  it('lists and disconnects only this workspace', async () => {
    const res = await apps.GET();
    const body = await res.json();
    expect(body.apps.map((a: { id: string }) => a.id)).toEqual(['g-a']);

    const foreign = await apps.DELETE(new Request('http://x/api/account/oauth-apps?id=g-b', { method: 'DELETE' }));
    expect(foreign.status).toBe(404);
    expect(fake.tables.oauth_grants.find((g: { id: string }) => g.id === 'g-b').revoked_at).toBeNull();

    const own = await apps.DELETE(new Request('http://x/api/account/oauth-apps?id=g-a', { method: 'DELETE' }));
    expect(own.status).toBe(200);
    expect(fake.tables.oauth_grants.find((g: { id: string }) => g.id === 'g-a').revoked_at).not.toBeNull();
  });

  it('is admin-only', async () => {
    role = 'agent';
    expect((await apps.GET()).status).toBe(403);
    expect((await usage.GET()).status).toBe(403);
  });
});

describe('usage', () => {
  it('names credentials and lists errors of this workspace only', async () => {
    const body = await (await usage.GET()).json();
    expect(body).toMatchObject({ total: 7, errors: 1 });
    expect(body.credentials).toEqual([expect.objectContaining({ name: 'n8n', calls: 7, errors: 1 })]);
    expect(body.recent_errors).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('segredo de B');
  });
});

describe('webhook deliveries', () => {
  it('never shows another workspace’s deliveries', async () => {
    const res = await deliveries.GET(new Request('http://x'), { params: Promise.resolve({ id: 'w-b' }) });
    expect((await res.json()).deliveries).toEqual([]);
    const own = await deliveries.GET(new Request('http://x'), { params: Promise.resolve({ id: 'w-a' }) });
    expect((await own.json()).deliveries).toHaveLength(1);
  });
});
