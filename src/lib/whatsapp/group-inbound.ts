/**
 * WhatsApp groups on the Starter plan (migration 052).
 *
 * D-API delivers group messages to every connected number that is in the
 * group. Each group is one contact (is_group, keyed by wa_group_id) with
 * one conversation per account; a message is stored once (same WhatsApp
 * id on every number) and the conversation's channel_ids collects every
 * number that is in the group, which drives who sees it (RLS, 051) and
 * which numbers can write to it.
 *
 * Deliberately separate from processMessage: groups are not customers,
 * so nothing here runs flows, automations, AI replies, auto-assignment,
 * broadcast reply tracking or public webhooks.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from './encryption'
import { dapiClient, hasDapiApiKey, sessionIdFrom } from './dapi'
import type { DapiGroupMessage } from './dapi-webhook'
import { lookupInternalIdByMetaId, parseMessageContent } from './webhook-processor'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any>

const ALLOWED_CONTENT_TYPES = new Set(['text', 'image', 'document', 'audio', 'video', 'location', 'template', 'interactive'])

interface GroupChannel {
  id: string
  account_id: string
  user_id: string
  owner_user_id: string | null
  read_groups: boolean
  access_token: string
  mirror_inbound_media: boolean | null
}

/** The number a D-API session belongs to, when it reads groups on a Starter account. */
async function groupChannel(admin: Admin, phoneNumberId: string): Promise<GroupChannel | null> {
  const { data } = await admin
    .from('whatsapp_config')
    .select('id, account_id, user_id, owner_user_id, read_groups, access_token, mirror_inbound_media')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle()
  const channel = data as GroupChannel | null
  if (!channel?.read_groups) return null
  const { data: account } = await admin.from('accounts').select('plan, status').eq('id', channel.account_id).maybeSingle()
  const acc = account as { plan?: string; status?: string } | null
  if (acc?.plan !== 'starter') return null
  if (acc.status && acc.status !== 'active') return null
  return channel
}

/** First non-empty `subject` / `name` in a D-API answer, however it is wrapped. */
function findGroupName(v: unknown, depth = 0): string | null {
  if (depth > 4 || typeof v !== 'object' || v === null) return null
  if (Array.isArray(v)) {
    for (const x of v) {
      const found = findGroupName(x, depth + 1)
      if (found) return found
    }
    return null
  }
  const o = v as Record<string, unknown>
  for (const key of ['subject', 'groupName', 'group_name', 'name']) {
    const x = o[key]
    if (typeof x === 'string' && x.trim()) return x.trim()
  }
  for (const x of Object.values(o)) {
    const found = findGroupName(x, depth + 1)
    if (found) return found
  }
  return null
}

/**
 * Group name from D-API: messages carry group_name, but D-API sends it
 * empty. Best effort; the answer's shape is logged once per lookup so
 * it can be checked in dapi_webhook_log.
 */
async function fetchGroupName(admin: Admin, phoneNumberId: string, groupJid: string): Promise<string | null> {
  if (!hasDapiApiKey()) return null
  const sessionId = sessionIdFrom(phoneNumberId)
  const client = dapiClient()
  try {
    const info = await client.groups.getInfo(groupJid, { sessionId })
    const name = findGroupName(info)
    if (name) return name
    await admin.from('dapi_webhook_log').insert({ session_id: sessionId, event: 'debug:group_info', payload: { info } })
  } catch (err) {
    console.warn('[groups] group info failed:', err instanceof Error ? err.message : err)
  }
  // Fallback: the session's group list.
  try {
    const list = (await client.groups.list({ sessionId })) as unknown
    const arr = Array.isArray(list)
      ? list
      : ((list as Record<string, unknown>)?.data ?? (list as Record<string, unknown>)?.groups ?? []) as unknown[]
    const match = (Array.isArray(arr) ? arr : []).find((g) => {
      const o = g as Record<string, unknown>
      return [o.id, o.jid, o.groupId, o.JID].some((id) => typeof id === 'string' && (id === groupJid || `${id}@g.us` === groupJid))
    })
    const name = findGroupName(match ?? null)
    if (!name) await admin.from('dapi_webhook_log').insert({ session_id: sessionId, event: 'debug:group_list', payload: { list } })
    return name
  } catch (err) {
    console.warn('[groups] group list failed:', err instanceof Error ? err.message : err)
    return null
  }
}

const NAME_RETRY_MS = 10 * 60 * 1000

interface GroupContact {
  id: string
  name: string | null
  group_hidden_at: string | null
}

