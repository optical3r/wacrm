/**
 * Pure channel-selection rules (no server imports, safe in the browser).
 * See channels.ts for the full picture.
 */

import type { AccountRole } from '@/lib/auth/roles'

/** The whatsapp_config fields the rules read. */
export interface ChannelLike {
  id: string
  owner_user_id: string | null
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
  no_own_channel: 'Conecte o seu WhatsApp em Configurações para responder.',
  channel_disconnected: 'Este número está desconectado. Reconecte o WhatsApp para enviar.',
  channel_forbidden: 'Você só pode enviar pelo seu próprio número.',
  channel_not_found: 'Número não encontrado nesta conta.',
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
}

const isConnected = (c: Pick<ChannelLike, 'status'>) => c.status === 'connected'

/**
 * Choose the channel a send goes through. Pure; throws ChannelError.
 */
export function pickSendChannel<T extends ChannelLike>(channels: T[], ctx: PickContext): T {
  const sorted = sortChannels(channels)
  if (sorted.length === 0) throw channelError('whatsapp_not_configured')

  // Pro (and any non-Starter account): the single official number.
  if (ctx.plan !== 'starter') return sorted[0]

  if (ctx.role === 'agent') {
    const own = sorted.find((c) => c.owner_user_id && c.owner_user_id === ctx.userId)
    if (ctx.requestedChannelId && ctx.requestedChannelId !== own?.id) throw channelError('channel_forbidden')
    if (!own) throw channelError('no_own_channel')
    if (!isConnected(own)) throw channelError('channel_disconnected')
    return own
  }

  if (ctx.requestedChannelId) {
    const chosen = sorted.find((c) => c.id === ctx.requestedChannelId)
    if (!chosen) throw channelError('channel_not_found')
    if (!isConnected(chosen)) throw channelError('channel_disconnected')
    return chosen
  }

  const connected = sorted.filter(isConnected)
  const byOwner = (uid?: string | null) => (uid ? connected.find((c) => c.owner_user_id === uid) : undefined)
  const pick =
    byOwner(ctx.assignedAgentId) ??
    connected.find((c) => c.id === ctx.lastChannelId) ??
    byOwner(ctx.userId) ??
    connected[0]
  if (pick) return pick
  throw channelError(sorted.length ? 'channel_disconnected' : 'whatsapp_not_configured')
}
