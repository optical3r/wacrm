import { describe, expect, it, vi } from 'vitest'
import { assignNewLead } from './owners'

/** Tiny stand-in for the service-role client: members, rpc and updates. */
function fakeDb(opts: { rotation: string | null; members: string[] }) {
  const updates: unknown[] = []
  const rpc = vi.fn(async () => ({ data: opts.rotation, error: null }))
  const from = (table: string) => {
    const q = {
      select: () => q,
      eq: () => q,
      limit: async () => ({ data: opts.members.map((user_id) => ({ user_id })), error: null }),
      is: async () => ({ error: null }),
      update: (v: unknown) => {
        updates.push({ table, v })
        return q
      },
      then: (r: (x: unknown) => void) => r({ data: opts.members.map((user_id) => ({ user_id })), error: null }),
    }
    return q
  }
  return { db: { from, rpc } as never, rpc, updates }
}

const base = { accountId: 'acc', conversationId: 'conv', channelId: 'ch', aiAutoReply: false, plan: 'starter' }

describe('assignNewLead', () => {
  it('leaves the lead to the bot when the AI auto-reply is on', async () => {
    const f = fakeDb({ rotation: 'ana', members: ['ana'] })
    expect(await assignNewLead(f.db, { ...base, aiAutoReply: true })).toBeNull()
    expect(f.rpc).not.toHaveBeenCalled()
  })

  it('uses the rotation, narrowed to the number attendants', async () => {
    const f = fakeDb({ rotation: 'bia', members: ['ana', 'bia'] })
    expect(await assignNewLead(f.db, base)).toBe('bia')
    expect(f.rpc).toHaveBeenCalledWith('assign_lead_by_rotation', { p_conversation_id: 'conv', p_candidates: ['ana', 'bia'] })
    expect(f.updates).toHaveLength(0)
  })

  it('falls back to the number only attendant on Starter', async () => {
    const f = fakeDb({ rotation: null, members: ['ana'] })
    expect(await assignNewLead(f.db, base)).toBe('ana')
    expect(f.updates).toEqual([{ table: 'conversations', v: { assigned_agent_id: 'ana' } }])
  })

  it('leaves a shared number lead unassigned when the rotation is off', async () => {
    const f = fakeDb({ rotation: null, members: ['ana', 'bia'] })
    expect(await assignNewLead(f.db, base)).toBeNull()
    expect(f.updates).toHaveLength(0)
  })
})
