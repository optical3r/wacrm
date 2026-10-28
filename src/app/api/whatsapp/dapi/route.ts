import { NextResponse } from 'next/server'
import { createHash, randomBytes } from 'node:crypto'
import { createClient as createAdminClient, type SupabaseClient } from '@supabase/supabase-js'
import QRCode from 'qrcode'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { markDapiDisconnected, NUMBER_LIMIT_MESSAGE, saveDapiConnection } from '@/lib/whatsapp/dapi-connection'
import {
  dapiClient,
  dapiSessionIdFor,
  hasDapiApiKey,
} from '@/lib/whatsapp/dapi'

/**
 * WhatsApp by QR code for the Starter plan, through D-API. Each member
 * connects their own number (up to accounts.max_numbers per account,
 * migration 051).
 *
 *   GET    → { enabled, numbers, max_numbers, session } — the account's
 *            numbers (all of them for owner / admin, only the caller's
 *            for others) and the caller's own session: status plus, while
 *            pairing, the QR image or pair code. Once connected, saves
 *            the session as the caller's number in whatsapp_config.
 *   POST   → { mode: 'qr' | 'pair', phone?, accept_risk: true } starts a
 *            fresh session for the caller (agent and up). The ban-risk
 *            notice must be accepted.
 *   PATCH  → { channel_id, label?, is_default? } renames a number (own,
 *            or any for owner / admin) or makes it the default (owner /
 *            admin).
 *   DELETE → ?channel_id= logs a number out (own, or any for owner /
 *            admin); &remove=1 also deletes a disconnected number, owner /
 *            admin only. History is kept either way.
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

const WEBHOOK_EVENTS = ['messages.received', 'messages.sent', 'message.delivered', 'message.read', 'connection.status']

/**
 * Point the session's webhook at us and switch its events on. The
 * webhookUrl given at create time alone is not enough: D-API only
 * delivers events enabled in the session's webhook config.
 */
async function enableWebhook(client: ReturnType<typeof dapiClient>, sessionId: string, url: string) {
  await call(client.sessions.updateWebhook(sessionId, { webhookUrl: url }))
  await call(
    client.sessions.updateWebhookConfig(sessionId, {
      enabled: true,
      type: 'single',
      events: Object.fromEntries(WEBHOOK_EVENTS.map((e) => [e, { enabled: true, webhookUrl: url }])),
    }),
  )
  await call(client.sessions.updateIgnoreSettings(sessionId, { ignoreGroups: true, ignoreStatus: true }))
}

/** A new secret webhook URL for the session; only the token's hash is stored. */
async function newWebhookUrl(origin: string): Promise<{ url: string; hash: string }> {
  const token = randomBytes(24).toString('base64url')
  return {
    url: `${origin}/api/whatsapp/dapi/webhook?token=${token}`,
    hash: createHash('sha256').update(token).digest('hex'),
  }
}

