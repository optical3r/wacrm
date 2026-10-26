/**
 * Translate a D-API webhook payload into Meta's Cloud API webhook shape,
 * so Starter accounts (QR-code connection) reuse the exact pipeline the
 * official API feeds: contacts, inbox, flows, automations, AI replies.
 *
 * D-API does not document the payload of its WhatsApp-session webhooks,
 * so this reads defensively. It understands the three shapes such
 * gateways use: D-API's own ChatMessage (messageId, chatId, fromMe…),
 * Baileys (key + message) and whatsmeow (Info + Message). Keys are
 * matched case-insensitively because whatsmeow serialises protobuf
 * field names as `URL`, `fileSHA256` and so on. Raw payloads are logged
 * by the route (dapi_webhook_log) so this can be tightened against
 * real traffic.
 */

import type { WhatsAppMessage, WhatsAppWebhookEntry } from './webhook-processor'
import { encodeDapiMediaId, type DapiMediaRef } from './dapi'

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** First non-empty value among `keys`, matched case-insensitively. */
function g(obj: unknown, ...keys: string[]): unknown {
  if (!isObj(obj)) return undefined
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]))
  for (const key of keys) {
    const real = lower.get(key.toLowerCase())
    if (real === undefined) continue
    const v = obj[real]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v || undefined
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

function num(v: unknown): number | undefined {
  if (isObj(v) && 'low' in v) return num(v.low) // protobuf Long
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

function bool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1
}

/** Bytes fields arrive as base64 strings, or as Buffer-like JSON. */
function bytes(v: unknown): string | undefined {
  if (typeof v === 'string') return v || undefined
  if (isObj(v) && Array.isArray(v.data)) return Buffer.from(v.data as number[]).toString('base64')
  if (Array.isArray(v)) return Buffer.from(v as number[]).toString('base64')
  return undefined
}

const SKIP_JID_SUFFIXES = ['@g.us', '@broadcast', '@newsletter']

function isPhoneJid(jid: string): boolean {
  return !SKIP_JID_SUFFIXES.some((s) => jid.endsWith(s)) && !jid.endsWith('@lid')
}

function digits(jid: string): string {
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '')
}

/** Seconds since epoch; D-API may send ms or an ISO string. */
function seconds(v: unknown): string {
  const n = num(v)
  if (n !== undefined) return String(Math.floor(n > 1e12 ? n / 1000 : n))
  if (typeof v === 'string') {
    const t = Date.parse(v)
    if (!Number.isNaN(t)) return String(Math.floor(t / 1000))
  }
  return String(Math.floor(Date.now() / 1000))
}

// ------------------------------------------------------------
// Messages
// ------------------------------------------------------------

const MEDIA_KINDS = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  pttMessage: 'audio',
  documentMessage: 'document',
  documentWithCaptionMessage: 'document',
  stickerMessage: 'sticker',
} as const

interface Normalized {
  id: string
  chatJid: string
  fromMe: boolean
  pushName?: string
  timestamp: string
  message: WhatsAppMessage
}

/** Unwrap ephemeral / view-once / edited containers around the content. */
function unwrap(content: Obj): Obj {
  for (const wrapper of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage', 'editedMessage']) {
    const inner = g(content, wrapper)
    const msg = isObj(inner) ? g(inner, 'message') : undefined
    if (isObj(msg)) return unwrap(msg)
  }
  return content
}

function mediaRef(sessionId: string, m: Obj, fallbackMime: string): DapiMediaRef {
  return {
    s: sessionId,
    url: str(g(m, 'url', 'mediaUrl', 'media_url')),
    direct_path: str(g(m, 'directPath', 'direct_path')),
    media_key: bytes(g(m, 'mediaKey', 'media_key')),
    mimetype: str(g(m, 'mimetype', 'mimeType', 'mime_type')) ?? fallbackMime,
    file_enc_sha256: bytes(g(m, 'fileEncSha256', 'fileEncSHA256', 'file_enc_sha256')),
    file_sha256: bytes(g(m, 'fileSha256', 'fileSHA256', 'file_sha256')),
    file_length: num(g(m, 'fileLength', 'file_length', 'fileSize')),
  }
}

