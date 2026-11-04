import { NextResponse } from 'next/server'
import { createHash, randomBytes } from 'node:crypto'
import { createClient as createAdminClient, type SupabaseClient } from '@supabase/supabase-js'
import QRCode from 'qrcode'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { markDapiDisconnected, NUMBER_LIMIT_MESSAGE, saveDapiConnection } from '@/lib/whatsapp/dapi-connection'
import { channelMembers } from '@/lib/whatsapp/channels'
import {
  dapiClient,
  dapiSessionIdFor,
  hasDapiApiKey,
} from '@/lib/whatsapp/dapi'

/**
 * WhatsApp by QR code for the Starter plan, through D-API. Numbers belong
 * to the company (migration 056): only owner / admin connect, rename and
 * remove them (up to accounts.max_numbers), and link any number of
 * attendants to each one. Linked attendants see the number's chats and
 * answer through it.
 *
 *   GET    → ?session=<id> { enabled, can_manage, numbers, max_numbers,
 *            members?, session, session_id } — the account's numbers (all
 *            for owner / admin, the caller's linked ones for others) and,
 *            for owner / admin, a pairing's live status: the session
 *            named, or the latest one still pairing. While pairing it
 *            carries the QR image or pair code; once connected the
 *            session is saved as a number.
 *   POST   → { mode: 'qr' | 'pair', phone?, accept_risk: true,
 *            channel_id? } starts a pairing for a new number, or to
 *            reconnect `channel_id`. Owner / admin; the ban-risk notice
 *            must be accepted.
 *   PATCH  → { channel_id, label?, is_default?, read_groups?,
 *            sign_messages?, member_ids? } owner / admin.
 *   DELETE → ?channel_id= logs a number out; &remove=1 also deletes it.
 *            ?session= cancels a pairing. Owner / admin; history is kept.
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
async function enableWebhook(client: ReturnType<typeof dapiClient>, sessionId: string, url: string, readGroups = false) {
  await call(client.sessions.updateWebhook(sessionId, { webhookUrl: url }))
  await call(
    client.sessions.updateWebhookConfig(sessionId, {
      enabled: true,
      type: 'single',
      events: Object.fromEntries(WEBHOOK_EVENTS.map((e) => [e, { enabled: true, webhookUrl: url }])),
    }),
  )
  await call(client.sessions.updateIgnoreSettings(sessionId, { ignoreGroups: !readGroups, ignoreStatus: true }))
}

/** Whether a number reads groups (migration 052). */
async function readsGroups(channelId: string | null): Promise<boolean> {
  if (!channelId) return false
  const { data } = await supabaseAdmin().from('whatsapp_config').select('read_groups').eq('id', channelId).maybeSingle()
  return (data as { read_groups?: boolean } | null)?.read_groups === true
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
  label: string | null
  status: string
  is_default: boolean
  phone_number_id: string
  connected_at: string | null
  read_groups: boolean
  sign_messages: boolean
}

/**
 * The account's numbers as the settings page shows them: all of them for
 * owner / admin, only the ones the caller is linked to for others.
 */
