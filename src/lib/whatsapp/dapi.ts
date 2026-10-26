/**
 * D-API (https://api.d-api.cloud): the unofficial, QR-code WhatsApp
 * connection used by the Starter plan.
 *
 * Server-only: authenticates with DAPI_API_KEY, which must never reach
 * the browser.
 *
 * How it plugs into the rest of the app: a Starter account's
 * whatsapp_config row stores `phone_number_id = "dapi:<sessionId>"`.
 * Every send helper in meta-api.ts checks that prefix and routes the
 * call here instead of to Meta, so the inbox, flows, automations and AI
 * replies need no change. Inbound events arrive at
 * /api/whatsapp/dapi/webhook and are translated into Meta's webhook
 * shape (see dapi-webhook.ts) before entering the same pipeline.
 */

import { DApi } from 'd-api-sdk'
import type { MetaSendResult } from './meta-api'

export const DAPI_PHONE_PREFIX = 'dapi:'
/** Stored (encrypted) as whatsapp_config.access_token for D-API rows: the
 *  real credential is the server-wide DAPI_API_KEY. */
export const DAPI_ACCESS_TOKEN = 'dapi'
/** Inbound media ids are this prefix + base64url(JSON of the media fields). */
export const DAPI_MEDIA_PREFIX = 'dapi.'

export function hasDapiApiKey(): boolean {
  return Boolean(process.env.DAPI_API_KEY?.trim())
}

let _client: DApi | null = null
export function dapiClient(): DApi {
  const apiKey = process.env.DAPI_API_KEY?.trim()
  if (!apiKey) throw new Error('DAPI_API_KEY não configurada no servidor.')
  if (!_client) _client = new DApi({ apiKey })
  return _client
}

export function isDapiPhoneNumberId(phoneNumberId: string | null | undefined): boolean {
  return Boolean(phoneNumberId?.startsWith(DAPI_PHONE_PREFIX))
}

export function dapiPhoneNumberId(sessionId: string): string {
  return `${DAPI_PHONE_PREFIX}${sessionId}`
}

export function sessionIdFrom(phoneNumberId: string): string {
  return phoneNumberId.slice(DAPI_PHONE_PREFIX.length)
}

/**
 * One live session per organization, with a fresh id on every new
 * pairing: D-API keeps ids of deleted sessions reserved, so reusing one
 * fails with a duplicate-key error. The account id stays in the prefix
 * (migration 050 checks it).
 */
export function dapiSessionIdFor(accountId: string): string {
  return `labcrm-${accountId}-${Date.now().toString(36)}`
}

/** Digits only: D-API addresses contacts by phone number. */
function toNumber(to: string): string {
  return to.split('@')[0].replace(/\D/g, '')
}

function contextFor(contextMessageId?: string) {
  return contextMessageId ? { contextInfo: { stanzaId: contextMessageId } } : {}
}

/** D-API's send response carries the WhatsApp message id under a few names. */
function messageIdOf(res: unknown): string {
  const r = (res ?? {}) as Record<string, unknown>
  const data = (r.data ?? {}) as Record<string, unknown>
  const key = (r.key ?? data.key ?? {}) as Record<string, unknown>
  const id = r.messageId ?? data.messageId ?? r.id ?? data.id ?? key.id
  if (typeof id !== 'string' || !id) {
    throw new Error('D-API não retornou o id da mensagem enviada.')
  }
  return id
}

export async function dapiSendText(args: {
  phoneNumberId: string
  to: string
  text: string
  contextMessageId?: string
}): Promise<MetaSendResult> {
  const res = await dapiClient().messages.sendText({
    sessionId: sessionIdFrom(args.phoneNumberId),
    to: toNumber(args.to),
    text: args.text,
    ...contextFor(args.contextMessageId),
  })
  return { messageId: messageIdOf(res) }
}

export async function dapiSendMedia(args: {
  phoneNumberId: string
  to: string
  kind: 'image' | 'video' | 'document' | 'audio'
  link: string
  caption?: string
  filename?: string
  contextMessageId?: string
}): Promise<MetaSendResult> {
  const base = {
    sessionId: sessionIdFrom(args.phoneNumberId),
    to: toNumber(args.to),
    ...contextFor(args.contextMessageId),
  }
  const m = dapiClient().messages
  let res: unknown
  switch (args.kind) {
    case 'image':
      res = await m.sendImage({ ...base, image: args.link, caption: args.caption })
      break
    case 'video':
      res = await m.sendVideo({ ...base, video: args.link, caption: args.caption })
      break
    case 'audio':
      res = await m.sendAudio({ ...base, audio: args.link, ptt: true })
      break
    case 'document':
      res = await m.sendDocument({ ...base, document: args.link, fileName: args.filename })
      break
  }
  return { messageId: messageIdOf(res) }
}

