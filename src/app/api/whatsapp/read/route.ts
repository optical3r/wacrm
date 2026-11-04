import { NextResponse } from 'next/server'
import { createClient as createAdminClient, type SupabaseClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { markConversationReadOnWhatsApp } from '@/lib/whatsapp/mark-read'

/**
 * POST /api/whatsapp/read  { conversation_id }  (agent+)
 *
 * The inbox opened a chat: mark the customer's pending messages as read
 * on WhatsApp too (blue ticks on the customer's side, cleared on the
 * phone). Visibility is checked with the caller's own RLS client first.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _admin: SupabaseClient<any> | null = null
function supabaseAdmin() {
  if (!_admin) {
    _admin = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  }
  return _admin
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit(`wa-read:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { conversation_id?: unknown } | null
    const conversationId = typeof body?.conversation_id === 'string' ? body.conversation_id : null
    if (!conversationId) return NextResponse.json({ error: 'conversation_id é obrigatório.' }, { status: 400 })

    const { data: visible } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!visible) return NextResponse.json({ error: 'Conversa não encontrada.' }, { status: 404 })

    const marked = await markConversationReadOnWhatsApp(supabaseAdmin(), accountId, conversationId)
    return NextResponse.json({ ok: true, marked })
  } catch (err) {
    return toErrorResponse(err)
  }
}