async function listNumbers(accountId: string, userId: string, all: boolean) {
  const admin = supabaseAdmin()
  const [{ data: rows }, members] = await Promise.all([
    admin
      .from('whatsapp_config')
      .select('id, label, status, is_default, phone_number_id, connected_at, created_at, read_groups, sign_messages')
      .eq('account_id', accountId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true }),
    channelMembers(admin, accountId),
  ])
  const numbers = ((rows ?? []) as NumberRow[]).filter((r) => all || (members.get(r.id) ?? []).includes(userId))
  const sessionIds = numbers.map((n) => n.phone_number_id.replace(/^dapi:/, ''))
  const userIds = [...new Set(numbers.flatMap((n) => members.get(n.id) ?? []))]
  const [{ data: sessions }, { data: profiles }] = await Promise.all([
    sessionIds.length
      ? admin.from('dapi_sessions').select('session_id, phone').in('session_id', sessionIds)
      : Promise.resolve({ data: [] }),
    userIds.length
      ? admin.from('profiles').select('user_id, full_name, email').in('user_id', userIds)
      : Promise.resolve({ data: [] }),
  ])
  const phoneBySession = new Map(
    ((sessions ?? []) as Array<{ session_id: string; phone: string | null }>).map((x) => [x.session_id, x.phone]),
  )
  const nameByUser = new Map(
    ((profiles ?? []) as Array<{ user_id: string; full_name: string | null; email: string | null }>).map((p) => [
      p.user_id,
      p.full_name || p.email || '',
    ]),
  )
  return numbers.map((n) => {
    const ids = members.get(n.id) ?? []
    return {
      id: n.id,
      label: n.label,
      status: n.status === 'connected' ? 'connected' : 'disconnected',
      is_default: n.is_default,
      phone: phoneBySession.get(n.phone_number_id.replace(/^dapi:/, '')) ?? null,
      member_ids: ids,
      member_names: ids.map((id) => nameByUser.get(id) || '').filter(Boolean),
      mine: ids.includes(userId),
      connected_at: n.connected_at,
      read_groups: n.read_groups === true,
      sign_messages: n.sign_messages === true,
    }
  })
}

/** Members who can be linked to a number: everyone who can send (agent and up). */
async function linkableMembers(accountId: string) {
  const { data } = await supabaseAdmin()
    .from('profiles')
    .select('user_id, full_name, email, account_role')
    .eq('account_id', accountId)
    .in('account_role', ['owner', 'admin', 'agent'])
    .order('created_at', { ascending: true })
  return ((data ?? []) as Array<{ user_id: string; full_name: string | null; email: string | null; account_role: string }>).map(
    (p) => ({ user_id: p.user_id, name: p.full_name || p.email || '', role: p.account_role }),
  )
}

const NOT_A_MEMBER = 'Escolha atendentes desta conta (dono, admin ou atendente).'

async function maxNumbers(accountId: string): Promise<number> {
  const { data } = await supabaseAdmin().from('accounts').select('max_numbers').eq('id', accountId).maybeSingle()
  return (data as { max_numbers?: number } | null)?.max_numbers ?? 5
}

interface SessionRow {
  session_id: string
  status: string
  phone: string | null
  channel_id: string | null
}

const PENDING = '(connected,disconnected)'

/**
 * The session a status call is about: the one named, or else the most
 * recent pairing still in progress in the account (the page was reloaded
 * mid-pairing).
 */
async function sessionFor(accountId: string, sessionId: string | null): Promise<SessionRow | null> {
  let query = supabaseAdmin()
    .from('dapi_sessions')
    .select('session_id, status, phone, channel_id')
    .eq('account_id', accountId)
  query = sessionId
    ? query.eq('session_id', sessionId)
    : query.not('status', 'in', PENDING).order('updated_at', { ascending: false }).limit(1)
  const { data } = await query.maybeSingle()
  return (data as SessionRow | null) ?? null
}

export async function GET(request: Request) {
  try {
    const { accountId, userId, role, account } = await requireRole('viewer')
    if (account.plan !== 'starter') return NextResponse.json({ enabled: false })
    const manager = hasMinRole(role, 'admin')
    const [max, members] = await Promise.all([
      maxNumbers(accountId),
      manager ? linkableMembers(accountId) : Promise.resolve(undefined),
    ])
    const base = {
      enabled: true,
      can_connect: manager,
      can_manage: manager,
      max_numbers: max,
      ...(members ? { members } : {}),
    }
    if (!hasDapiApiKey() || !manager) {
      return NextResponse.json({
        ...base,
        configured: hasDapiApiKey(),
        numbers: await listNumbers(accountId, userId, manager),
        session: null,
        session_id: null,
      })
    }

    const row = await sessionFor(accountId, new URL(request.url).searchParams.get('session'))
    const session = row ? await sessionState(request, accountId, userId, row) : { session: null, sync_error: null }
    return NextResponse.json({
      ...base,
      configured: true,
      // Listed after the session is saved, so a just-connected number shows up.
      numbers: await listNumbers(accountId, userId, manager),
      session_id: session.session ? row?.session_id ?? null : null,
      channel_id: session.session ? row?.channel_id ?? null : null,
      ...session,
    })
  } catch (err) {
    return dapiFailure(err)
  }
}

