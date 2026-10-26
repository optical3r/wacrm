/**
 * Which relay this install uses to reach the WhatsApp Cloud API.
 *
 * - `meta` (default): talk to graph.facebook.com directly with a Meta
 *   access token, webhooks signed with META_APP_SECRET.
 * - `coexy`: talk to Coexy's meta-proxy, a transparent relay for the
 *   same Cloud API. Endpoints, bodies and webhook payloads are identical
 *   to Meta's; only three things change:
 *     1. base URL → https://api.coexy.com.br/functions/v1/meta-proxy
 *     2. the "access token" saved in Settings is the Coexy channel_token
 *     3. webhooks arrive signed with `X-Coexy-Signature` (COEXY_HMAC_SECRET)
 *   Coexy also owns phone registration and the WABA → app subscription,
 *   so those Meta-only setup steps are skipped.
 *
 * See coexy-spec.md at the project root.
 */

export type WhatsAppProvider = 'meta' | 'coexy'

export const COEXY_META_PROXY_BASE = 'https://api.coexy.com.br/functions/v1/meta-proxy'

export function whatsappProvider(): WhatsAppProvider {
  return (process.env.WHATSAPP_PROVIDER ?? '').trim().toLowerCase() === 'coexy' ? 'coexy' : 'meta'
}

export function isCoexy(): boolean {
  return whatsappProvider() === 'coexy'
}

/** Base URL for Cloud API calls, without a trailing slash. */
export function metaApiBase(metaVersion: string): string {
  return isCoexy() ? COEXY_META_PROXY_BASE : `https://graph.facebook.com/${metaVersion}`
}
