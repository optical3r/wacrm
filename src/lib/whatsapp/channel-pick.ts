/**
 * Pure channel-selection rules (no server imports, safe in the browser).
 * See channels.ts for the full picture.
 */

import type { AccountRole } from '@/lib/auth/roles'

/** The whatsapp_config fields the rules read. */
export interface ChannelLike {
  id: string
  /** Attendants linked to the number (migration 056). */
  member_ids?: string[] | null
  status: string
  is_default: boolean
  created_at?: string | null
}

export type ChannelErrorCode =
  | 'whatsapp_not_configured'
  | 'no_own_channel'
  | 'channel_disconnected'
  | 'channel_forbidden'
  | 'channel_not_found'
  | 'not_in_group'

export class ChannelError extends Error {
  readonly code: ChannelErrorCode
  constructor(code: ChannelErrorCode, message: string) {
    super(message)
    this.name = 'ChannelError'
    this.code = code
  }
}

const MESSAGES: Record<ChannelErrorCode, string> = {
  whatsapp_not_configured: 'WhatsApp not configured. Please set up your WhatsApp integration first.',
  no_own_channel: 'Você ainda não está vinculado a nenhum número. Peça ao administrador da conta.',
  channel_disconnected: 'Este número está desconectado. Reconecte o WhatsApp para enviar.',
  channel_forbidden: 'Você só pode enviar pelos números vinculados a você.',
  channel_not_found: 'Número não encontrado nesta conta.',
  not_in_group: 'Nenhum dos seus números está neste grupo. Só quem está no grupo pode responder.',
}

export function channelError(code: ChannelErrorCode): ChannelError {
  return new ChannelError(code, MESSAGES[code])
}

/** Default first, then oldest: the order every "primary number" read uses. */
export function sortChannels<T extends Pick<ChannelLike, 'is_default'> & { created_at?: string | null }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    if (a.is_default !== b.is_default) return a.is_default ? -1 : 1
    return String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
  })
}

export interface PickContext {
  plan: 'starter' | 'pro' | string | null | undefined
  /** Role of the member sending; undefined for automated senders. */
  role?: AccountRole | null
  userId?: string | null
  /** Number explicitly chosen in the composer (owner / admin only). */
  requestedChannelId?: string | null
  /** The conversation's responsible agent. */
  assignedAgentId?: string | null
  /** The last number the customer wrote to. */
  lastChannelId?: string | null
  /**
   * Set for a WhatsApp group (migration 052): the numbers that are in it.
   * Only those can write to the group.
   */
  groupChannelIds?: string[] | null
}

const isConnected = (c: Pick<ChannelLike, 'status'>) => c.status === 'connected'

/** Whether the member is linked to the number. */
export function isChannelMember(c: Pick<ChannelLike, 'member_ids'>, userId?: string | null): boolean {
  return Boolean(userId && c.member_ids?.includes(userId))
}

/**
 * Choose the channel a send goes through. Pure; throws ChannelError.
 */
export function pickSendChannel<T extends ChannelLike>(channels: T[], ctx: PickContext): T {
  const all = sortChannels(channels)
  if (all.length === 0) throw channelError('whatsapp_not_configured')
  const inGroup = ctx.groupChannelIds ? new Set(ctx.groupChannelIds) : null
  const sorted = inGroup ? all.filter((c) => inGroup.has(c.id)) : all
  if (inGroup) {
    if (sorted.length === 0) throw channelError('not_in_group')
    if (ctx.requestedChannelId && !inGroup.has(ctx.requestedChannelId)) throw channelError('not_in_group')
    if (ctx.role === 'agent' && !sorted.some((c) => isChannelMember(c, ctx.userId))) {
      throw channelError(all.some((c) => isChannelMember(c, ctx.userId)) ? 'not_in_group' : 'no_own_channel')
    }
  }

  // Pro (and any non-Starter account): the single official number.
  if (ctx.plan !== 'starter') return sorted[0]

  if (ctx.role === 'agent') {
    // An attendant answers through the numbers linked to them: the one
    // they chose, else the one the customer last wrote to, else the first.
    const mine = sorted.filter((c) => isChannelMember(c, ctx.userId))
    if (mine.length === 0) throw channelError('no_own_channel')
    if (ctx.requestedChannelId) {
      const chosen = mine.find((c) => c.id === ctx.requestedChannelId)
      if (!chosen) throw channelError('channel_forbidden')
      if (!isConnected(chosen)) throw channelError('channel_disconnected')
      return chosen
    }
    const live = mine.filter(isConnected)
    const pick = live.find((c) => c.id === ctx.lastChannelId) ?? live[0]
    if (!pick) throw channelError('channel_disconnected')
    return pick
  }

  if (ctx.requestedChannelId) {
    const chosen = sorted.find((c) => c.id === ctx.requestedChannelId)
    if (!chosen) throw channelError('channel_not_found')
    if (!isConnected(chosen)) throw channelError('channel_disconnected')
    return chosen
  }

  const connected = sorted.filter(isConnected)
  const last = connected.find((c) => c.id === ctx.lastChannelId)
  const ofMember = (uid?: string | null) => connected.find((c) => isChannelMember(c, uid))
  // The number the customer last wrote to, unless the responsible
  // attendant is not linked to it.
  const pick =
    (last && (!ctx.assignedAgentId || isChannelMember(last, ctx.assignedAgentId)) ? last : undefined) ??
    ofMember(ctx.assignedAgentId) ??
    last ??
    ofMember(ctx.userId) ??
    connected[0]
  if (pick) return pick
  throw channelError(sorted.length ? 'channel_disconnected' : 'whatsapp_not_configured')
}