/** Build the Meta-shaped body of a protobuf-style `message` object. */
function fromProto(sessionId: string, content: Obj): Omit<WhatsAppMessage, 'id' | 'from' | 'timestamp'> | null {
  const c = unwrap(content)

  const conversation = str(g(c, 'conversation'))
  if (conversation) return { type: 'text', text: { body: conversation } }

  const ext = g(c, 'extendedTextMessage')
  if (isObj(ext)) {
    const ctx = g(ext, 'contextInfo')
    const quoted = str(g(ctx, 'stanzaId', 'stanzaID'))
    return {
      type: 'text',
      text: { body: str(g(ext, 'text')) ?? '' },
      ...(quoted ? { context: { id: quoted } } : {}),
    }
  }

  for (const [key, kind] of Object.entries(MEDIA_KINDS)) {
    const m = g(c, key)
    if (!isObj(m)) continue
    const ref = mediaRef(sessionId, m, kind === 'sticker' ? 'image/webp' : 'application/octet-stream')
    const media = {
      id: encodeDapiMediaId(ref),
      mime_type: ref.mimetype,
      caption: str(g(m, 'caption')),
    }
    if (kind === 'document') {
      return { type: 'document', document: { ...media, filename: str(g(m, 'fileName', 'title')) } }
    }
    if (kind === 'audio' || kind === 'sticker') {
      return { type: kind, [kind]: { id: media.id, mime_type: media.mime_type } }
    }
    return { type: kind, [kind]: media }
  }

  const loc = g(c, 'locationMessage', 'liveLocationMessage')
  if (isObj(loc)) {
    return {
      type: 'location',
      location: {
        latitude: num(g(loc, 'degreesLatitude', 'latitude')) ?? 0,
        longitude: num(g(loc, 'degreesLongitude', 'longitude')) ?? 0,
        name: str(g(loc, 'name')),
        address: str(g(loc, 'address')),
      },
    }
  }

  const reaction = g(c, 'reactionMessage')
  if (isObj(reaction)) {
    const target = str(g(g(reaction, 'key'), 'id', 'ID'))
    if (!target) return null
    return { type: 'reaction', reaction: { message_id: target, emoji: str(g(reaction, 'text')) ?? '' } }
  }

  const buttons = g(c, 'buttonsResponseMessage')
  if (isObj(buttons)) {
    const id = str(g(buttons, 'selectedButtonId', 'selectedButtonID')) ?? ''
    return { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: str(g(buttons, 'selectedDisplayText')) ?? id } } }
  }

  const template = g(c, 'templateButtonReplyMessage')
  if (isObj(template)) {
    const id = str(g(template, 'selectedId', 'selectedID')) ?? ''
    return { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: str(g(template, 'selectedDisplayText')) ?? id } } }
  }

  const list = g(c, 'listResponseMessage')
  if (isObj(list)) {
    const id = str(g(g(list, 'singleSelectReply'), 'selectedRowId', 'selectedRowID')) ?? ''
    return { type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title: str(g(list, 'title')) ?? id } } }
  }

  // Native-flow quick replies (what dapiSendButtons sends) come back as
  // an interactiveResponseMessage whose paramsJson carries the button id.
  const flow = g(c, 'interactiveResponseMessage')
  if (isObj(flow)) {
    const native = g(flow, 'nativeFlowResponseMessage')
    let id = ''
    try {
      const params = JSON.parse(str(g(native, 'paramsJson', 'paramsJSON')) ?? '{}')
      id = str(params.id) ?? ''
    } catch {
      // fall through with an empty id
    }
    const title = str(g(g(flow, 'body'), 'text')) ?? id
    return { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } }
  }

  return null
}

/** D-API's own flat ChatMessage shape. */
function fromFlat(sessionId: string, m: Obj): Omit<WhatsAppMessage, 'id' | 'from' | 'timestamp'> | null {
  const type = (str(g(m, 'type', 'messageType')) ?? 'text').toLowerCase().replace(/message$/, '')
  const caption = str(g(m, 'caption'))
  const quoted = str(g(m, 'quotedMessageId', 'quotedId'))
  const context = quoted ? { context: { id: quoted } } : {}

  if (type === 'text' || type === 'chat' || type === 'conversation' || type === 'extendedtext') {
    const body = str(g(m, 'message', 'content', 'text', 'body'))
    return body ? { type: 'text', text: { body }, ...context } : null
  }

  const kind = type === 'ptt' || type === 'voice' ? 'audio' : type
  if (['image', 'video', 'audio', 'document', 'sticker'].includes(kind)) {
    const ref = mediaRef(sessionId, m, 'application/octet-stream')
    const media = { id: encodeDapiMediaId(ref), mime_type: ref.mimetype }
    if (kind === 'document') {
      return { type: 'document', document: { ...media, caption, filename: str(g(m, 'fileName')) }, ...context }
    }
    if (kind === 'audio' || kind === 'sticker') return { type: kind, [kind]: media, ...context }
    return { type: kind, [kind]: { ...media, caption }, ...context }
  }

  if (type === 'reaction') {
    const target = str(g(m, 'reactionMessageId', 'targetMessageId', 'quotedMessageId'))
    return target ? { type: 'reaction', reaction: { message_id: target, emoji: str(g(m, 'message', 'content', 'emoji', 'text')) ?? '' } } : null
  }

  const content = str(g(m, 'message', 'content', 'text', 'caption'))
  return content ? { type: 'text', text: { body: content }, ...context } : null
}

