// ============================================================
// Public API authentication — resolve a request's credential into an
// account context.
//
// The machine-to-machine counterpart of `getCurrentAccount`. A caller
// presents `Authorization: Bearer <key>`; the key (looked up by its
// hash) fixes the account, and nothing in the request can change it.
//
// Every /api/v1 route is wrapped in `apiRoute(scope, handler)`:
//
//   export const GET = apiRoute('contacts:read', async (ctx, request) => {
//     const { data } = await ctx.db.from('contacts').select('*');
//     ...
//   });
//
// `ctx.db` is the account-scoped database (src/lib/api/core/db.ts):
// the only way an API route or MCP tool reaches data. The wrapper also
// enforces the account's API switch and status, the shared per-minute
// limit, and writes one api_request_log row per call.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { findActiveKeyByHash, touchLastUsed } from '@/lib/api-keys/store';
import { hashApiKey, looksLikeApiKey } from '@/lib/api-keys/keys';
import { hasScope, type ApiScope } from '@/lib/api-keys/scopes';
import {
  ApiError,
  forbidden,
  rateLimited,
  toApiErrorResponse,
  unauthorized,
} from '@/lib/api/v1/respond';
import { checkRateLimit, type RateLimitResult } from '@/lib/rate-limit';
import { createAccountDb, type AccountDb } from '@/lib/api/core/db';
import { OAUTH_PREFIX, scopesForGrant } from '@/lib/oauth/core';
import { findGrantByAccessToken, isWorkspaceAdmin, touchGrant } from '@/lib/oauth/store';

export type ApiPlan = 'starter' | 'pro';

export interface ApiContext {
  /** How the caller authenticated. OAuth arrives with the claude.ai connector. */
  authType: 'api_key' | 'oauth';
  /** Account-scoped data access. The only door to the database. */
  db: AccountDb;
  /** The workspace (account) this credential belongs to. */
  accountId: string;
  /** api_keys row id (null for an OAuth token). */
  keyId: string | null;
  /** oauth_grants row id (null for an API key). */
  oauthGrantId: string | null;
  /** Scopes granted to this credential. */
  scopes: string[];
  /** Who minted the key (null if that user was later removed). */
  createdBy: string | null;
  /** The workspace's plan: some actions exist on only one of them. */
  plan: ApiPlan;
  /** MCP switches of this credential. */
  mcp: { enabled: boolean; allowWrites: boolean };
}

/** Per-minute budget when the super admin set none for the account. */
export const PLAN_RATE_LIMITS: Record<ApiPlan, number> = { starter: 60, pro: 120 };

function extractKey(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const value = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : header.trim();
  return value.length > 0 ? value : null;
}

interface AccountGate {
  plan: ApiPlan;
  limit: number;
}

async function loadAccountGate(accountId: string): Promise<AccountGate> {
  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .select('plan, status, api_enabled, api_rate_limit')
    .eq('id', accountId)
    .maybeSingle();
  if (error || !data) {
    if (error) console.error('[api] account lookup failed:', error.message);
    throw unauthorized();
  }
  if (data.status && data.status !== 'active') {
    throw forbidden('Esta conta não está ativa');
  }
  if (data.api_enabled === false) {
    throw forbidden('A API está desligada para esta conta');
  }
  const plan: ApiPlan = data.plan === 'starter' ? 'starter' : 'pro';
  const limit = typeof data.api_rate_limit === 'number' ? data.api_rate_limit : PLAN_RATE_LIMITS[plan];
  return { plan, limit };
}

/**
 * Count one call against the credential's per-minute budget. Uses the
 * shared counter in Postgres (migration 062) so every server instance
 * sees the same total; falls back to the per-instance counter when the
 * database call fails, rather than failing the request.
 */
