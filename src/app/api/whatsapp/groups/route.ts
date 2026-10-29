import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * WhatsApp groups the account has hidden (Starter, migration 052). A
 * hidden group drops out of the inbox and its new messages are no longer
 * stored; showing it again resumes from the next message.
 *
 *   GET   → { groups: [{ id, name, hidden_at }] } hidden groups.
 *   PATCH → { contact_id, hidden: boolean } hides or shows one group.
 *
 * Owner and admin only.
 */

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { data, error } = await supabase
      .from('contacts')
      .select('id, name, group_hidden_at')
      .eq('account_id', accountId)
      .eq('is_group', true)
      .not('group_hidden_at', 'is', null)
      .order('name', { ascending: true })
    if (error) throw error
    return NextResponse.json({
      groups: ((data ?? []) as Array<{ id: string; name: string | null; group_hidden_at: string }>).map((g) => ({
        id: g.id,
        name: g.name,
        hidden_at: g.group_hidden_at,
      })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request) {
  try {
    const { supabase, accountId, account } = await requireRole('admin')
    if (account.plan !== 'starter') {
      return NextResponse.json({ error: 'Grupos são exclusivos do plano Starter.' }, { status: 403 })
    }
    const body = (await request.json().catch(() => ({}))) as { contact_id?: string; hidden?: boolean }
    if (!body.contact_id || typeof body.hidden !== 'boolean') {
      return NextResponse.json({ error: 'Informe o grupo e se ele fica oculto.' }, { status: 400 })
    }
    const { data, error } = await supabase
      .from('contacts')
      .update({ group_hidden_at: body.hidden ? new Date().toISOString() : null })
      .eq('id', body.contact_id)
      .eq('account_id', accountId)
      .eq('is_group', true)
      .select('id')
    if (error) throw error
    if (!data?.length) return NextResponse.json({ error: 'Grupo não encontrado.' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
