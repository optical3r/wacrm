import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { parseTypedPhone } from '@/lib/inbox/typed-phone'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

// "Conversar com <número>" in the inbox search, and the "Nova conversa"
// dialog: find or create the contact and its single conversation in the
// active workspace, then the inbox opens it. Nothing is sent here: on
// Starter the attendant writes freely, on Pro the thread has no 24h
// window yet so the composer only offers a template.
//
// Runs under the caller's RLS, like the Contact detail → template send.
// An attendant who opens a chat owns it, so they can see it (migration
// 057). A chat that already exists but belongs to someone the attendant
// can't see is refused instead of being taken over.
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId, role } = await requireRole('agent')

    const limit = checkRateLimit(`start-conversation:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as
      | { phone?: unknown; name?: unknown }
      | null
    const phone = parseTypedPhone(typeof body?.phone === 'string' ? body.phone : null)
    if (!phone) {
      return NextResponse.json({ error: t('startConversation.badPhone') }, { status: 400 })
    }
    const name =
      typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : null

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .limit(1)
      .maybeSingle()
    if (!config) {
      return NextResponse.json({ error: t('startConversation.noNumber') }, { status: 400 })
    }

    // ---- contact ----------------------------------------------
    let contactId: string
    let contactCreated = false
    const existing = await findExistingContact(supabase, accountId, phone)
    if (existing) {
      contactId = existing.id
      // Typed a name for a contact saved only as its number: keep it.
      if (name && (!existing.name || existing.name === existing.phone)) {
        await supabase
          .from('contacts')
          .update({ name, updated_at: new Date().toISOString() })
          .eq('id', existing.id)
      }
    } else {
      const { data: created, error } = await supabase
        .from('contacts')
        .insert({ account_id: accountId, user_id: userId, phone, name: name || phone })
        .select('id')
        .single()
      if (error || !created) {
        if (isUniqueViolation(error)) {
          return NextResponse.json({ error: t('startConversation.otherAgent') }, { status: 409 })
        }
        console.error('[start-conversation] contact create error:', error?.message)
        return NextResponse.json({ error: t('startConversation.failed') }, { status: 500 })
      }
      contactId = created.id
      contactCreated = true
    }

    // ---- conversation -----------------------------------------
    const { data: convs } = await supabase
      .from('conversations')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true })
      .limit(1)
    if (convs && convs.length > 0) {
      return NextResponse.json({ conversation_id: convs[0].id, created: false, contact_created: contactCreated })
    }

    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .insert({
        account_id: accountId,
        user_id: userId,
        contact_id: contactId,
        ...(role === 'agent' ? { assigned_agent_id: userId } : {}),
      })
      .select('id')
      .single()
    if (convErr || !conv) {
      if (isUniqueViolation(convErr)) {
        return NextResponse.json({ error: t('startConversation.otherAgent') }, { status: 409 })
      }
      console.error('[start-conversation] conversation create error:', convErr?.message)
      return NextResponse.json({ error: t('startConversation.failed') }, { status: 500 })
    }

    return NextResponse.json({ conversation_id: conv.id, created: true, contact_created: contactCreated })
  } catch (error) {
    console.error('Error in start conversation POST:', error)
    return toErrorResponse(error)
  }
}
