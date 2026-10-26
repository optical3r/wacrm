import { NextResponse } from 'next/server'
import { createHash, randomBytes } from 'node:crypto'
import { createClient as createAdminClient, type SupabaseClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { markDapiDisconnected, saveDapiConnection } from '@/lib/whatsapp/dapi-connection'
import {
  dapiClient,
  dapiSessionIdFor,
  hasDapiApiKey,
} from '@/lib/whatsapp/dapi'

/**
 * WhatsApp by QR code for the Starter plan, through D-API.
 *
 *   GET    → { enabled, session } — session status plus, while pairing,
 *            the QR image or pair code (admins only). Once connected,
 *            saves the session into whatsapp_config so the inbox,
 *            flows and automations send through it.
 *   POST   → { mode: 'qr' | 'pair', phone?, accept_risk: true } starts a
 *            fresh session. The admin must accept the ban-risk notice.
 *   DELETE → logs the number out and marks the connection disconnected.
 *
 * DAPI_API_KEY stays on the server; the browser only sees status, the
 * QR image and the pair code.
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

const STARTER_ONLY = 'A conexão por QR code é exclusiva do plano Starter.'

/** D-API answers either the object itself or `{ data: object }`. */
function unwrap<T>(res: unknown): T {
  const r = (res ?? {}) as Record<string, unknown>
  return (r.data && typeof r.data === 'object' ? r.data : r) as T
}

interface SessionState {
  status: string
  phone?: string
  qrCodeImage?: string
  pairCode?: string
}

function dapiFailure(err: unknown) {
  const e = err as { status?: number; message?: string }
  if (typeof e?.status === 'number') {
    console.error('[dapi] API error:', e.status, e.message)
    return NextResponse.json(
      { error: e.message || 'Erro ao falar com o D-API.' },
      { status: e.status >= 500 ? 502 : 400 },
    )
  }
  return toErrorResponse(err)
}

function phoneDigits(v: string | undefined): string | null {
  const d = (v ?? '').split('@')[0].split(':')[0].replace(/\D/g, '')
  return d || null
}

export async function GET() {
  try {
    const { accountId, userId, role, account } = await requireRole('viewer')
    if (account.plan !== 'starter') return NextResponse.json({ enabled: false })
    if (!hasDapiApiKey()) return NextResponse.json({ enabled: true, configured: false, session: null })
    const canEdit = hasMinRole(role, 'admin')

    const { data: row } = await supabaseAdmin()
      .from('dapi_sessions')
      .select('session_id, status, phone')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!row) return NextResponse.json({ enabled: true, configured: true, session: null })

    let state: SessionState
    try {
      state = unwrap<SessionState>(await dapiClient().sessions.get(row.session_id))
    } catch (err) {
      if ((err as { status?: number }).status === 404) {
        await markDapiDisconnected(supabaseAdmin(), accountId)
        return NextResponse.json({ enabled: true, configured: true, session: { status: 'disconnected' } })
      }
      throw err
    }

    let syncError: string | null = null
    let qrImage: string | null = null
    let pairCode: string | null = null
    const phone = phoneDigits(state.phone) ?? row.phone ?? null

    if (state.status === 'connected') {
      syncError = await saveDapiConnection(supabaseAdmin(), { accountId, userId, sessionId: row.session_id, phone })
    } else if (state.status === 'disconnected') {
      if (row.status !== 'disconnected') await markDapiDisconnected(supabaseAdmin(), accountId)
    } else if (canEdit && state.status === 'qr_ready') {
      const qr = unwrap<{ qrCodeImage?: string }>(await dapiClient().sessions.getQRCode(row.session_id))
      qrImage = qr.qrCodeImage ?? state.qrCodeImage ?? null
    } else if (canEdit && state.status === 'pair_code_ready') {
      const pc = unwrap<{ pairCode?: string }>(await dapiClient().sessions.getPairCode(row.session_id))
      pairCode = pc.pairCode ?? state.pairCode ?? null
    }

    if (qrImage && !qrImage.startsWith('data:') && !qrImage.startsWith('http')) {
      qrImage = `data:image/png;base64,${qrImage}`
    }

    return NextResponse.json({
      enabled: true,
      configured: true,
      session: { status: state.status, phone, qr_image: qrImage, pair_code: pairCode },
      sync_error: syncError,
    })
  } catch (err) {
    return dapiFailure(err)
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, userId, account } = await requireRole('admin')
    if (account.plan !== 'starter') return NextResponse.json({ error: STARTER_ONLY }, { status: 403 })
    if (!hasDapiApiKey()) {
      return NextResponse.json({ error: 'DAPI_API_KEY não configurada no servidor.' }, { status: 400 })
    }

    const body = (await request.json().catch(() => ({}))) as {
      mode?: string
      phone?: string
      accept_risk?: boolean
    }
    if (body.accept_risk !== true) {
      return NextResponse.json({ error: 'É preciso aceitar o aviso de risco antes de conectar.' }, { status: 400 })
    }
    const mode = body.mode === 'pair' ? 'pair' : 'qr'
    const pairPhone = mode === 'pair' ? phoneDigits(body.phone) : null
    if (mode === 'pair' && (!pairPhone || pairPhone.length < 10)) {
      return NextResponse.json({ error: 'Informe o número com DDI e DDD, ex.: 5571999999999.' }, { status: 400 })
    }

    const sessionId = dapiSessionIdFor(accountId)
    const client = dapiClient()

    // Already connected: nothing to start, just make sure it is saved.
    try {
      const current = unwrap<SessionState>(await client.sessions.get(sessionId))
      if (current.status === 'connected') {
        const syncError = await saveDapiConnection(supabaseAdmin(), {
          accountId,
          userId,
          sessionId,
          phone: phoneDigits(current.phone),
        })
        return NextResponse.json({ session: { status: 'connected', phone: phoneDigits(current.phone) }, sync_error: syncError })
      }
      // A half-finished pairing: start over with the chosen mode.
      await client.sessions.delete(sessionId)
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err
    }

    // A fresh secret per session; only its hash is stored.
    const token = randomBytes(24).toString('base64url')
    const origin = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') || new URL(request.url).origin
    const now = new Date().toISOString()

    const { error: saveError } = await supabaseAdmin()
      .from('dapi_sessions')
      .upsert({
        account_id: accountId,
        session_id: sessionId,
        webhook_token_hash: createHash('sha256').update(token).digest('hex'),
        status: 'connecting',
        phone: null,
        risk_accepted_at: now,
        risk_accepted_by: userId,
        created_by: userId,
        updated_at: now,
      })
    if (saveError) {
      console.error('[dapi] failed to store session:', saveError.message)
      return NextResponse.json({ error: 'Não foi possível salvar a sessão.' }, { status: 500 })
    }

    const created = unwrap<SessionState>(
      await client.sessions.create({
        sessionId,
        connectionMode: mode,
        ...(pairPhone ? { pairPhone } : {}),
        webhookUrl: `${origin}/api/whatsapp/dapi/webhook?token=${token}`,
        ignoreGroups: true,
        ignoreStatus: true,
        historySync: false,
      }),
    )

    return NextResponse.json({ session: { status: created.status ?? 'connecting' } })
  } catch (err) {
    return dapiFailure(err)
  }
}

export async function DELETE() {
  try {
    const { accountId } = await requireRole('admin')
    const { data: row } = await supabaseAdmin()
      .from('dapi_sessions')
      .select('session_id')
      .eq('account_id', accountId)
      .maybeSingle()
    if (row && hasDapiApiKey()) {
      try {
        await dapiClient().sessions.delete(row.session_id)
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err
      }
    }
    await markDapiDisconnected(supabaseAdmin(), accountId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return dapiFailure(err)
  }
}