function siteOrigin(request: Request): string {
  return process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') || new URL(request.url).origin
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

interface NumberRow {
  id: string
  owner_user_id: string | null
  label: string | null
  status: string
  is_default: boolean
  phone_number_id: string
  connected_at: string | null
}

/** The account's numbers as the settings page shows them. */
async function listNumbers(accountId: string, userId: string, all: boolean) {
  const admin = supabaseAdmin()
  const { data: rows } = await admin
    .from('whatsapp_config')
    .select('id, owner_user_id, label, status, is_default, phone_number_id, connected_at, created_at')
    .eq('account_id', accountId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true })
  const numbers = ((rows ?? []) as NumberRow[]).filter((r) => all || r.owner_user_id === userId)
  const sessionIds = numbers.map((n) => n.phone_number_id.replace(/^dapi:/, ''))
  const ownerIds = [...new Set(numbers.map((n) => n.owner_user_id).filter(Boolean))] as string[]
  const [{ data: sessions }, { data: profiles }] = await Promise.all([
    sessionIds.length
      ? admin.from('dapi_sessions').select('session_id, phone').in('session_id', sessionIds)
      : Promise.resolve({ data: [] }),
    ownerIds.length
      ? admin.from('profiles').select('user_id, full_name, email').in('user_id', ownerIds)
      : Promise.resolve({ data: [] }),
  ])
  const phoneBySession = new Map(
    ((sessions ?? []) as Array<{ session_id: string; phone: string | null }>).map((x) => [x.session_id, x.phone]),
  )
  const nameByUser = new Map(
    ((profiles ?? []) as Array<{ user_id: string; full_name: string | null; email: string | null }>).map((p) => [
      p.user_id,
      p.full_name || p.email || null,
    ]),
  )
  return numbers.map((n) => ({
    id: n.id,
    label: n.label,
    status: n.status === 'connected' ? 'connected' : 'disconnected',
    is_default: n.is_default,
    phone: phoneBySession.get(n.phone_number_id.replace(/^dapi:/, '')) ?? null,
    owner_user_id: n.owner_user_id,
    owner_name: n.owner_user_id ? nameByUser.get(n.owner_user_id) ?? null : null,
    mine: n.owner_user_id === userId,
    connected_at: n.connected_at,
  }))
}

async function maxNumbers(accountId: string): Promise<number> {
  const { data } = await supabaseAdmin().from('accounts').select('max_numbers').eq('id', accountId).maybeSingle()
  return (data as { max_numbers?: number } | null)?.max_numbers ?? 5
}

/** The caller's own D-API session row, if any. */
async function ownSession(accountId: string, userId: string) {
  const { data } = await supabaseAdmin()
    .from('dapi_sessions')
    .select('session_id, status, phone')
    .eq('account_id', accountId)
    .eq('owner_user_id', userId)
    .maybeSingle()
  return data as { session_id: string; status: string; phone: string | null } | null
}

export async function GET(request: Request) {
  try {
    const { accountId, userId, role, account } = await requireRole('viewer')
    if (account.plan !== 'starter') return NextResponse.json({ enabled: false })
    const manager = hasMinRole(role, 'admin')
    const canConnect = hasMinRole(role, 'agent')
    const base = {
      enabled: true,
      can_connect: canConnect,
      can_manage: manager,
      max_numbers: await maxNumbers(accountId),
    }
    if (!hasDapiApiKey()) {
      return NextResponse.json({ ...base, configured: false, numbers: await listNumbers(accountId, userId, manager), session: null })
    }

    const row = canConnect ? await ownSession(accountId, userId) : null
    const session = row ? await sessionState(request, accountId, userId, row) : { session: null, sync_error: null }
    return NextResponse.json({
      ...base,
      configured: true,
      numbers: await listNumbers(accountId, userId, manager),
      ...session,
    })
  } catch (err) {
    return dapiFailure(err)
  }
}

