// ============================================================
// OAuth 2.1 for the remote MCP: pure helpers, no I/O.
//
// LabCRM is the authorization server for its own MCP at /api/mcp, so
// claude.ai (site and phone app) can add it as a custom connector and
// log in instead of pasting an API key. See migration 064 and
// docs/mcp.md.
//
// Every secret here (client secret, code, access and refresh token) is
// 32 CSPRNG bytes with a recognisable prefix. The database keeps only
// SHA-256 hashes, like API keys (see src/lib/api-keys/keys.ts).
// ============================================================

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { API_SCOPES, type ApiScope } from '@/lib/api-keys/scopes';

export const OAUTH_PREFIX = {
  client: 'lcc_',
  clientSecret: 'lccs_',
  code: 'lcoc_',
  access: 'lcoa_',
  refresh: 'lcor_',
} as const;

/** Access tokens live one hour; the client refreshes them silently. */
export const ACCESS_TTL_SECONDS = 60 * 60;
/** A refresh token is good for 60 days, and is replaced on every use. */
export const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 60;
/** Authorization codes: 10 minutes, one use. */
export const CODE_TTL_SECONDS = 10 * 60;

/** The two scopes a person can grant on the consent screen. */
export const OAUTH_SCOPES = ['labcrm:read', 'labcrm:write'] as const;

export const MAX_REDIRECT_URIS = 10;

export function newSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

export function hashSecret(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** Constant-time comparison of two hex digests (or any two strings). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** The MCP endpoint, which is the one resource these tokens are for. */
export function mcpResource(origin: string): string {
  return `${origin}/api/mcp`;
}

/**
 * RFC 8707 `resource`: absent, or naming our MCP. A token minted for
 * some other resource must never be accepted here, so anything else is
 * refused. Clients differ on the trailing slash and some send the bare
 * origin, so those are accepted too.
 */
export function resourceMatches(resource: string | null | undefined, origin: string): boolean {
  if (resource == null || resource === '') return true;
  const mcp = mcpResource(origin);
  return resource === mcp || resource === `${mcp}/` || resource === origin || resource === `${origin}/`;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

/**
 * A redirect URI an app may register: https anywhere, or http only on
 * this machine (Claude Code, Codex and other desktop tools listen on a
 * local port). No fragments, no credentials in the URL.
 */
export function isValidRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopbackHost(url.hostname);
}

/**
 * Exact match, except that a loopback http redirect may come back on
 * any port (RFC 8252 §7.3: the app picks a free port at run time).
 */
export function redirectUriMatches(registered: readonly string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  let p: URL;
  try {
    p = new URL(presented);
  } catch {
    return false;
  }
  if (p.protocol !== 'http:' || !isLoopbackHost(p.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return (
        u.protocol === 'http:' &&
        u.hostname === p.hostname &&
        u.pathname === p.pathname &&
        u.search === p.search
      );
    } catch {
      return false;
    }
  });
}

const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;

export function isValidCodeChallenge(challenge: unknown): challenge is string {
  return typeof challenge === 'string' && PKCE_CHALLENGE.test(challenge);
}

/** PKCE S256: base64url(sha256(verifier)) must equal the challenge. */
export function verifyPkce(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !PKCE_VERIFIER.test(verifier)) return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  return safeEqual(computed, challenge);
}

/** What an OAuth grant may do through the MCP. */
export function scopesForGrant(allowWrites: boolean): ApiScope[] {
  return allowWrites ? [...API_SCOPES] : API_SCOPES.filter((s) => s.endsWith(':read'));
}

export function scopeString(allowWrites: boolean): string {
  return allowWrites ? 'labcrm:read labcrm:write' : 'labcrm:read';
}

/** Client names are shown on the consent screen: keep them short and plain. */
export function cleanClientName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  return name.length > 0 ? name : null;
}

/** A client_id that is the https URL of a client metadata document. */
export function isMetadataDocumentClientId(clientId: string): boolean {
  try {
    const url = new URL(clientId);
    return url.protocol === 'https:' && url.pathname.length > 1 && !url.hash && !url.username;
  } catch {
    return false;
  }
}

/** Build the redirect back to the app, with `iss` (RFC 9207). */
export function buildRedirect(
  redirectUri: string,
  params: Record<string, string | null | undefined>
): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, v);
  }
  return url.toString();
}
