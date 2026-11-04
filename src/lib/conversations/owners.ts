import type { SupabaseClient } from '@supabase/supabase-js'
import { soleChannelMember } from '@/lib/whatsapp/channels'

/**
 * Lead owners (migration 057). A conversation can have several owners
 * (conversations.owner_ids; assigned_agent_id mirrors the first one).
 * A database trigger keeps an owned lead from being reassigned by the
 * automatic paths, so these helpers only ever fill leads nobody owns.
 * Service-role client only.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any>

/**
 * Give a lead nobody owns to the next attendant of the account's
 * rotation: among the attendants linked to `channelId` when any of them
 * is in the rotation, else among all of it. Null when the rotation is
 * off, nobody is eligible or the lead already has an owner.
 */
export async function assignByRotation(
  db: Db,
  conversationId: string,
  channelId?: string | null,
): Promise<string | null> {
  let candidates: string[] = []
  if (channelId) {
    const { data } = await db.from('whatsapp_channel_members').select('user_id').eq('channel_id', channelId)
    candidates = ((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id)
  }
  const { data, error } = await db.rpc('assign_lead_by_rotation', {
    p_conversation_id: conversationId,
    p_candidates: candidates,
  })
  if (error) {
    // Before migration 057 the function does not exist yet.
    console.warn('[owners] rotation skipped:', error.message)
    return null
  }
  return typeof data === 'string' ? data : null
}

/**
 * A customer wrote: give the lead an owner if it has none. The rotation
 * first; otherwise, on Starter, the number's attendant when exactly one
 * is linked to it. Skipped when the AI auto-reply is on, since the bot
 * only answers leads nobody owns (its handoff uses the rotation).
 */
export async function assignNewLead(
  db: Db,
  args: { accountId: string; conversationId: string; channelId: string | null; aiAutoReply: boolean; plan: string | null },
): Promise<string | null> {
  if (args.aiAutoReply) return null
  const rotated = await assignByRotation(db, args.conversationId, args.channelId)
  if (rotated) return rotated
  if (args.plan !== 'starter' || !args.channelId) return null
  const attendant = await soleChannelMember(db, args.channelId)
  if (!attendant) return null
  await db
    .from('conversations')
    .update({ assigned_agent_id: attendant })
    .eq('id', args.conversationId)
    .is('assigned_agent_id', null)
  return attendant
}