/** Live status of the caller's session; saves it once connected. */
async function sessionState(
  request: Request,
  accountId: string,
  userId: string,
  row: { session_id: string; status: string; phone: string | null },
) {
  const client = dapiClient()
  let raw: unknown
  try {
    raw = await call(client.sessions.get(row.session_id))
  } catch (err) {
    if ((err as { status?: number }).status === 404) {
      // Gone on D-API's side (or never created): back to the connect form.
      await markDapiDisconnected(supabaseAdmin(), row.session_id)
      return { session: null, sync_error: null }
    }
    throw err
  }
  const state = unwrap(raw)
  let status = normalizeStatus(state.status ?? state.state ?? state.connectionStatus)

  let syncError: string | null = null
  let qrImage: string | null = null
  let pairCode: string | null = null
  const auth = isObj(state.authData) ? state.authData : {}
  const phone =
    phoneDigits(text(state.phone) ?? text(auth.phone) ?? text(auth.jid) ?? text(state.phoneNumber) ?? text(state.wid)) ??
    row.phone ??
    null

  if (status === 'connected') {
    // Sessions paired before webhooks were switched on (or that lost
    // their config): issue a fresh secret URL and enable the events.
    const settings = isObj(state.settings) ? state.settings : {}
    const hook = isObj(settings.webhook) ? settings.webhook : null
    if (!(hook && hook.enabled === true)) {
      try {
        const { url, hash } = await newWebhookUrl(siteOrigin(request))
        await supabaseAdmin().from('dapi_sessions').update({ webhook_token_hash: hash }).eq('session_id', row.session_id)
        await enableWebhook(client, row.session_id, url)
      } catch (err) {
        console.error('[dapi] enabling webhook failed:', (err as Error).message)
      }
    }
    syncError = await saveDapiConnection(supabaseAdmin(), {
      accountId,
      ownerUserId: userId,
      sessionId: row.session_id,
      phone,
    })
  } else if (status === 'disconnected') {
    if (row.status !== 'disconnected') await markDapiDisconnected(supabaseAdmin(), row.session_id)
  } else {
    // Still pairing: ask for the QR (or pair code) whatever the status word says.
    const pairMode = state.connectionMode === 'pair' || status === 'pair_code_ready'
    try {
      if (pairMode) {
        const pc = unwrap(await call(client.sessions.getPairCode(row.session_id)))
        pairCode = text(pc.pairCode) ?? text(pc.code) ?? text(state.pairCode) ?? null
        if (pairCode) status = 'pair_code_ready'
      } else {
        const qrRaw = await call(client.sessions.getQRCode(row.session_id))
        qrImage = (await qrImageFrom(unwrap(qrRaw))) ?? (await qrImageFrom(state))
        if (qrImage) status = 'qr_ready'
      }
    } catch (err) {
      // Not ready yet: keep polling.
      console.warn('[dapi] pairing data not ready:', (err as Error).message)
    }
  }

  return {
    session: { status, phone, qr_image: qrImage, pair_code: pairCode },
    sync_error: syncError,
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, userId, account } = await requireRole('agent')
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

    // A member who has no number yet takes a new slot: check the limit
    // before pairing, so nobody scans a QR code that cannot be saved.
    const admin = supabaseAdmin()
    const { data: mine } = await admin
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .eq('owner_user_id', userId)
      .maybeSingle()
    if (!mine) {
      const { count } = await admin
        .from('whatsapp_config')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
      if ((count ?? 0) >= (await maxNumbers(accountId))) {
        return NextResponse.json({ error: NUMBER_LIMIT_MESSAGE }, { status: 400 })
      }
    }

    const client = dapiClient()
    const previous = await ownSession(accountId, userId)

    if (previous) {
      try {
        const current = unwrap(await call(client.sessions.get(previous.session_id)))
        // Already connected: nothing to start, just make sure it is saved.
        if (normalizeStatus(current.status ?? current.state) === 'connected') {
          const phone = phoneDigits(text(current.phone))
          const syncError = await saveDapiConnection(admin, {
            accountId,
            ownerUserId: userId,
            sessionId: previous.session_id,
            phone,
          })
          return NextResponse.json({ session: { status: 'connected', phone }, sync_error: syncError })
        }
        // A half-finished pairing: drop it and start over.
        await call(client.sessions.delete(previous.session_id))
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err
      }
      await admin.from('dapi_sessions').delete().eq('session_id', previous.session_id)
    }

    const sessionId = dapiSessionIdFor(accountId)

    // A fresh secret per session; only its hash is stored.
    const hook = await newWebhookUrl(siteOrigin(request))
    const now = new Date().toISOString()

    const { error: saveError } = await admin.from('dapi_sessions').insert({
      account_id: accountId,
      owner_user_id: userId,
      session_id: sessionId,
      webhook_token_hash: hook.hash,
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
      webhookUrl: hook.url,
      ignoreGroups: true,
      ignoreStatus: true,
      historySync: false,
    })
    await recordShape(sessionId, 'debug:create', createdRaw)
    await call(Promise.resolve(createdRaw))
    try {
      await enableWebhook(client, sessionId, hook.url)
    } catch (err) {
      // Retried by GET once the number is connected.
      console.error('[dapi] enabling webhook failed:', (err as Error).message)
    }
    const created = unwrap(createdRaw)
    // Fresh session: always pairing, whatever word D-API used.
    const status = normalizeStatus(created.status)
    return NextResponse.json({ session: { status: status === 'disconnected' ? 'connecting' : status } })
  } catch (err) {
    return dapiFailure(err)
  }
}

