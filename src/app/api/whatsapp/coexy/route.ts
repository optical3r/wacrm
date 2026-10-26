import { NextResponse } from 'next/server'
import { createClient as createAdminClient, type SupabaseClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { encrypt } from '@/lib/whatsapp/encryption'
import { isCoexy } from '@/lib/whatsapp/provider'
import {
  CoexyApiError,
  createCoexyChannel,
  ensureCoexyWebhook,
  getCoexyChannel,
  hasCoexyApiKey,
  type CoexyChannel,
} from '@/lib/whatsapp/coexy'

/**
 * One-click WhatsApp connection through Coexy (WHATSAPP_PROVIDER=coexy).
 *
 *   GET  → { enabled, channel } — the account's channel and, once the
 *          number is connected in Coexy, saves its credentials into
 *          whatsapp_config so the rest of the app just works.
 *   POST → creates (or reuses) the account's Coexy channel, makes sure
 *          the Coexy webhook points here, and returns the connect_url
 *          where the number owner runs Meta's Embedded Signup.
 *
 * No Meta developer app, token or webhook setup on the user's side.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _admin: SupabaseClient<any> | null = null
function supabaseAdmin() {
  if (!_admin) {
    _admin = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _admin
}

function publicChannel(channel: CoexyChannel, canEdit: boolean) {
  return {
    status: channel.status,
    display_phone_number: channel.display_phone_number,
    // Only admins start or redo the connection.
    connect_url: canEdit && channel.status !== 'active' ? channel.connect_url : null,
  }
}

function coexyFailure(err: unknown) {
  if (err instanceof CoexyApiError) {
    console.error('[coexy] API error:', err.status, err.message)
    return NextResponse.json({ error: err.message }, { status: err.status >= 500 ? 502 : 400 })
  }
  return toErrorResponse(err)
}

/**
 * Mirror the channel into the account's whatsapp_config: credentials
 * once it is active, a disconnected status when Meta revoked it.
 */
async function syncChannel(accountId: string, userId: string, channel: CoexyChannel) {
  const admin = supabaseAdmin()

  if (channel.status === 'disconnected' || channel.status === 'suspended') {
    await admin
      .from('whatsapp_config')
      .update({ status: 'disconnected', updated_at: new Date().toISOString() })
      .eq('account_id', accountId)
      .eq('status', 'connected')
    return null
  }
  if (channel.status !== 'active' || !channel.phone_number_id) return null

  const now = new Date().toISOString()
  const fields = {
    phone_number_id: channel.phone_number_id,
    waba_id: channel.waba_id,
    access_token: encrypt(channel.channel_token),
    status: 'connected',
    connected_at: now,
    registered_at: now,
    subscribed_apps_at: now,
    last_registration_error: null,
    updated_at: now,
  }

  const { data: existing } = await admin
    .from('whatsapp_config')
    .select('id, phone_number_id, status')
    .eq('account_id', accountId)
    .maybeSingle()

  if (existing?.phone_number_id === channel.phone_number_id && existing.status === 'connected') {
    return null
  }

  const { error } = existing
    ? await admin.from('whatsapp_config').update(fields).eq('id', existing.id)
    : await admin.from('whatsapp_config').insert({ ...fields, account_id: accountId, user_id: userId })

  if (error) {
    // 23505: this number is already connected to another account.
    if (error.code === '23505') return 'Este número já está conectado em outra conta.'
    console.error('[coexy] failed to save whatsapp_config:', error.message)
    return 'Não foi possível salvar a conexão.'
  }
  return null
}

export async function GET() {
  try {
    if (!isCoexy()) return NextResponse.json({ enabled: false })

    const { accountId, userId, role } = await requireRole('viewer')
    const canEdit = hasMinRole(role, 'admin')

    const { data: row } = await supabaseAdmin()
      .from('coexy_channels')
      .select('channel_id')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!row) {
      return NextResponse.json({ enabled: true, configured: hasCoexyApiKey(), channel: null })
    }

    const channel = await getCoexyChannel(row.channel_id)
    const syncError = await syncChannel(accountId, userId, channel)

    return NextResponse.json({
      enabled: true,
      configured: true,
      channel: publicChannel(channel, canEdit),
      sync_error: syncError,
    })
  } catch (err) {
    return coexyFailure(err)
  }
}

export async function POST(request: Request) {
  try {
    if (!isCoexy()) {
      return NextResponse.json({ error: 'Coexy não está ativo neste servidor.' }, { status: 400 })
    }
    const { accountId, userId, account } = await requireRole('admin')
    const admin = supabaseAdmin()

    const origin = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') || new URL(request.url).origin
    await ensureCoexyWebhook(admin, `${origin}/api/whatsapp/webhook`)

    const { data: row } = await admin
      .from('coexy_channels')
      .select('channel_id')
      .eq('account_id', accountId)
      .maybeSingle()

    let channel: CoexyChannel | null = null
    if (row) {
      try {
        channel = await getCoexyChannel(row.channel_id)
      } catch (err) {
        // Channel deleted on Coexy's side: forget it and create a new one.
        if (!(err instanceof CoexyApiError && err.status === 404)) throw err
        await admin.from('coexy_channels').delete().eq('account_id', accountId)
      }
    }

    if (!channel) {
      channel = await createCoexyChannel(account.name || 'LabCRM')
      const { error } = await admin.from('coexy_channels').insert({
        account_id: accountId,
        channel_id: channel.id,
        created_by: userId,
      })
      if (error) {
        console.error('[coexy] failed to store channel:', error.message)
        return NextResponse.json({ error: 'Não foi possível salvar o canal.' }, { status: 500 })
      }
    }

    const syncError = await syncChannel(accountId, userId, channel)
    return NextResponse.json({ channel: publicChannel(channel, true), sync_error: syncError })
  } catch (err) {
    return coexyFailure(err)
  }
}