async function findOrCreateGroupContact(
  admin: Admin,
  channel: GroupChannel,
  phoneNumberId: string,
  m: DapiGroupMessage,
): Promise<GroupContact | null> {
  const find = () =>
    admin
      .from('contacts')
      .select('id, name, group_hidden_at, updated_at')
      .eq('account_id', channel.account_id)
      .eq('wa_group_id', m.groupJid)
      .maybeSingle()

  const { data: existing } = await find()
  if (existing) {
    const row = existing as GroupContact & { updated_at?: string | null }
    let name = m.groupName ?? null
    // No name yet: ask D-API again, at most every few minutes.
    if (!name && !row.name && Date.now() - Date.parse(row.updated_at ?? '1970-01-01') > NAME_RETRY_MS) {
      name = await fetchGroupName(admin, phoneNumberId, m.groupJid)
      if (!name) await admin.from('contacts').update({ updated_at: new Date().toISOString() }).eq('id', row.id)
    }
    if (name && name !== row.name) {
      await admin.from('contacts').update({ name, updated_at: new Date().toISOString() }).eq('id', row.id)
      row.name = name
    }
    return row
  }

  const name = m.groupName ?? (await fetchGroupName(admin, phoneNumberId, m.groupJid))
  const { data: created, error } = await admin
    .from('contacts')
    .insert({
      account_id: channel.account_id,
      user_id: channel.user_id,
      phone: m.groupJid,
      name: name ?? null,
      is_group: true,
      wa_group_id: m.groupJid,
    })
    .select('id, name, group_hidden_at')
    .single()
  if (error) {
    // Another number of the account created it at the same moment.
    const { data: raced } = await find()
    if (raced) return raced as GroupContact
    console.error('[groups] contact insert failed:', error.message)
    return null
  }
  return created as GroupContact
}

interface GroupConversation {
  id: string
  status: string | null
  channel_ids: string[] | null
}

async function findOrCreateGroupConversation(
  admin: Admin,
  channel: GroupChannel,
  contactId: string,
): Promise<GroupConversation | null> {
  const find = () =>
    admin
      .from('conversations')
      .select('id, status, channel_ids')
      .eq('account_id', channel.account_id)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()

  const { data: existing } = await find()
  if (existing) return existing as GroupConversation
  const { data: created, error } = await admin
    .from('conversations')
    .insert({
      account_id: channel.account_id,
      user_id: channel.user_id,
      contact_id: contactId,
      is_group: true,
      channel_ids: [channel.id],
      last_channel_id: channel.id,
    })
    .select('id, status, channel_ids')
    .single()
  if (error) {
    const { data: raced } = await find()
    if (raced) return raced as GroupConversation
    console.error('[groups] conversation insert failed:', error.message)
    return null
  }
  return created as GroupConversation
}

/** Store one batch of group messages received by one number. */
export async function handleDapiGroupMessages(
  admin: Admin,
  phoneNumberId: string,
  messages: DapiGroupMessage[],
): Promise<void> {
  if (!messages.length) return
  const channel = await groupChannel(admin, phoneNumberId)
  if (!channel) return
  const accessToken = decrypt(channel.access_token)

  for (const m of messages) {
    try {
      // Reactions in groups are not shown yet.
      if (m.message.type === 'reaction') continue

      const contact = await findOrCreateGroupContact(admin, channel, phoneNumberId, m)
      if (!contact || contact.group_hidden_at) continue
      const conversation = await findOrCreateGroupConversation(admin, channel, contact.id)
      if (!conversation) continue

      // This number is in the group: it can see and write to it.
      if (!(conversation.channel_ids ?? []).includes(channel.id)) {
        await admin.rpc('note_conversation_channel', {
          p_conversation_id: conversation.id,
          p_channel_id: channel.id,
        })
      }

      const { contentText, mediaUrl, mediaType, interactiveReplyId } = await parseMessageContent(
        m.message,
        accessToken,
        channel.mirror_inbound_media !== false ? { accountId: channel.account_id } : null,
      )
      const contentType = ALLOWED_CONTENT_TYPES.has(m.message.type)
        ? m.message.type
        : m.message.type === 'sticker'
          ? 'image'
          : 'text'
      const replyTo = m.message.context?.id ? await lookupInternalIdByMetaId(m.message.context.id, conversation.id) : null
      const createdAt = new Date(parseInt(m.timestamp) * 1000).toISOString()

      const { data: inserted, error } = await admin
        .from('messages')
        .upsert(
          {
            conversation_id: conversation.id,
            sender_type: m.fromMe ? 'agent' : 'customer',
            content_type: contentType,
            content_text: contentText,
            media_url: mediaUrl,
            media_type: mediaType,
            message_id: m.id,
            status: m.fromMe ? 'sent' : 'delivered',
            created_at: createdAt,
            reply_to_message_id: replyTo,
            interactive_reply_id: interactiveReplyId,
            channel_id: channel.id,
            // Typed on the phone of this number's owner.
            sender_id: m.fromMe ? channel.owner_user_id : null,
            // Never null on a group message: it is what marks one (no notifications).
            sender_wa_id: m.senderId ?? 'unknown',
            sender_name: m.senderName ?? null,
          },
          { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
        )
        .select('id')
      if (error) {
        console.error('[groups] message insert failed:', error.message)
        continue
      }
      // Already stored through another number of the account (or a replay).
      if (!inserted || inserted.length === 0) continue

      const preview = contentText || `[${m.message.type}]`
      if (m.fromMe) {
        await admin
          .from('conversations')
          .update({ last_message_text: preview, last_message_at: createdAt, updated_at: new Date().toISOString() })
          .eq('id', conversation.id)
      } else {
        await admin.rpc('bump_conversation_on_inbound', {
          p_conversation_id: conversation.id,
          p_last_message_text: m.senderName ? `${m.senderName}: ${preview}` : preview,
        })
        if (conversation.status === 'closed') {
          await admin.from('conversations').update({ status: 'open' }).eq('id', conversation.id).eq('status', 'closed')
        }
      }
    } catch (err) {
      console.error('[groups] message failed:', err instanceof Error ? err.message : err)
    }
  }
}
