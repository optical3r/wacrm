// ============================================================
// OAuth HTTP helpers: discovery documents, CORS, error bodies.
// ============================================================

import { mcpResource, OAUTH_SCOPES } from '@/lib/oauth/core';

/** Discovery, register, token and revoke are called cross-origin by browser apps. */
export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-max-age': '86400',
};

export function requestOrigin(request: Request): string {
  return new URL(request.url).origin;
}

export function oauthJson(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      pragma: 'no-cache',
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

export function oauthError(error: string, description: string, status = 400): Response {
  const extra: Record<string, string> =
    status === 401 ? { 'www-authenticate': 'Basic realm="labcrm-oauth"' } : {};
  return oauthJson({ error, error_description: description }, status, extra);
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** RFC 9728: where the MCP's tokens come from. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: mcpResource(origin),
    authorization_servers: [origin],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'LabCRM',
  };
}

/** RFC 8414: how to log in. */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [...OAUTH_SCOPES],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}

/** Header the MCP sends with a 401, pointing at the metadata above. */
export function mcpWwwAuthenticate(origin: string): string {
  return `Bearer realm="labcrm", resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp"`;
}

/** Best-effort caller IP, for per-IP limits on the public endpoints. */
export function clientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

/** Read a form-encoded (or, leniently, JSON) body into a flat map. */
export async function readParams(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get('content-type') ?? '';
  const out: Record<string, string> = {};
  try {
    if (type.includes('application/json')) {
      const body = (await request.json()) as Record<string, unknown>;
      for (const [k, v] of Object.entries(body ?? {})) if (typeof v === 'string') out[k] = v;
    } else {
      const text = await request.text();
      for (const [k, v] of new URLSearchParams(text)) out[k] = v;
    }
  } catch {
    // An unreadable body is the same as an empty one: the caller reports
    // the missing parameter.
  }
  return out;
}

/**
 * The client credentials a token or revoke call presents: HTTP Basic
 * (client_secret_basic) or form fields (client_secret_post / none).
 */
export function presentedClient(
  request: Request,
  params: Record<string, string>
): { clientId: string | null; clientSecret: string | null } {
  const header = request.headers.get('authorization');
  if (header?.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon > 0) {
        return {
          clientId: decodeURIComponent(decoded.slice(0, colon)),
          clientSecret: decodeURIComponent(decoded.slice(colon + 1)),
        };
      }
    } catch {
      return { clientId: null, clientSecret: null };
    }
  }
  return { clientId: params.client_id || null, clientSecret: params.client_secret || null };
}