/** Live status of a session; saves it as a number of the account once connected. */
async function sessionState(request: Request, accountId: string, userId: string, row: SessionRow) {
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
        await enableWebhook(client, row.session_id, url, await readsGroups(row.channel_id))
      } catch (err) {
        console.error('[dapi] enabling webhook failed:', (err as Error).message)
      }
    }
    syncError = await saveDapiConnection(supabaseAdmin(), {
      accountId,
      connectedBy: userId,
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

/** Log a session out on D-API (best effort, 404 is fine) and forget it. */
async function dropSession(sessionId: string) {
  try {
    await call(dapiClient().sessions.delete(sessionId))
  } catch (err) {
    if ((err as { status?: number }).status !== 404) {
      console.warn('[dapi] dropping session failed:', (err as Error).message)
    }
  }
  await supabaseAdmin().from('dapi_sessions').delete().eq('session_id', sessionId)
}

/** A number of the caller's account. */
async function accountNumber(accountId: string, channelId: string | null | undefined) {
  if (!channelId) return null
  const { data } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('id, phone_number_id, status, is_default')
    .eq('account_id', accountId)
    .eq('id', channelId)
    .maybeSingle()
  return data as { id: string; phone_number_id: string; status: string; is_default: boolean } | null
}

const NOT_FOUND = () => NextResponse.json({ error: 'Número não encontrado.' }, { status: 404 })

export async function POST(request: Request) {
  try {
    // Numbers belong to the company: only owner / admin connect them.
    const { accountId, userId, account } = await requireRole('admin')
    if (account.plan !== 'starter') return NextResponse.json({ error: STARTER_ONLY }, { status: 403 })
    if (!hasDapiApiKey()) {
      return NextResponse.json({ error: 'DAPI_API_KEY não configurada no servidor.' }, { status: 400 })
    }

    const body = (await request.json().catch(() => ({}))) as {
      mode?: string
      phone?: string
      accept_risk?: boolean
      /** Reconnect this number instead of adding a new one. */
      channel_id?: string
    }
    if (body.accept_risk !== true) {
      return NextResponse.json({ error: 'É preciso aceitar o aviso de risco antes de conectar.' }, { status: 400 })
    }
    const mode = body.mode === 'pair' ? 'pair' : 'qr'
    const pairPhone = mode === 'pair' ? phoneDigits(body.phone) : null
    if (mode === 'pair' && (!pairPhone || pairPhone.length < 10)) {
      return NextResponse.json({ error: 'Informe o número com DDI e DDD, ex.: 5571999999999.' }, { status: 400 })
    }

    const admin = supabaseAdmin()
    const number = body.channel_id ? await accountNumber(accountId, body.channel_id) : null
    if (body.channel_id && !number) return NOT_FOUND()

    if (number) {
      // Reconnecting: any half-finished pairing of this number goes.
      const { data: old } = await admin
        .from('dapi_sessions')
        .select('session_id')
        .eq('account_id', accountId)
        .eq('channel_id', number.id)
        .not('status', 'in', '(connected)')
      for (const s of (old ?? []) as Array<{ session_id: string }>) await dropSession(s.session_id)
    } else {
      // A new number takes a slot: check the limit before pairing, so
      // nobody scans a QR code that cannot be saved.
      const { count } = await admin
        .from('whatsapp_config')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
      if ((count ?? 0) >= (await maxNumbers(accountId))) {
        return NextResponse.json({ error: NUMBER_LIMIT_MESSAGE }, { status: 400 })
      }
      // Pairings for a new number this admin left unfinished, and anyone's
      // that went stale, are dropped.
      const stale = new Date(Date.now() - 30 * 60 * 1000).toISOString()
      const { data: old } = await admin
        .from('dapi_sessions')
        .select('session_id')
        .eq('account_id', accountId)
        .is('channel_id', null)
        .not('status', 'in', '(connected)')
        .or(`created_by.eq.${userId},updated_at.lt.${stale}`)
      for (const s of (old ?? []) as Array<{ session_id: string }>) await dropSession(s.session_id)
    }

    const sessionId = dapiSessionIdFor(accountId)
    // Reconnecting a number that reads groups keeps reading them.
    const readGroups = await readsGroups(number?.id ?? null)

    // A fresh secret per session; only its hash is stored.
    const hook = await newWebhookUrl(siteOrigin(request))
    const now = new Date().toISOString()

    const { error: saveError } = await admin.from('dapi_sessions').insert({
      account_id: accountId,
      owner_user_id: userId,
      channel_id: number?.id ?? null,
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

    const client = dapiClient()
    const createdRaw = await client.sessions.create({
      sessionId,
      connectionMode: mode,
      ...(pairPhone ? { pairPhone } : {}),
      webhookUrl: hook.url,
      ignoreGroups: !readGroups,
      ignoreStatus: true,
      historySync: false,
    })
    await recordShape(sessionId, 'debug:create', createdRaw)
    await call(Promise.resolve(createdRaw))
    try {
      await enableWebhook(client, sessionId, hook.url, readGroups)
    } catch (err) {
      // Retried by GET once the number is connected.
      console.error('[dapi] enabling webhook failed:', (err as Error).message)
    }
    const created = unwrap(createdRaw)
    // Fresh session: always pairing, whatever word D-API used.
    const status = normalizeStatus(created.status)
    return NextResponse.json({
      session_id: sessionId,
      channel_id: number?.id ?? null,
      session: { status: status === 'disconnected' || status === 'connected' ? 'connecting' : status },
    })
  } catch (err) {
    return dapiFailure(err)
  }
}

export async function PATCH(request: Request) {
  try {
    const { accountId, account } = await requireRole('admin')
    if (account.plan !== 'starter') return NextResponse.json({ error: STARTER_ONLY }, { status: 403 })
    const body = (await request.json().catch(() => ({}))) as {
      channel_id?: string
      label?: string | null
      is_default?: boolean
      read_groups?: boolean
      sign_messages?: boolean
      member_ids?: unknown
    }
    const number = await accountNumber(accountId, body.channel_id)
    if (!number) return NOT_FOUND()

    const admin = supabaseAdmin()
    if (body.member_ids !== undefined) {
      const failure = await setMembers(accountId, number.id, body.member_ids)
      if (failure) return failure
    }
    if (typeof body.label === 'string' || body.label === null) {
      const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) || null : null
      await admin.from('whatsapp_config').update({ label }).eq('id', number.id)
    }
    if (body.is_default === true && !number.is_default) {
      // One default per account (unique index): clear it first.
      await admin.from('whatsapp_config').update({ is_default: false }).eq('account_id', accountId).eq('is_default', true)
      await admin.from('whatsapp_config').update({ is_default: true }).eq('id', number.id)
    }
    if (typeof body.sign_messages === 'boolean') {
      await admin.from('whatsapp_config').update({ sign_messages: body.sign_messages }).eq('id', number.id)
    }
    if (typeof body.read_groups === 'boolean') {
      const failure = await setReadGroups(number, body.read_groups)
      if (failure) return failure
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return dapiFailure(err)
  }
}

/** Replace who is linked to a number (migration 056). Any number of attendants. */
async function setMembers(accountId: string, channelId: string, raw: unknown): Promise<NextResponse | null> {
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
    return NextResponse.json({ error: NOT_A_MEMBER }, { status: 400 })
  }
  const wanted = [...new Set(raw as string[])]
  const allowed = new Set((await linkableMembers(accountId)).map((m) => m.user_id))
  if (wanted.some((id) => !allowed.has(id))) return NextResponse.json({ error: NOT_A_MEMBER }, { status: 400 })

  const admin = supabaseAdmin()
  const { data: current } = await admin
    .from('whatsapp_channel_members')
    .select('user_id')
    .eq('channel_id', channelId)
  const have = new Set(((current ?? []) as Array<{ user_id: string }>).map((r) => r.user_id))
  const toRemove = [...have].filter((id) => !wanted.includes(id))
  const toAdd = wanted.filter((id) => !have.has(id))
  if (toRemove.length) {
    const { error } = await admin
      .from('whatsapp_channel_members')
      .delete()
      .eq('channel_id', channelId)
      .in('user_id', toRemove)
    if (error) {
      console.error('[dapi] unlinking members failed:', error.message)
      return NextResponse.json({ error: 'Não foi possível salvar os atendentes.' }, { status: 500 })
    }
  }
  if (toAdd.length) {
    const { error } = await admin
      .from('whatsapp_channel_members')
      .insert(toAdd.map((user_id) => ({ channel_id: channelId, user_id, account_id: accountId })))
    if (error) {
      console.error('[dapi] linking members failed:', error.message)
      return NextResponse.json({ error: 'Não foi possível salvar os atendentes.' }, { status: 500 })
    }
  }
  return null
}

/**
 * Switch group reading on or off for a number (migration 052): D-API only
 * delivers group messages when the session stops ignoring them.
 */
async function setReadGroups(
  row: { id: string; phone_number_id: string; status: string },
  on: boolean,
): Promise<NextResponse | null> {
  if (row.phone_number_id.startsWith('dapi:') && row.status === 'connected' && hasDapiApiKey()) {
    try {
      await call(
        dapiClient().sessions.updateIgnoreSettings(row.phone_number_id.replace(/^dapi:/, ''), {
          ignoreGroups: !on,
          ignoreStatus: true,
        }),
      )
    } catch (err) {
      console.error('[dapi] group setting failed:', (err as Error).message)
      return NextResponse.json({ error: 'Não foi possível mudar a leitura de grupos agora. Tente de novo.' }, { status: 502 })
    }
  }
  await supabaseAdmin().from('whatsapp_config').update({ read_groups: on }).eq('id', row.id)
  return null
}

export async function DELETE(request: Request) {
  try {
    const { accountId } = await requireRole('admin')
    const params = new URL(request.url).searchParams
    const admin = supabaseAdmin()

    // Cancel a pairing that has not become a number yet.
    const pending = params.get('session')
    if (pending) {
      const row = await sessionFor(accountId, pending)
      if (row && row.status !== 'connected') await dropSession(row.session_id)
      return NextResponse.json({ ok: true })
    }

    const number = await accountNumber(accountId, params.get('channel_id'))
    if (!number) return NOT_FOUND()
    const remove = params.get('remove') === '1'

    const sessionId = number.phone_number_id.replace(/^dapi:/, '')
    if (number.phone_number_id.startsWith('dapi:') && hasDapiApiKey()) {
      try {
        await call(dapiClient().sessions.delete(sessionId))
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err
      }
    }
    await markDapiDisconnected(admin, sessionId)

    if (remove) {
      // Frees the slot. Messages keep their text; their number tag is lost.
      await admin.from('dapi_sessions').delete().eq('channel_id', number.id)
      await admin.from('dapi_sessions').delete().eq('session_id', sessionId)
      await admin.from('whatsapp_config').delete().eq('id', number.id)
      if (number.is_default) {
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
