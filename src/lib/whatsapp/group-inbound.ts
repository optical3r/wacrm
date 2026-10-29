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

/** Group name from D-API when the message did not carry one. Best effort. */
async function fetchGroupName(phoneNumberId: string, groupJid: string): Promise<string | null> {
  if (!hasDapiApiKey()) return null
  try {
    const info = (await dapiClient().groups.getInfo(groupJid, { sessionId: sessionIdFrom(phoneNumberId) })) as unknown as Record<
      string,
      unknown
    >
    const inner = (info?.data ?? info) as Record<string, unknown>
    const name = inner?.subject ?? inner?.name
    return typeof name === 'string' && name ? name : null
  } catch (err) {
    console.warn('[groups] group info failed:', err instanceof Error ? err.message : err)
    return null
  }
}

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
      .select('id, name, group_hidden_at')
      .eq('account_id', channel.account_id)
      .eq('wa_group_id', m.groupJid)
      .maybeSingle()

  const { data: existing } = await find()
  if (existing) {
    const row = existing as GroupContact
    if (m.groupName && m.groupName !== row.name) {
      await admin.from('contacts').update({ name: m.groupName, updated_at: new Date().toISOString() }).eq('id', row.id)
      row.name = m.groupName
    }
    return row
  }

  const name = m.groupName ?? (await fetchGroupName(phoneNumberId, m.groupJid))
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