function normalizeMessage(sessionId: string, raw: Obj): Normalized | null {
  // Baileys: { key: { remoteJid, fromMe, id }, message, pushName, messageTimestamp }
  // whatsmeow: { Info: { ID, Chat, IsFromMe, PushName, Timestamp }, Message }
  const key = g(raw, 'key')
  const info = g(raw, 'info')
  const meta = isObj(key) ? key : isObj(info) ? info : raw

  const id = str(g(meta, 'id', 'messageId', 'ID'))
  const fromMe = bool(g(meta, 'fromMe', 'IsFromMe', 'isFromMe', 'from_me'))
  // D-API's documented shape: from: { jid, name } (and to: {…} on own messages).
  const jidOf = (v: unknown) => str(v) ?? str(g(v, 'jid', 'id'))
  let chat =
    jidOf(g(meta, 'remoteJid', 'chatId', 'chat', 'chat_jid')) ??
    (fromMe ? jidOf(g(meta, 'to', 'recipient')) : undefined) ??
    jidOf(g(meta, 'from', 'jid', 'sender'))
  if (!id || !chat) return null

  // Privacy (@lid) chats: use the phone-number alternative when given.
  if (chat.endsWith('@lid')) {
    chat = str(g(meta, 'remoteJidAlt', 'senderPn', 'chatPn', 'senderAlt', 'participantPn')) ?? chat
  }
  if (!isPhoneJid(chat.includes('@') ? chat : `${chat}@s.whatsapp.net`)) return null
  if (bool(g(meta, 'isGroup', 'IsGroup', 'is_group'))) return null

  const content = g(raw, 'message')
  const body = isObj(content) ? fromProto(sessionId, content) : fromFlat(sessionId, raw)
  if (!body) return null

  return {
    id,
    chatJid: chat,
    fromMe,
    pushName:
      str(g(raw, 'pushName', 'senderName', 'notifyName', 'from_name')) ??
      str(g(g(raw, 'from'), 'name')) ??
      str(g(meta, 'PushName', 'pushName', 'senderName')),
    timestamp: seconds(g(raw, 'messageTimestamp', 'timestamp') ?? g(meta, 'Timestamp', 'timestamp')),
    message: { ...body, id, from: digits(chat), timestamp: '' } as WhatsAppMessage,
  }
}

// ------------------------------------------------------------
// Delivery receipts
// ------------------------------------------------------------

function receiptStatus(v: unknown): string | null {
  const n = num(v)
  if (n !== undefined) return n >= 4 ? 'read' : n === 3 ? 'delivered' : n === 2 ? 'sent' : n === 0 ? 'failed' : null
  const s = str(v)?.toLowerCase()
  if (!s) return null
  if (s.includes('read') || s.includes('played') || s.includes('view')) return 'read'
  if (s.includes('deliver')) return 'delivered'
  if (s.includes('server') || s === 'sent') return 'sent'
  if (s.includes('error') || s.includes('fail')) return 'failed'
  return null
}

type MetaStatus = NonNullable<WhatsAppWebhookEntry['changes'][number]['value']['statuses']>[number]

function normalizeReceipts(raw: Obj, event: string): MetaStatus[] {
  const out: MetaStatus[] = []
  const key = g(raw, 'key')
  const update = g(raw, 'update')
  const jidOf = (v: unknown) => str(v) ?? str(g(v, 'jid', 'id'))
  const chat = jidOf(g(key, 'remoteJid') ?? g(raw, 'chat', 'chatId', 'Chat', 'remoteJid', 'to', 'recipient', 'from')) ?? ''
  const status =
    receiptStatus(g(update, 'status')) ??
    receiptStatus(g(raw, 'status', 'ack', 'type', 'receiptType', 'Type')) ??
    (event.includes('read') ? 'read' : event.includes('deliver') ? 'delivered' : null)
  if (!status) return out

  const ids = g(raw, 'messageIds', 'MessageIDs', 'ids')
  const list = Array.isArray(ids) ? ids.map(str).filter(Boolean) as string[] : [str(g(key, 'id') ?? g(raw, 'messageId', 'id', 'ID'))].filter(Boolean) as string[]
  const timestamp = seconds(g(raw, 'timestamp', 'Timestamp', 'messageTimestamp'))
  for (const id of list) out.push({ id, status, timestamp, recipient_id: digits(chat) })
  return out
}

