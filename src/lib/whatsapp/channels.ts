/**
 * WhatsApp channels: the numbers connected to an account.
 *
 * Each whatsapp_config row is a channel (migration 051). Pro accounts
 * have one (the official number). Starter accounts can have one per
 * member, each connected by QR code through D-API and owned by that
 * member. The customer keeps a single conversation; messages record the
 * channel they went through.
 *
 * Who sends through which number (Starter):
 *   - an `agent` always sends through their own number, never another's;
 *   - owner / admin may pick any connected number, and default to the
 *     number of the agent responsible for the chat;
 *   - automated senders (flows, automations, AI, public API) use the
 *     responsible agent's number, then the last number the customer
 *     wrote to, then the account's default.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccountRole } from '@/lib/auth/roles'
import { decrypt } from './encryption'
import { channelError, pickSendChannel, sortChannels } from './channel-pick'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any>

export interface ChannelRow {
  id: string
  account_id: string
  user_id: string
  owner_user_id: string | null
  phone_number_id: string
  access_token: string
  status: string
  label: string | null
  is_default: boolean
  created_at?: string | null
  // Other whatsapp_config columns (waba_id, mirror_inbound_media, …).
  [key: string]: unknown
}

export {
  ChannelError,
  channelError,
  pickSendChannel,
  sortChannels,
  type ChannelErrorCode,
  type PickContext,
} from './channel-pick'

/** Every channel of the account, default first. */
export async function listChannels(db: Db, accountId: string, select = '*'): Promise<ChannelRow[]> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select(select)
    .eq('account_id', accountId)
  if (error) {
    console.error('[channels] list failed:', error.message)
    return []
  }
  return sortChannels((data ?? []) as unknown as ChannelRow[])
}

/**
 * The account's primary number (default, else oldest), or null. For
 * reads that need "a" config: status badges, template/broadcast paths
 * (Pro only, one number), media downloads.
 */
export async function getPrimaryChannel(db: Db, accountId: string, select = '*'): Promise<ChannelRow | null> {
  const rows = await listChannels(db, accountId, select)
  return rows[0] ?? null
}

export interface ResolvedChannel {
  channel: ChannelRow
  channelId: string
  phoneNumberId: string
  accessToken: string
}

export interface ResolveOptions {
  conversationId?: string | null
  /** Used to find the conversation when only the contact is known. */
  contactId?: string | null
  userId?: string | null
  role?: AccountRole | null
  channelId?: string | null
}

/**
 * Load the account's channels, plan and the conversation's routing
 * fields, then pick the channel (see pickSendChannel). Throws
 * ChannelError.
 */
export async function resolveSendChannel(
  db: Db,
  accountId: string,
  opts: ResolveOptions = {},
): Promise<ResolvedChannel> {
  const channels = await listChannels(db, accountId)
  if (channels.length === 0) throw channelError('whatsapp_not_configured')

  let plan: string | null = null
  let assignedAgentId: string | null = null
  let lastChannelId: string | null = null
  let groupChannelIds: string[] | null = null

  if (channels.length > 1 || opts.role === 'agent' || opts.channelId) {
    const { data: account } = await db.from('accounts').select('plan').eq('id', accountId).maybeSingle()
    plan = (account as { plan?: string } | null)?.plan ?? null
  }

  if (plan === 'starter' && (opts.conversationId || opts.contactId)) {
    let query = db
      .from('conversations')
      .select('assigned_agent_id, last_channel_id, is_group, channel_ids')
      .eq('account_id', accountId)
    query = opts.conversationId ? query.eq('id', opts.conversationId) : query.eq('contact_id', opts.contactId!)
    const { data: conv } = await query.limit(1).maybeSingle()
    const row = conv as {
      assigned_agent_id?: string | null
      last_channel_id?: string | null
      is_group?: boolean
      channel_ids?: string[] | null
    } | null
    assignedAgentId = row?.assigned_agent_id ?? null
    lastChannelId = row?.last_channel_id ?? null
    // Groups (migration 052): only numbers that are in the group.
    if (row?.is_group) groupChannelIds = row.channel_ids ?? []
  }

  const channel = pickSendChannel(channels, {
    plan,
    role: opts.role,
    userId: opts.userId,
    requestedChannelId: opts.channelId,
    assignedAgentId,
    lastChannelId,
    groupChannelIds,
  })
  return {
    channel,
    channelId: channel.id,
    phoneNumberId: channel.phone_number_id,
    accessToken: decrypt(channel.access_token),
  }
}