/** Load a number of the caller's account and check the caller may manage it. */
async function manageableNumber(accountId: string, userId: string, manager: boolean, channelId: string | null) {
  let query = supabaseAdmin()
    .from('whatsapp_config')
    .select('id, owner_user_id, phone_number_id, status, is_default')
    .eq('account_id', accountId)
  query = channelId ? query.eq('id', channelId) : query.eq('owner_user_id', userId)
  const { data } = await query.maybeSingle()
  const row = data as { id: string; owner_user_id: string | null; phone_number_id: string; status: string; is_default: boolean } | null
  if (!row) return { error: NextResponse.json({ error: 'Número não encontrado.' }, { status: 404 }) }
  if (!manager && row.owner_user_id !== userId) {
    return { error: NextResponse.json({ error: 'Você só pode alterar o seu próprio número.' }, { status: 403 }) }
  }
  return { row }
}

export async function PATCH(request: Request) {
  try {
    const { accountId, userId, role, account } = await requireRole('agent')
    if (account.plan !== 'starter') return NextResponse.json({ error: STARTER_ONLY }, { status: 403 })
    const manager = hasMinRole(role, 'admin')
    const body = (await request.json().catch(() => ({}))) as {
      channel_id?: string
      label?: string | null
      is_default?: boolean
    }
    const found = await manageableNumber(accountId, userId, manager, body.channel_id ?? null)
    if ('error' in found) return found.error

    const admin = supabaseAdmin()
    if (typeof body.label === 'string' || body.label === null) {
      const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) || null : null
      await admin.from('whatsapp_config').update({ label }).eq('id', found.row.id)
    }
    if (body.is_default === true && !found.row.is_default) {
      if (!manager) return NextResponse.json({ error: 'Só dono e admin definem o número padrão.' }, { status: 403 })
      // One default per account (unique index): clear it first.
      await admin.from('whatsapp_config').update({ is_default: false }).eq('account_id', accountId).eq('is_default', true)
      await admin.from('whatsapp_config').update({ is_default: true }).eq('id', found.row.id)
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return dapiFailure(err)
  }
}

export async function DELETE(request: Request) {
  try {
    const { accountId, userId, role } = await requireRole('agent')
    const manager = hasMinRole(role, 'admin')
    const params = new URL(request.url).searchParams
    const found = await manageableNumber(accountId, userId, manager, params.get('channel_id'))
    if ('error' in found) return found.error
    const remove = params.get('remove') === '1'
    if (remove && !manager) {
      return NextResponse.json({ error: 'Só dono e admin removem números.' }, { status: 403 })
    }

    const admin = supabaseAdmin()
    const sessionId = found.row.phone_number_id.replace(/^dapi:/, '')
    if (found.row.phone_number_id.startsWith('dapi:') && hasDapiApiKey()) {
      try {
        await call(dapiClient().sessions.delete(sessionId))
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err
      }
    }
    await markDapiDisconnected(admin, sessionId)

    if (remove) {
      // Frees the slot. Messages keep their text; their number tag is lost.
      await admin.from('dapi_sessions').delete().eq('session_id', sessionId)
      await admin.from('whatsapp_config').delete().eq('id', found.row.id)
      if (found.row.is_default) {
        const { data: next } = await admin
          .from('whatsapp_config')
          .select('id')
          .eq('account_id', accountId)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle()
        if (next) await admin.from('whatsapp_config').update({ is_default: true }).eq('id', (next as { id: string }).id)
      }
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return dapiFailure(err)
  }
}
