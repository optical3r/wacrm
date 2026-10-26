import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: Array<{ table: string; op: string; payload?: unknown }> = []
let account: Record<string, unknown> | null = { id: 'acc-1', plan: 'pro', status: 'pending' }
let superAdmin = true

function table(name: string) {
  const b = {
    select: () => b,
    eq: () => b,
    maybeSingle: async () => ({ data: name === 'accounts' ? account : null, error: null }),
    update: (payload: unknown) => {
      calls.push({ table: name, op: 'update', payload })
      return { eq: async () => ({ error: null }) }
    },
    insert: async (payload: unknown) => {
      calls.push({ table: name, op: 'insert', payload })
      return { error: null }
    },
  }
  return b
}

vi.mock('@/lib/admin/super-admin', async () => {
  const { ForbiddenError } = await import('@/lib/auth/account')
  return {
    requireSuperAdmin: async () => {
      if (!superAdmin) throw new ForbiddenError()
      return { userId: 'u1', email: 'owner@example.com', admin: { from: table } }
    },
  }
})
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const { PATCH } = await import('./route')

const patch = (body: unknown) =>
  PATCH(
    new Request('http://x/api/admin/accounts/acc-1', { method: 'PATCH', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: 'acc-1' }) },
  )

beforeEach(() => {
  calls.length = 0
  superAdmin = true
  account = { id: 'acc-1', plan: 'pro', status: 'pending' }
})

describe('PATCH /api/admin/accounts/[id]', () => {
  it('refuses anyone who is not a super admin', async () => {
    superAdmin = false
    const res = await patch({ action: 'approve', plan: 'pro' })
    expect(res.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('approves with the chosen plan and writes the audit log', async () => {
    const res = await patch({ action: 'approve', plan: 'starter' })
    expect(res.status).toBe(200)
    expect(calls).toContainEqual({ table: 'accounts', op: 'update', payload: { status: 'active', plan: 'starter' } })
    expect(calls.find((c) => c.table === 'admin_audit_log')?.payload).toMatchObject({
      actor_email: 'owner@example.com',
      account_id: 'acc-1',
      action: 'approve',
    })
  })

  it('rejects an approval without a valid plan', async () => {
    const res = await patch({ action: 'approve', plan: 'gold' })
    expect(res.status).toBe(400)
  })

  it('disconnects WhatsApp when the plan changes', async () => {
    account = { id: 'acc-1', plan: 'pro', status: 'active' }
    await patch({ action: 'set_plan', plan: 'starter' })
    expect(calls.map((c) => `${c.table}.${c.op}`)).toEqual([
      'whatsapp_config.update',
      'accounts.update',
      'admin_audit_log.insert',
    ])
  })

  it('leaves WhatsApp alone when the plan is unchanged', async () => {
    account = { id: 'acc-1', plan: 'pro', status: 'active' }
    await patch({ action: 'set_plan', plan: 'pro' })
    expect(calls.map((c) => c.table)).toEqual(['admin_audit_log'])
  })

  it('blocks and returns 404 for unknown organizations', async () => {
    await patch({ action: 'block' })
    expect(calls[0]).toEqual({ table: 'accounts', op: 'update', payload: { status: 'blocked' } })
    account = null
    expect((await patch({ action: 'block' })).status).toBe(404)
  })
})
