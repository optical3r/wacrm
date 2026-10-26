import { NextResponse } from 'next/server'
import { createHash, randomBytes } from 'node:crypto'
import { createClient as createAdminClient, type SupabaseClient } from '@supabase/supabase-js'
import QRCode from 'qrcode'
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

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** D-API answers the object itself, `{ data }`, `{ session }` or `{ data: { session } }`. */
function unwrap(res: unknown): Obj {
  let r: unknown = res
  for (let i = 0; i < 3; i++) {
    if (!isObj(r)) return {}
    const inner = isObj(r.data) ? r.data : isObj(r.session) ? r.session : null
    if (!inner || 'status' in r) break
    r = inner
  }
  return isObj(r) ? r : {}
}

/**
 * D-API sometimes reports failures in a 200 body (`{ code: 404, error }`),
 * which the SDK does not throw for. Turn those into real errors.
 */
async function call<T>(p: Promise<T>): Promise<T> {
  const res = await p
  if (isObj(res) && typeof res.error === 'string' && res.success !== true && !('status' in res)) {
    const details = typeof res.details === 'string' ? res.details : typeof res.message === 'string' ? res.message : ''
    console.error('[dapi] error body:', res.error, details)
    throw Object.assign(new Error(details ? `${res.error}: ${details}` : res.error), {
      status: typeof res.code === 'number' ? res.code : 400,
    })
  }
  return res
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

type Status = 'connecting' | 'connected' | 'disconnected' | 'qr_ready' | 'pair_code_ready'

/** Map whatever status word D-API uses onto the five the UI knows. */
function normalizeStatus(raw: unknown): Status {
  const s = String(raw ?? '').toLowerCase()
  if (/qr/.test(s)) return 'qr_ready'
  if (/pair/.test(s)) return 'pair_code_ready'
  if (/disconnect|logout|logged_out|close|stop|fail|error|banned/.test(s)) return 'disconnected'
  if (/^connected$|open|working|ready|online|authenticated|logged_in/.test(s)) return 'connected'
  return 'connecting'
}

/** QR as something an <img> can show: data URL, http URL, or rendered from the raw QR string. */
async function qrImageFrom(state: Obj): Promise<string | null> {
  const image = text(state.qrCodeImage) ?? text(state.qr_code_image) ?? text(state.image)
  if (image) {
    if (image.startsWith('data:') || image.startsWith('http')) return image
    return `data:image/png;base64,${image}`
  }
  const raw = text(state.qrCode) ?? text(state.qr_code) ?? text(state.qr)
  if (!raw) return null
  if (raw.startsWith('data:')) return raw
  return QRCode.toDataURL(raw, { margin: 1, width: 320 })
}

/** Response shape without secrets, so the format can be checked in dapi_webhook_log. */
function shapeOf(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.slice(0, 2).map((x) => shapeOf(x, depth + 1))
  if (!isObj(v)) return typeof v === 'string' ? (v.length > 24 ? `<string ${v.length}>` : v) : v
  if (depth > 3) return '<object>'
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [
      k,
      /qr|pair|token|key/i.test(k)
        ? `<${typeof x}>`
        : /^(error|details|message|status|state)$/i.test(k) && typeof x === 'string'
          ? x.slice(0, 300)
          : shapeOf(x, depth + 1),
    ]),
  )
}

async function recordShape(sessionId: string, event: string, res: unknown) {
  await supabaseAdmin()
    .from('dapi_webhook_log')
    .insert({ session_id: sessionId, event, payload: { shape: shapeOf(res) } })
    .then(({ error }) => error && console.error('[dapi] shape log failed:', error.message))
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

    const client = dapiClient()
    let raw: unknown
    try {
      raw = await call(client.sessions.get(row.session_id))
    } catch (err) {
      if ((err as { status?: number }).status === 404) {
        // Gone on D-API's side (or never created): back to the connect form.
        await markDapiDisconnected(supabaseAdmin(), accountId)
        return NextResponse.json({ enabled: true, configured: true, session: null })
      }
      throw err
    }
    const state = unwrap(raw)
    let status = normalizeStatus(state.status ?? state.state ?? state.connectionStatus)
    console.log('[dapi] session status:', String(state.status ?? state.state ?? '?'), '->', status)
    await recordShape(row.session_id, 'debug:get', raw)

    let syncError: string | null = null
    let qrImage: string | null = null
    let pairCode: string | null = null
    const phone = phoneDigits(text(state.phone) ?? text(state.phoneNumber) ?? text(state.wid)) ?? row.phone ?? null

    if (status === 'connected') {
      syncError = await saveDapiConnection(supabaseAdmin(), { accountId, userId, sessionId: row.session_id, phone })
    } else if (status === 'disconnected') {
      if (row.status !== 'disconnected') await markDapiDisconnected(supabaseAdmin(), accountId)
    } else if (canEdit) {
      // Still pairing: ask for the QR (or pair code) whatever the status word says.
      const pairMode = state.connectionMode === 'pair' || status === 'pair_code_ready'
      try {
        if (pairMode) {
          const pcRaw = await call(client.sessions.getPairCode(row.session_id))
          await recordShape(row.session_id, 'debug:pair', pcRaw)
          const pc = unwrap(pcRaw)
          pairCode = text(pc.pairCode) ?? text(pc.code) ?? text(state.pairCode) ?? null
          if (pairCode) status = 'pair_code_ready'
        } else {
          const qrRaw = await call(client.sessions.getQRCode(row.session_id))
          await recordShape(row.session_id, 'debug:qr', qrRaw)
          qrImage = (await qrImageFrom(unwrap(qrRaw))) ?? (await qrImageFrom(state))
          if (qrImage) status = 'qr_ready'
        }
      } catch (err) {
        // Not ready yet: keep polling.
        console.warn('[dapi] pairing data not ready:', (err as Error).message)
      }
    }

    return NextResponse.json({
      enabled: true,
      configured: true,
      session: { status, phone, qr_image: qrImage, pair_code: pairCode },
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
      const current = unwrap(await call(client.sessions.get(sessionId)))
      if (normalizeStatus(current.status ?? current.state) === 'connected') {
        const syncError = await saveDapiConnection(supabaseAdmin(), {
          accountId,
          userId,
          sessionId,
          phone: phoneDigits(text(current.phone)),
        })
        return NextResponse.json({ session: { status: 'connected', phone: phoneDigits(text(current.phone)) }, sync_error: syncError })
      }
      // A half-finished pairing: start over with the chosen mode.
      await call(client.sessions.delete(sessionId))
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

    const createdRaw = await client.sessions.create({
      sessionId,
      connectionMode: mode,
      ...(pairPhone ? { pairPhone } : {}),
      webhookUrl: `${origin}/api/whatsapp/dapi/webhook?token=${token}`,
      ignoreGroups: true,
      ignoreStatus: true,
      historySync: false,
    })
    await recordShape(sessionId, 'debug:create', createdRaw)
    await call(Promise.resolve(createdRaw))
    const created = unwrap(createdRaw)
    // Fresh session: always pairing, whatever word D-API used.
    const status = normalizeStatus(created.status)
    return NextResponse.json({ session: { status: status === 'disconnected' ? 'connecting' : status } })
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
