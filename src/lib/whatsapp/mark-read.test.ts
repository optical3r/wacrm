import { describe, expect, it, vi } from 'vitest'

vi.mock('./dapi', () => ({ dapiMarkRead: vi.fn(), isDapiPhoneNumberId: (id: string) => id.startsWith('dapi:') }))
vi.mock('./meta-api', () => ({ markMessageRead: vi.fn() }))
vi.mock('./channels', () => ({ listChannels: vi.fn() }))

import { applyPhoneRead, participantJid, readCutoff } from './mark-read'

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

describe('readCutoff', () => {
  it('uses the receipt time when it is later than the message', () => {
    expect(readCutoff('2026-11-04T10:00:00Z', 1793800000)).toBe(new Date(1793800000 * 1000).toISOString())
  })
  it('never goes before the message itself', () => {
    expect(readCutoff('2026-11-04T10:00:00Z', 1000)).toBe('2026-11-04T10:00:00.000Z')
  })
  it('falls back to the message time without a receipt time', () => {
    expect(readCutoff('2026-11-04T10:00:00Z', null)).toBe('2026-11-04T10:00:00.000Z')
    expect(readCutoff('2026-11-04T10:00:00Z', 'x')).toBe('2026-11-04T10:00:00.000Z')
  })
})

/** A query builder that records every call and resolves to `result`. */
function recorder(result: (calls: Array<[string, unknown[]]>) => unknown, log: Array<Array<[string, unknown[]]>>) {
  const calls: Array<[string, unknown[]]> = []
  log.push(calls)
  const q: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(result(calls))
        }
        return (...args: unknown[]) => {
          calls.push([String(prop), args])
          return q
        }
      },
    },
  )
  return q
}

describe('applyPhoneRead', () => {
  it('reads the chat up to the receipt time and keeps only later messages unread', async () => {
    const log: Array<Array<[string, unknown[]]>> = []
    const db = {
      from: (table: string) =>
        recorder((calls) => {
          const isHead = calls.some(([m, a]) => m === 'select' && (a[1] as { head?: boolean } | undefined)?.head)
          if (table === 'messages' && isHead) return { count: 1 }
          if (table === 'messages' && calls[0][0] === 'select') {
            return { data: [{ conversation_id: 'conv', created_at: '2026-11-04T10:00:00Z' }] }
          }
          return { error: null }
        }, log),
    }
    const receipt = Math.floor(Date.parse('2026-11-04T10:05:00Z') / 1000)
    await applyPhoneRead(db as never, 'wamid-1', receipt)

    const cutoff = '2026-11-04T10:05:00.000Z'
    const markRead = log.find((c) => c[0][0] === 'update' && (c[0][1][0] as { status?: string }).status === 'read')
    expect(markRead).toContainEqual(['lte', ['created_at', cutoff]])
    const count = log.find((c) => c.some(([m, a]) => m === 'select' && (a[1] as { head?: boolean } | undefined)?.head))
    expect(count).toContainEqual(['gt', ['created_at', cutoff]])
    const unread = log.find((c) => c[0][0] === 'update' && 'unread_count' in (c[0][1][0] as object))
    expect(unread).toEqual([
      ['update', [{ unread_count: 1 }]],
      ['eq', ['id', 'conv']],
      ['gt', ['unread_count', 1]],
    ])
  })
})
