// ============================================================
// Resolve the app behind a client_id.
//
// Two ways an app can be known:
//   * it registered itself at /api/oauth/register (client_id lcc_…);
//   * its client_id is the https URL of a JSON metadata document
//     (OAuth Client ID Metadata Document, used by the MCP spec). We
//     fetch it, check it names itself and lists the redirect, and keep
//     a copy in oauth_clients so the token endpoint needs no fetch.
//
// The fetch goes only to public hosts (same guard as webhooks), with a
// short timeout and a small size limit.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import {
  MAX_REDIRECT_URIS,
  cleanClientName,
  isMetadataDocumentClientId,
  isValidRedirectUri,
} from '@/lib/oauth/core';
import { getClient, upsertMetadataClient, type OAuthClientRow } from '@/lib/oauth/store';

const FETCH_TIMEOUT_MS = 5000;
const MAX_DOCUMENT_BYTES = 64 * 1024;

async function readLimited(res: Response): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Fetch and check a client metadata document. Null when unusable. */
export async function fetchClientMetadata(
  clientId: string,
  fetcher: typeof fetch = fetch
): Promise<{ clientName: string | null; redirectUris: string[] } | null> {
  if (!isMetadataDocumentClientId(clientId)) return null;
  if (!(await isDeliverableUrl(clientId))) return null;
  let res: Response;
  try {
    res = await fetcher(clientId, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const text = await readLimited(res);
  if (!text) return null;
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || doc.client_id !== clientId) return null;
  const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris : [];
  if (uris.length === 0 || uris.length > MAX_REDIRECT_URIS || !uris.every(isValidRedirectUri)) return null;
  // We only take public clients from a document (no private_key_jwt).
  const method = doc.token_endpoint_auth_method;
  if (method !== undefined && method !== 'none') return null;
  return { clientName: cleanClientName(doc.client_name), redirectUris: uris as string[] };
}

/**
 * The app for a client_id, or null when it is unknown. A metadata
 * document client is re-read on every authorization, so a change to
 * its redirect list takes effect at the next login.
 */
export async function resolveClient(
  db: SupabaseClient,
  clientId: string,
  fetcher: typeof fetch = fetch
): Promise<OAuthClientRow | null> {
  if (!clientId || clientId.length > 2000) return null;
  if (!isMetadataDocumentClientId(clientId)) return getClient(db, clientId);
  const meta = await fetchClientMetadata(clientId, fetcher);
  if (!meta) return null;
  return upsertMetadataClient(db, { clientId, ...meta });
}
