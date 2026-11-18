// ============================================================
// The authorization request (/oauth/authorize): validation shared by
// the consent page and the form POST, plus the signed "consent ticket"
// that carries the checked request from one to the other.
//
// Errors come in two kinds (RFC 6749 §4.1.2.1):
//   * fatal: the app or the redirect can't be trusted, so we show an
//     error page and never redirect;
//   * redirect: the app is known, so the error goes back to it.
// ============================================================

import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveClient } from '@/lib/oauth/client-metadata';
import {
  isValidCodeChallenge,
  redirectUriMatches,
  resourceMatches,
  safeEqual,
} from '@/lib/oauth/core';
import type { OAuthClientRow } from '@/lib/oauth/store';

export interface AuthorizeRequest {
  client: OAuthClientRow;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  resource: string | null;
  /** The app asked for write access (labcrm:write in scope). */
  wantsWrite: boolean;
}

export type AuthorizeValidation =
  | { ok: true; request: AuthorizeRequest }
  | { ok: false; kind: 'fatal'; message: string }
  | { ok: false; kind: 'redirect'; redirectUri: string; error: string; description: string; state: string | null };

type Params = Record<string, string | string[] | undefined>;

function one(params: Params, key: string): string | null {
  const v = params[key];
  if (Array.isArray(v)) return v.length === 1 ? v[0] : null;
  return typeof v === 'string' ? v : null;
}

export async function validateAuthorizeRequest(
  db: SupabaseClient,
  params: Params,
  origin: string,
  fetcher?: typeof fetch
): Promise<AuthorizeValidation> {
  const clientId = one(params, 'client_id');
  const redirectUri = one(params, 'redirect_uri');
  if (!clientId) return { ok: false, kind: 'fatal', message: 'O app não se identificou (client_id).' };

  const client = await resolveClient(db, clientId, fetcher);
  if (!client) return { ok: false, kind: 'fatal', message: 'Este app não está registrado no LabCRM.' };
  if (!redirectUri || !redirectUriMatches(client.redirect_uris, redirectUri)) {
    return { ok: false, kind: 'fatal', message: 'O endereço de retorno do app não confere com o registrado.' };
  }

  const state = one(params, 'state');
  const fail = (error: string, description: string): AuthorizeValidation => ({
    ok: false,
    kind: 'redirect',
    redirectUri,
    error,
    description,
    state,
  });

  if (one(params, 'response_type') !== 'code') {
    return fail('unsupported_response_type', 'Only response_type=code is supported');
  }
  const codeChallenge = one(params, 'code_challenge');
  if (!isValidCodeChallenge(codeChallenge) || one(params, 'code_challenge_method') !== 'S256') {
    return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  }
  const resource = one(params, 'resource');
  if (!resourceMatches(resource, origin)) {
    return fail('invalid_target', 'Unknown resource');
  }
  const scope = (one(params, 'scope') ?? '').split(/\s+/).filter(Boolean);
  // Unknown scopes are ignored: the person picks read or write on the
  // consent screen, whatever the app asked for.

  return {
    ok: true,
    request: {
      client,
      clientId,
      redirectUri,
      codeChallenge,
      state,
      resource: resource || null,
      wantsWrite: scope.includes('labcrm:write'),
    },
  };
}

// ---------- consent ticket ------------------------------------------------

/** What the consent form posts back, signed so it can't be altered. */
export interface ConsentTicket {
  uid: string;
  cid: string;
  ru: string;
  cc: string;
  st: string | null;
  rs: string | null;
  exp: number;
}

const TICKET_TTL_MS = 15 * 60 * 1000;

function signingKey(): Buffer {
  const base = process.env.OAUTH_SIGNING_SECRET || process.env.ENCRYPTION_KEY;
  if (!base) throw new Error('OAUTH_SIGNING_SECRET or ENCRYPTION_KEY must be set');
  return createHmac('sha256', base).update('labcrm-oauth-consent-v1').digest();
}

function mac(payload: string): string {
  return createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

export function signConsentTicket(userId: string, req: AuthorizeRequest, now = Date.now()): string {
  const ticket: ConsentTicket = {
    uid: userId,
    cid: req.clientId,
    ru: req.redirectUri,
    cc: req.codeChallenge,
    st: req.state,
    rs: req.resource,
    exp: now + TICKET_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(ticket)).toString('base64url');
  return `${payload}.${mac(payload)}`;
}

/** The ticket, if the signature holds, it hasn't expired and it is this person's. */
export function verifyConsentTicket(raw: unknown, userId: string, now = Date.now()): ConsentTicket | null {
  if (typeof raw !== 'string' || raw.length > 8000) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!safeEqual(sig, mac(payload))) return null;
  let ticket: ConsentTicket;
  try {
    ticket = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ConsentTicket;
  } catch {
    return null;
  }
  if (!ticket || ticket.uid !== userId || typeof ticket.exp !== 'number' || ticket.exp < now) return null;
  return ticket;
}
