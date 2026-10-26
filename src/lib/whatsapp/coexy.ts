/**
 * Coexy Management API (https://api.coexy.com.br/functions/v1/api).
 *
 * Server-only: authenticates with COEXY_API_KEY (x-api-key), which must
 * never reach the browser. Messaging itself goes through the meta-proxy
 * with each channel's channel_token — see provider.ts / meta-api.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, encrypt } from './encryption'

const COEXY_API_BASE = 'https://api.coexy.com.br/functions/v1/api'

export type CoexyChannelStatus = 'pending' | 'active' | 'disconnected' | 'suspended'

export interface CoexyChannel {
  id: string
  name: string
  status: CoexyChannelStatus
  display_phone_number: string | null
  phone_number_id: string | null
  waba_id: string | null
  channel_token: string
  connect_url: string
  connected_at: string | null
}

interface CoexyWebhook {
  id: string
  url: string
  hmac_secret: string
}

export const COEXY_WEBHOOK_EVENTS = [
  'messages',
  'smb_message_echoes',
  'message_template_status_update',
  'message_template_quality_update',
] as const

export class CoexyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'CoexyApiError'
  }
}

export function hasCoexyApiKey(): boolean {
  return Boolean(process.env.COEXY_API_KEY?.trim())
}

async function coexyRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const apiKey = process.env.COEXY_API_KEY?.trim()
  if (!apiKey) throw new CoexyApiError('COEXY_API_KEY não configurada no servidor.', 500)

  const response = await fetch(`${COEXY_API_BASE}${path}`, {
    method,
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  })

  if (response.status === 204) return undefined as T
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      response.status === 429
        ? `Limite da Coexy atingido; tente de novo em ${response.headers.get('Retry-After') ?? 'alguns'}s.`
        : (data as { error?: string } | null)?.error ?? `Coexy respondeu HTTP ${response.status}.`
    throw new CoexyApiError(message, response.status)
  }
  return data as T
}

export function createCoexyChannel(name: string): Promise<CoexyChannel> {
  return coexyRequest<CoexyChannel>('POST', '/channels', { name })
}

export function getCoexyChannel(channelId: string): Promise<CoexyChannel> {
  return coexyRequest<CoexyChannel>('GET', `/channels/${encodeURIComponent(channelId)}`)
}

/**
 * HMAC secrets of the Coexy webhooks this install created, decrypted.
 * Used together with COEXY_HMAC_SECRET to verify inbound deliveries.
 */
export async function loadCoexyWebhookSecrets(admin: SupabaseClient): Promise<string[]> {
  const { data, error } = await admin.from('coexy_webhooks').select('hmac_secret')
  if (error) {
    console.error('[coexy] failed to load webhook secrets:', error.message)
    return []
  }
  const secrets: string[] = []
  for (const row of data ?? []) {
    try {
      secrets.push(decrypt(row.hmac_secret as string))
    } catch (err) {
      console.error('[coexy] could not decrypt a webhook secret:', err)
    }
  }
  return secrets
}

/**
 * Make sure a Coexy webhook delivers to this install. Created once, for
 * every channel of the org (no channel_ids), the first time anyone
 * connects. Skipped when the operator manages it by hand through
 * COEXY_HMAC_SECRET.
 */
export async function ensureCoexyWebhook(admin: SupabaseClient, webhookUrl: string): Promise<void> {
  if (process.env.COEXY_HMAC_SECRET?.trim()) return

  const { data: existing } = await admin
    .from('coexy_webhooks')
    .select('webhook_id')
    .eq('url', webhookUrl)
    .limit(1)
  if (existing && existing.length > 0) return

  const webhook = await coexyRequest<CoexyWebhook>('POST', '/webhooks', {
    name: 'LabCRM',
    url: webhookUrl,
    events: COEXY_WEBHOOK_EVENTS,
  })

  const { error } = await admin.from('coexy_webhooks').insert({
    webhook_id: webhook.id,
    url: webhookUrl,
    hmac_secret: encrypt(webhook.hmac_secret),
  })
  if (error) {
    // The secret can't be fetched again: without the row every delivery
    // would be rejected, so drop the webhook and let the next connect retry.
    console.error('[coexy] failed to store webhook secret, deleting webhook:', error.message)
    await coexyRequest('DELETE', `/webhooks/${encodeURIComponent(webhook.id)}`).catch(() => {})
    throw new CoexyApiError('Não foi possível salvar o webhook da Coexy.', 500)
  }
}
