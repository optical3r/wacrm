import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory tables behind a tiny chainable Supabase mock.
const tables: Record<string, Array<Record<string, unknown>>> = {}
let insertError: { code?: string; message: string } | null = null

function builder(table: string) {
  const filters: Array<[string, unknown]> = []
  let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
  let payload: Record<string, unknown> = {}
  const rows = () => (tables[table] ??= [])
  const matches = (r: Record<string, unknown>) => filters.every(([k, v]) => r[k] === v)

  const run = () => {
    if (op === 'insert') {
      if (insertError) return { data: null, error: insertError }
      rows().push({ id: `${table}-${rows().length + 1}`, ...payload })
      return { data: null, error: null }
    }
    if (op === 'update') {
      rows().filter(matches).forEach((r) => Object.assign(r, payload))
      return { data: null, error: null }
    }
    if (op === 'delete') {
      tables[table] = rows().filter((r) => !matches(r))
      return { data: null, error: null }
    }
    return { data: rows().filter(matches), error: null }
  }

  const b = {
    select: () => b,
    insert: (p: Record<string, unknown>) => ((op = 'insert'), (payload = p), b),
    update: (p: Record<string, unknown>) => ((op = 'update'), (payload = p), b),
    delete: () => ((op = 'delete'), b),
    eq: (k: string, v: unknown) => (filters.push([k, v]), b),
    limit: () => b,
    maybeSingle: async () => {
      const r = run()
      return { data: (r.data as unknown[] | null)?.[0] ?? null, error: r.error }
    },
    then: (resolve: (v: unknown) => void) => resolve(run()),
  }
  return b
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: (t: string) => builder(t) }),
}))

let role = 'admin'
vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({
    accountId: 'acct-1',
    userId: 'user-1',
    role,
    account: { id: 'acct-1', name: 'Cerqueira Labs' },
  })),
  toErrorResponse: (err: unknown) =>
    Response.json({ error: String(err) }, { status: 500 }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc(${v})`,
}))

const channel = {
  id: 'ch-1',
  name: 'Cerqueira Labs',
  status: 'pending',
  display_phone_number: null as string | null,
  phone_number_id: null as string | null,
  waba_id: null as string | null,
  channel_token: 'tok-1',
  connect_url: 'https://coexy.example/connect/ch-1',
  connected_at: null,
}

const createCoexyChannel = vi.fn(async () => ({ ...channel }))
const getCoexyChannel = vi.fn(async () => ({ ...channel }))
const ensureCoexyWebhook = vi.fn(async () => {})

vi.mock('@/lib/whatsapp/coexy', async () => {
  const actual = await vi.importActual<typeof import('@/lib/whatsapp/coexy')>('@/lib/whatsapp/coexy')
  return {
    CoexyApiError: actual.CoexyApiError,
    hasCoexyApiKey: () => true,
    createCoexyChannel: (...a: unknown[]) => createCoexyChannel(...(a as [])),
    getCoexyChannel: (...a: unknown[]) => getCoexyChannel(...(a as [])),
    ensureCoexyWebhook: (...a: unknown[]) => ensureCoexyWebhook(...(a as [])),
  }
})

const { GET, POST } = await import('./route')

const savedProvider = process.env.WHATSAPP_PROVIDER
const savedSite = process.env.NEXT_PUBLIC_SITE_URL

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  insertError = null
  role = 'admin'
  Object.assign(channel, {
    status: 'pending',
    display_phone_number: null,
    phone_number_id: null,
    waba_id: null,
  })
  vi.clearAllMocks()
  process.env.WHATSAPP_PROVIDER = 'coexy'
  process.env.NEXT_PUBLIC_SITE_URL = 'https://crm.example.com/'
})

afterEach(() => {
  process.env.WHATSAPP_PROVIDER = savedProvider
  process.env.NEXT_PUBLIC_SITE_URL = savedSite
})

const post = () => POST(new Request('https://crm.example.com/api/whatsapp/coexy', { method: 'POST' }))

describe('/api/whatsapp/coexy', () => {
  it('reports disabled when the install talks to Meta directly', async () => {
    process.env.WHATSAPP_PROVIDER = 'meta'
    const res = await GET()
    expect(await res.json()).toEqual({ enabled: false })
  })

  it('creates a channel, registers the webhook and returns the connect link', async () => {
    const res = await post()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(ensureCoexyWebhook).toHaveBeenCalledWith(
      expect.anything(),
      'https://crm.example.com/api/whatsapp/webhook',
    )
    expect(createCoexyChannel).toHaveBeenCalledWith('Cerqueira Labs')
    expect(tables.coexy_channels).toEqual([
      expect.objectContaining({ account_id: 'acct-1', channel_id: 'ch-1' }),
    ])
    expect(body.channel).toEqual({
      status: 'pending',
      display_phone_number: null,
      connect_url: channel.connect_url,
    })
    // Nothing to save until the number is connected.
    expect(tables.whatsapp_config ?? []).toHaveLength(0)
  })

  it('reuses the existing channel instead of creating another', async () => {
    tables.coexy_channels = [{ account_id: 'acct-1', channel_id: 'ch-1' }]
    await post()
    expect(createCoexyChannel).not.toHaveBeenCalled()
    expect(getCoexyChannel).toHaveBeenCalledWith('ch-1')
  })

  it('saves the credentials once the channel is active', async () => {
    tables.coexy_channels = [{ account_id: 'acct-1', channel_id: 'ch-1' }]
    Object.assign(channel, {
      status: 'active',
      display_phone_number: '+55 71 99999-0000',
      phone_number_id: '123456',
      waba_id: '987654',
    })

    const res = await GET()
    const body = await res.json()

    expect(body.channel).toEqual({
      status: 'active',
      display_phone_number: '+55 71 99999-0000',
      connect_url: null,
    })
    expect(tables.whatsapp_config).toEqual([
      expect.objectContaining({
        account_id: 'acct-1',
        user_id: 'user-1',
        phone_number_id: '123456',
        waba_id: '987654',
        access_token: 'enc(tok-1)',
        status: 'connected',
      }),
    ])
  })

  it('reports a number already used by another account', async () => {
    tables.coexy_channels = [{ account_id: 'acct-1', channel_id: 'ch-1' }]
    Object.assign(channel, { status: 'active', phone_number_id: '123456' })
    insertError = { code: '23505', message: 'duplicate key' }

    const body = await (await GET()).json()
    expect(body.sync_error).toMatch(/outra conta/)
  })

  it('marks the config disconnected when Meta revoked the channel', async () => {
    tables.coexy_channels = [{ account_id: 'acct-1', channel_id: 'ch-1' }]
    tables.whatsapp_config = [{ id: 'cfg-1', account_id: 'acct-1', status: 'connected' }]
    channel.status = 'disconnected'

    const body = await (await GET()).json()
    expect(body.channel.connect_url).toBe(channel.connect_url)
    expect(tables.whatsapp_config[0].status).toBe('disconnected')
  })

  it('hides the connect link from non-admins', async () => {
    role = 'agent'
    tables.coexy_channels = [{ account_id: 'acct-1', channel_id: 'ch-1' }]
    const body = await (await GET()).json()
    expect(body.channel.connect_url).toBeNull()
  })
})
