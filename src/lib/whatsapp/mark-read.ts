import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from './encryption'
import { dapiMarkRead, isDapiPhoneNumberId } from './dapi'
import { markMessageRead } from './meta-api'
import { listChannels } from './channels'
import { resolveContactSendTarget } from './wa-identity'

/**
 * Read status kept in step between the CRM and WhatsApp.
 *
 *   CRM → WhatsApp: opening a chat marks the customer's pending messages
 *   as read on the phone (blue ticks), through the number each one came
 *   in on. D-API marks the exact ids; the official API marks the newest
 *   one and WhatsApp treats every earlier message as read too.
 *
 *   WhatsApp → CRM: reading on the phone makes D-API send a read receipt
 *   for the customer's message; see applyPhoneRead.
 *
 * Service-role client only; callers check the user may see the chat.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any>

/** How far back to look for unread customer messages. */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const MAX_MESSAGES = 100

interface PendingRow {
  id: string
  message_id: string
  channel_id: string | null
  sender_wa_id: string | null
  created_at: string
}

/** A group participant as D-API addresses them. */
export function participantJid(waId: string | null | undefined): string | null {
  const v = (waId ?? '').trim()
  if (!v || v === 'unknown') return null
  if (v.includes('@')) return v
  const digits = v.replace(/\D/g, '')
  return digits ? `${digits}@s.whatsapp.net` : null
}

/**
 * Mark a chat's unread customer messages as read on WhatsApp. Best
 * effort: a number that fails is skipped (and its messages stay pending
 * for the next open). Returns how many messages were marked.
 */
export async function markConversationReadOnWhatsApp(
  db: Db,
  accountId: string,
  conversationId: string,
): Promise<number> {
  const { data: conv } = await db
    .from('conversations')
    .select('id, last_channel_id, is_group, contact:contacts(phone, wa_user_id, is_group, wa_group_id)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!conv) return 0
  const row = conv as unknown as {
    last_channel_id: string | null
    is_group?: boolean
    contact: { phone?: string | null; wa_user_id?: string | null; is_group?: boolean | null; wa_group_id?: string | null } | null
  }
  const target = resolveContactSendTarget(row.contact)
  if (!target) {
    console.info(`[mark-read] ${conversationId}: contato sem destino`)
    return 0
  }

  const since = new Date(Date.now() - LOOKBACK_MS).toISOString()
  const { data: pending, error: pendingErr } = await db
    .from('messages')
    .select('id, message_id, channel_id, sender_wa_id, created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .in('status', ['sent', 'delivered'])
    .not('message_id', 'is', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(MAX_MESSAGES)
  if (pendingErr) console.warn('[mark-read] pending query failed:', pendingErr.message)
  const rows = (pending ?? []) as PendingRow[]
  if (rows.length === 0) return 0

  const channels = await listChannels(db, accountId)
  const byId = new Map(channels.map((c) => [c.id, c]))
  const fallback = (row.last_channel_id && byId.get(row.last_channel_id)) || channels[0]

  const groups = new Map<string, PendingRow[]>()
  for (const m of rows) {
    const channel = (m.channel_id && byId.get(m.channel_id)) || fallback
    if (!channel) continue
    const list = groups.get(channel.id) ?? []
    list.push(m)
    groups.set(channel.id, list)
  }

  const done: string[] = []
  for (const [channelId, list] of groups) {
    const channel = byId.get(channelId)
    if (!channel || channel.status !== 'connected') {
      console.info(`[mark-read] ${conversationId}: número ${channelId} não conectado, ${list.length} pendentes`)
      continue
    }
    try {
      if (isDapiPhoneNumberId(channel.phone_number_id)) {
        // Groups: one call per participant who wrote.
        const batches = new Map<string, PendingRow[]>()
        for (const m of list) {
          const key = row.is_group ? participantJid(m.sender_wa_id) ?? '' : ''
          batches.set(key, [...(batches.get(key) ?? []), m])
        }
        for (const [participant, batch] of batches) {
          await dapiMarkRead({
            phoneNumberId: channel.phone_number_id,
            to: target.target,
            messageIds: batch.map((m) => m.message_id),
            participant: participant || null,
          })
          done.push(...batch.map((m) => m.id))
        }
      } else {
        // The newest one marks every earlier message too.
        await markMessageRead({
          phoneNumberId: channel.phone_number_id,
          accessToken: decrypt(channel.access_token),
          messageId: list[0].message_id,
        })
        done.push(...list.map((m) => m.id))
      }
    } catch (err) {
      console.warn('[mark-read] number skipped:', err instanceof Error ? err.message : err)
    }
  }

  if (done.length > 0) {
    await db.from('messages').update({ status: 'read' }).in('id', done)
  }
  console.info(`[mark-read] ${conversationId}: ${done.length}/${rows.length} marcadas como lidas no WhatsApp`)
  return done.length
}

/**
 * When the phone read a chat, from a read receipt: the later of the
 * receipt's own time (unix seconds) and the message's time, so a clock
 * skew between the phone and WhatsApp never leaves the message unread.
 */
export function readCutoff(messageCreatedAt: string, receiptSeconds?: string | number | null): string {
  const msg = Date.parse(messageCreatedAt)
  const n = Number(receiptSeconds)
  const receipt = Number.isFinite(n) && n > 0 ? n * 1000 : NaN
  const t = Number.isNaN(receipt) ? msg : Math.max(msg, receipt)
  return new Date(Number.isNaN(t) ? Date.now() : t).toISOString()
}

/**
 * A read receipt came in for one of the customer's messages: this number
 * opened the chat (on the phone, or because the CRM marked it). WhatsApp
 * only sends receipts for some of the messages it shows, often for old
 * ones, so the receipt is taken as "the chat was read up to now":
 * everything the customer sent until the read time counts as read, and
 * the unread count drops to what arrived after it.
 */
export async function applyPhoneRead(
  db: Db,
  messageId: string,
  receiptSeconds?: string | number | null,
): Promise<void> {
  const { data } = await db
    .from('messages')
    .select('conversation_id, created_at')
    .eq('message_id', messageId)
    .eq('sender_type', 'customer')
    .limit(5)
  for (const m of (data ?? []) as Array<{ conversation_id: string; created_at: string }>) {
    const cutoff = readCutoff(m.created_at, receiptSeconds)
    await db
      .from('messages')
      .update({ status: 'read' })
      .eq('conversation_id', m.conversation_id)
      .eq('sender_type', 'customer')
      .in('status', ['sent', 'delivered'])
      .lte('created_at', cutoff)
    const { count } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', m.conversation_id)
      .eq('sender_type', 'customer')
      .gt('created_at', cutoff)
    const remaining = count ?? 0
    await db
      .from('conversations')
      .update({ unread_count: remaining })
      .eq('id', m.conversation_id)
      .gt('unread_count', remaining)
  }
}
