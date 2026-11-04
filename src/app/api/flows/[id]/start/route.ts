import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { startFlowManually } from '@/lib/flows/engine'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * POST /api/flows/[id]/start
 *
 * Body: { conversation_id: string }
 *
 * Starts an active flow for the contact of an inbox conversation, on
 * an agent's request ("Iniciar fluxo" in the conversation header).
 *
 * The conversation is loaded with the caller's RLS client, so an
 * attendant can only start a flow on a conversation they can see.
 * Groups are refused: flows never run on WhatsApp groups. The engine
 * refuses a contact who is already in a flow.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  try {
    const { supabase, accountId } = await requireRole('agent')

    const body = (await request.json().catch(() => null)) as
      | { conversation_id?: unknown }
      | null
    const conversationId =
      typeof body?.conversation_id === 'string' ? body.conversation_id : ''
    if (!conversationId) {
      return NextResponse.json(
        { error: t('common.conversationNotFound') },
        { status: 400 },
      )
    }

    const { data: conv } = await supabase
      .from('conversations')
      .select('id, contact_id, contact:contacts(is_group)')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!conv || !conv.contact_id) {
      return NextResponse.json(
        { error: t('common.conversationNotFound') },
        { status: 404 },
      )
    }
    const contact = (conv as { contact?: { is_group?: boolean } | { is_group?: boolean }[] | null }).contact
    const isGroup = Array.isArray(contact) ? contact[0]?.is_group : contact?.is_group
    if (isGroup) {
      return NextResponse.json({ error: t('flows.startGroup') }, { status: 400 })
    }

    const result = await startFlowManually({
      accountId,
      flowId: id,
      conversationId: conv.id,
      contactId: conv.contact_id,
    })
    if (!result.ok) {
      const map = {
        flow_not_found: { key: 'common.notFound', status: 404 },
        flow_inactive: { key: 'flows.startInactive', status: 409 },
        already_in_flow: { key: 'flows.startAlreadyInFlow', status: 409 },
        start_failed: { key: 'flows.startFailed', status: 500 },
      } as const
      const m = map[result.reason]
      return NextResponse.json(
        { error: t(m.key), reason: result.reason },
        { status: m.status },
      )
    }
    return NextResponse.json({ ok: true, flow_run_id: result.flow_run_id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