// ------------------------------------------------------------
// Entry point
// ------------------------------------------------------------

export interface DapiConnectionEvent {
  status: 'connected' | 'disconnected' | 'connecting' | 'qr_ready' | 'pair_code_ready'
  phone?: string
}

export interface DapiTranslation {
  event: string
  /** Meta webhook body for processWebhook, or null when nothing applies. */
  body: { entry: WhatsAppWebhookEntry[] } | null
  /** ids of fromMe messages, which the route checks against our own sends. */
  echoIds: string[]
  connection: DapiConnectionEvent | null
}

function eventName(payload: Obj): string {
  return (str(g(payload, 'event', 'type', 'eventType', 'action')) ?? '').toLowerCase()
}

function connectionFrom(event: string, data: unknown): DapiConnectionEvent | null {
  const state = (str(g(data, 'status', 'state', 'connection')) ?? '').toLowerCase()
  const looksLikeConnection = /connect|logged|logout|session|qr|pair|state/.test(event)
  if (!looksLikeConnection && !['open', 'close'].includes(state)) return null
  const all = `${event} ${state}`
  const phone = str(g(data, 'phone', 'phoneNumber', 'wid', 'jid', 'me'))
  let status: DapiConnectionEvent['status'] | null = null
  if (/disconnect|logged_?out|logout|close|unpaired|banned/.test(all)) status = 'disconnected'
  else if (/qr/.test(all)) status = 'qr_ready'
  else if (/pair/.test(all)) status = 'pair_code_ready'
  else if (/connected|open|ready|logged_?in/.test(all)) status = 'connected'
  else if (/connecting/.test(all)) status = 'connecting'
  return status ? { status, phone: phone ? digits(phone) : undefined } : null
}

/** Message-like objects inside a payload: arrays, `messages`, or the data itself. */
function candidates(data: unknown): Obj[] {
  if (Array.isArray(data)) return data.filter(isObj)
  if (!isObj(data)) return []
  const messages = g(data, 'messages')
  if (Array.isArray(messages)) return messages.filter(isObj)
  const message = g(data, 'message')
  // { message: { key, message } } wrapper, as opposed to Baileys' own `message` content.
  if (isObj(message) && (g(message, 'key') || g(message, 'info') || g(message, 'messageId'))) return [message]
  return [data]
}

export function translateDapiWebhook(payload: unknown, phoneNumberId: string): DapiTranslation {
  const root = isObj(payload) ? payload : { data: payload }
  const event = eventName(root)
  const data = g(root, 'data', 'payload', 'body') ?? root
  const sessionId = phoneNumberId.slice('dapi:'.length)

  const connection = connectionFrom(event, data)
  const metadata = { display_phone_number: '', phone_number_id: phoneNumberId }
  const changes: WhatsAppWebhookEntry['changes'] = []
  const echoIds: string[] = []

  const isReceipt =
    /receipt|ack|update|status|delivered|\.read$/.test(event) && !/upsert|received|message\.new|messages?$/.test(event)

  if (isReceipt) {
    const statuses = candidates(data).flatMap((c) => normalizeReceipts(c, event))
    if (statuses.length) {
      changes.push({ field: 'messages', value: { messaging_product: 'whatsapp', metadata, statuses } })
    }
  } else if (!connection) {
    const inbound: WhatsAppMessage[] = []
    const contacts: NonNullable<WhatsAppWebhookEntry['changes'][number]['value']['contacts']> = []
    const echoes: Array<WhatsAppMessage & { to: string }> = []

    for (const c of candidates(data)) {
      const n = normalizeMessage(sessionId, c)
      if (!n) continue
      const message = { ...n.message, timestamp: n.timestamp }
      if (n.fromMe) {
        // Sent from the phone (or by us): the customer is the chat.
        const { from: _from, ...rest } = message
        void _from
        echoes.push({ ...rest, to: digits(n.chatJid) })
        echoIds.push(n.id)
      } else {
        inbound.push(message)
        contacts.push({ wa_id: digits(n.chatJid), profile: { name: n.pushName } })
      }
    }

    if (inbound.length) {
      changes.push({ field: 'messages', value: { messaging_product: 'whatsapp', metadata, contacts, messages: inbound } })
    }
    if (echoes.length) {
      changes.push({
        field: 'smb_message_echoes',
        value: { messaging_product: 'whatsapp', metadata, message_echoes: echoes } as never,
      })
    }
  }

  return {
    event,
    body: changes.length ? { entry: [{ id: 'dapi', changes }] } : null,
    echoIds,
    connection,
  }
}
