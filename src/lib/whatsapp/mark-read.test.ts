import { describe, expect, it, vi } from 'vitest'

vi.mock('./dapi', () => ({ dapiMarkRead: vi.fn(), isDapiPhoneNumberId: (id: string) => id.startsWith('dapi:') }))
vi.mock('./meta-api', () => ({ markMessageRead: vi.fn() }))
vi.mock('./channels', () => ({ listChannels: vi.fn() }))

import { applyPhoneRead, participantJid } from './mark-read'

describe('participantJid', () => {
  it('turns a bare number into a WhatsApp jid', () => {
    expect(participantJid('55 71 9999-0000')).toBe('557199990000@s.whatsapp.net')
  })
  it('keeps a jid or lid as it is', () => {
    expect(participantJid('123@lid')).toBe('123@lid')
  })
  it('ignores unknown senders', () => {
    expect(participantJid('unknown')).toBeNull()
    expect(participantJid(null)).toBeNull()
  })
})

describe('applyPhoneRead', () => {
  it('drops the unread count to the messages that came after the read one', async () => {
    const updates: Array<{ v: unknown; gt: [string, number] }> = []
    const db = {
      from: (table: string) => {
        const q: Record<string, unknown> = {}
        const chain = () => q
        Object.assign(q, {
          select: (_c: string, opts?: { head?: boolean }) => {
            if (opts?.head) {
              return { eq: () => ({ eq: () => ({ gt: async () => ({ count: 2 }) }) }) }
            }
            return q
          },
          eq: chain,
          limit: async () => ({ data: [{ conversation_id: 'conv', created_at: '2026-11-04T10:00:00Z' }] }),
          update: (v: unknown) => ({
            eq: () => ({
              gt: async (col: string, n: number) => {
                updates.push({ v, gt: [col, n] })
                return { error: null }
              },
            }),
          }),
        })
        void table
        return q
      },
    }
    await applyPhoneRead(db as never, 'wamid-1')
    expect(updates).toEqual([{ v: { unread_count: 2 }, gt: ['unread_count', 2] }])
  })
})