export async function hitRateLimit(bucket: string, limit: number, windowSeconds = 60): Promise<RateLimitResult> {
  const { data, error } = await supabaseAdmin().rpc('api_rate_hit', {
    p_bucket: bucket,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) {
    if (error) console.warn('[api] shared rate limit unavailable:', error.message);
    return checkRateLimit(bucket, { limit, windowMs: windowSeconds * 1000 });
  }
  return {
    success: Boolean(row.allowed),
    remaining: Number(row.remaining ?? 0),
    reset: new Date(row.reset_at as string).getTime(),
    limit,
  };
}

export interface AuthenticateOptions {
  /**
   * Accept OAuth access tokens (the claude.ai connector). Only the MCP
   * endpoint sets this: those tokens are minted for /api/mcp, so the
   * REST API refuses them (audience binding, RFC 8707).
   */
  allowOAuth?: boolean;
}

/**
 * Authenticate the request. Throws `ApiError` (401 / 403 / 429).
 */
export async function authenticateApi(request: Request, options: AuthenticateOptions = {}): Promise<ApiContext> {
  const presented = extractKey(request);
  if (!presented) throw unauthorized();
  if (presented.startsWith(OAUTH_PREFIX.access)) {
    if (!options.allowOAuth) throw unauthorized();
    return authenticateOAuth(presented);
  }
  if (!looksLikeApiKey(presented)) throw unauthorized();

  const row = await findActiveKeyByHash(hashApiKey(presented));
  if (!row) throw unauthorized();

  const gate = await loadAccountGate(row.account_id);

  const limit = await hitRateLimit(`apikey:${row.id}`, gate.limit);
  if (!limit.success) throw rateLimited(limit);

  touchLastUsed(row.id);

  return {
    authType: 'api_key',
    db: createAccountDb(supabaseAdmin(), row.account_id),
    accountId: row.account_id,
    keyId: row.id,
    oauthGrantId: null,
    scopes: row.scopes,
    createdBy: row.created_by,
    plan: gate.plan,
    mcp: { enabled: row.mcp_enabled !== false, allowWrites: row.mcp_allow_writes === true },
  };
}

/**
 * An OAuth access token: a person allowed an app on one workspace.
 * It works while the connection is live and the person is still owner
 * or admin there; losing that role cuts the app off on the next call.
 */
async function authenticateOAuth(token: string): Promise<ApiContext> {
  const admin = supabaseAdmin();
  const grant = await findGrantByAccessToken(admin, token);
  if (!grant) throw unauthorized();
  if (!(await isWorkspaceAdmin(admin, grant.account_id, grant.user_id))) throw unauthorized();

  const gate = await loadAccountGate(grant.account_id);
  const limit = await hitRateLimit(`oauth:${grant.id}`, gate.limit);
  if (!limit.success) throw rateLimited(limit);

  touchGrant(admin, grant.id);

  return {
    authType: 'oauth',
    db: createAccountDb(admin, grant.account_id),
    accountId: grant.account_id,
    keyId: null,
    oauthGrantId: grant.id,
    scopes: scopesForGrant(grant.allow_writes),
    createdBy: grant.user_id,
    plan: gate.plan,
    mcp: { enabled: true, allowWrites: grant.allow_writes },
  };
}

/** Throws 403 unless the credential carries `scope`. */
export function requireScope(ctx: ApiContext, scope: ApiScope): void {
  if (!hasScope(ctx.scopes, scope)) {
    throw forbidden(`Esta chave não tem a permissão '${scope}'`);
  }
}

/** Throws 403 when the action does not exist on the workspace's plan. */
export function requirePlan(ctx: ApiContext, plan: ApiPlan, what: string): void {
  if (ctx.plan !== plan) {
    throw new ApiError(
      'forbidden',
      `${what} ${plan === 'pro' ? 'é do plano Pro' : 'é do plano Starter'}`,
      403
    );
  }
}

/** Best-effort audit row; never fails the request. */
export function logApiRequest(entry: {
  accountId: string;
  keyId: string | null;
  oauthGrantId?: string | null;
  via: 'api' | 'mcp';
  method: string;
  route: string;
  status: number;
  durationMs: number;
}): void {
  void supabaseAdmin()
    .from('api_request_log')
    .insert({
      account_id: entry.accountId,
      key_id: entry.keyId,
      ...(entry.oauthGrantId ? { oauth_grant_id: entry.oauthGrantId } : {}),
      via: entry.via,
      method: entry.method,
      route: entry.route.slice(0, 200),
      status: entry.status,
      duration_ms: entry.durationMs,
    })
    .then(({ error }) => {
      if (error) console.warn('[api] request log insert failed:', error.message);
    });
}

type RouteParams = Record<string, string>;
export type ApiHandler<P extends RouteParams = RouteParams> = (
  ctx: ApiContext,
  request: Request,
  params: P
) => Promise<Response>;

/** A wrapped v1 route: a Next handler that also exposes its parts. */
export interface ApiRouteHandler<P extends RouteParams = RouteParams> {
  (request: Request, route?: { params?: Promise<P> }): Promise<Response>;
  /** Scope the route requires (null = any valid credential). */
  readonly scope: ApiScope | null;
  /**
   * The handler body for an already-authenticated context. The MCP
   * calls this so a tool and its endpoint run exactly the same code.
   */
  readonly run: ApiHandler<P>;
}

/**
 * Wrap a v1 route: authenticate, check `scope` (omit for scope-free
 * routes such as /me), run, map errors to the envelope, log the call.
 */
export function apiRoute<P extends RouteParams = RouteParams>(
  scope: ApiScope | null,
  handler: ApiHandler<P>
): ApiRouteHandler<P> {
  const wrapped = async (request: Request, route?: { params?: Promise<P> }): Promise<Response> => {
    const started = Date.now();
    let ctx: ApiContext | null = null;
    let response: Response;
    try {
      ctx = await authenticateApi(request);
      if (scope) requireScope(ctx, scope);
      const params = ((await route?.params) ?? {}) as P;
      response = await handler(ctx, request, params);
    } catch (err) {
      response = toApiErrorResponse(err);
    }
    if (ctx) {
      logApiRequest({
        accountId: ctx.accountId,
        keyId: ctx.keyId,
        via: 'api',
        method: request.method,
        route: new URL(request.url).pathname,
        status: response.status,
        durationMs: Date.now() - started,
      });
    }
    return response;
  };
  return Object.assign(wrapped, { scope, run: handler });
}