export async function dapiSendReaction(args: {
  phoneNumberId: string
  to: string
  targetMessageId: string
  emoji: string
}): Promise<MetaSendResult> {
  const res = await dapiClient().messages.sendReaction({
    sessionId: sessionIdFrom(args.phoneNumberId),
    to: toNumber(args.to),
    messageId: args.targetMessageId,
    emoji: args.emoji,
  })
  // A reaction's own id is rarely needed; fall back to the target's.
  try {
    return { messageId: messageIdOf(res) }
  } catch {
    return { messageId: args.targetMessageId }
  }
}

export async function dapiSendButtons(args: {
  phoneNumberId: string
  to: string
  bodyText: string
  headerText?: string
  footerText?: string
  buttons: Array<{ id: string; title: string }>
}): Promise<MetaSendResult> {
  const res = await dapiClient().interactive.sendNativeFlow({
    sessionId: sessionIdFrom(args.phoneNumberId),
    to: toNumber(args.to),
    title: args.headerText ?? '',
    body: args.bodyText,
    footer: args.footerText,
    buttons: args.buttons.map((b) => ({ type: 'quick_reply' as const, id: b.id, title: b.title })),
  })
  return { messageId: messageIdOf(res) }
}

export async function dapiSendList(args: {
  phoneNumberId: string
  to: string
  bodyText: string
  buttonLabel: string
  headerText?: string
  footerText?: string
  sections: Array<{ title?: string; rows: Array<{ id: string; title: string; description?: string }> }>
}): Promise<MetaSendResult> {
  const res = await dapiClient().interactive.sendList({
    sessionId: sessionIdFrom(args.phoneNumberId),
    to: toNumber(args.to),
    title: args.headerText,
    description: args.bodyText,
    buttonText: args.buttonLabel,
    footerText: args.footerText,
    sections: args.sections.map((s) => ({
      title: s.title,
      rows: s.rows.map((r) => ({ rowId: r.id, title: r.title, description: r.description })),
    })),
  })
  return { messageId: messageIdOf(res) }
}

export async function dapiSendTyping(args: { phoneNumberId: string; to?: string; messageId: string }) {
  if (!args.to) return
  const sessionId = sessionIdFrom(args.phoneNumberId)
  const to = toNumber(args.to)
  await dapiClient().chats.markAsRead({ sessionId, to, messageIds: [args.messageId] }).catch(() => {})
  await dapiClient().chats.sendPresence({ sessionId, to, presence: 'typing', durationMs: 5000 })
}

// ------------------------------------------------------------
// Inbound media
// ------------------------------------------------------------

export interface DapiMediaRef {
  /** sessionId */
  s: string
  url?: string
  direct_path?: string
  /** Absent when D-API already handed over a ready-to-download URL. */
  media_key?: string
  mimetype: string
  file_enc_sha256?: string
  file_sha256?: string
  file_length?: number
}

export function encodeDapiMediaId(ref: DapiMediaRef): string {
  return DAPI_MEDIA_PREFIX + Buffer.from(JSON.stringify(ref)).toString('base64url')
}

export function isDapiMediaId(mediaId: string): boolean {
  return mediaId.startsWith(DAPI_MEDIA_PREFIX)
}

export function decodeDapiMediaId(mediaId: string): DapiMediaRef {
  return JSON.parse(Buffer.from(mediaId.slice(DAPI_MEDIA_PREFIX.length), 'base64url').toString('utf8'))
}

/** Same contract as meta-api's getMediaUrl, for a D-API media id. */
export async function dapiMediaUrl(
  mediaId: string,
): Promise<{ url: string; mimeType: string; fileSize: number | null }> {
  const ref = decodeDapiMediaId(mediaId)
  if (!ref.media_key) {
    if (!ref.url) throw new Error('Mídia do D-API sem url nem media_key.')
    return { url: ref.url, mimeType: ref.mimetype, fileSize: ref.file_length ?? null }
  }
  const res = await dapiClient().media.download({
    sessionId: ref.s,
    url: ref.url,
    direct_path: ref.direct_path,
    media_key: ref.media_key,
    mimetype: ref.mimetype,
    file_enc_sha256: ref.file_enc_sha256,
    file_sha256: ref.file_sha256,
    file_length: ref.file_length,
  })
  const r = res as Record<string, unknown>
  const data = (r.data ?? {}) as Record<string, unknown>
  const url = (r.media_url ?? data.media_url ?? r.url ?? data.url) as string | undefined
  if (!url) throw new Error('D-API não retornou o link da mídia.')
  return {
    url,
    mimeType: ref.mimetype || 'application/octet-stream',
    fileSize: typeof ref.file_length === 'number' ? ref.file_length : null,
  }
}
