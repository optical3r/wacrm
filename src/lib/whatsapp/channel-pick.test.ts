import { describe, expect, it } from 'vitest'
import { pickSendChannel, type ChannelLike } from './channel-pick'

const ana: ChannelLike = { id: 'ch-ana', owner_user_id: 'u-ana', status: 'connected', is_default: true, created_at: '2026-01-01' }
const bruno: ChannelLike = { id: 'ch-bruno', owner_user_id: 'u-bruno', status: 'connected', is_default: false, created_at: '2026-01-02' }
const carlosOff: ChannelLike = { id: 'ch-carlos', owner_user_id: 'u-carlos', status: 'disconnected', is_default: false, created_at: '2026-01-03' }
const all = [bruno, carlosOff, ana]

describe('pickSendChannel — Pro', () => {
  it('uses the single official number whatever the context', () => {
    expect(pickSendChannel([ana], { plan: 'pro', role: 'agent', userId: 'u-x' }).id).toBe('ch-ana')
  })
})

describe('pickSendChannel — Starter agent', () => {
  it('always sends through their own number', () => {
    const ch = pickSendChannel(all, { plan: 'starter', role: 'agent', userId: 'u-bruno', lastChannelId: 'ch-ana', assignedAgentId: 'u-ana' })
    expect(ch.id).toBe('ch-bruno')
  })

  it('refuses another member\'s number', () => {
    expect(() =>
      pickSendChannel(all, { plan: 'starter', role: 'agent', userId: 'u-bruno', requestedChannelId: 'ch-ana' }),
    ).toThrow(expect.objectContaining({ code: 'channel_forbidden' }))
  })

  it('needs a number of their own', () => {
    expect(() => pickSendChannel(all, { plan: 'starter', role: 'agent', userId: 'u-new' })).toThrow(
      expect.objectContaining({ code: 'no_own_channel' }),
    )
  })

  it('cannot send while their number is disconnected', () => {
    expect(() => pickSendChannel(all, { plan: 'starter', role: 'agent', userId: 'u-carlos' })).toThrow(
      expect.objectContaining({ code: 'channel_disconnected' }),
    )
  })
})

describe('pickSendChannel — Starter owner / admin and automations', () => {
  it('takes the chosen number', () => {
    expect(pickSendChannel(all, { plan: 'starter', role: 'admin', userId: 'u-boss', requestedChannelId: 'ch-bruno' }).id).toBe('ch-bruno')
  })

  it('refuses a chosen number that is disconnected or not in the account', () => {
    expect(() => pickSendChannel(all, { plan: 'starter', role: 'owner', requestedChannelId: 'ch-carlos' })).toThrow(
      expect.objectContaining({ code: 'channel_disconnected' }),
    )
    expect(() => pickSendChannel(all, { plan: 'starter', role: 'owner', requestedChannelId: 'nope' })).toThrow(
      expect.objectContaining({ code: 'channel_not_found' }),
    )
  })

  it('defaults to the responsible agent\'s number, then the last number used, then the default', () => {
    expect(pickSendChannel(all, { plan: 'starter', role: 'admin', assignedAgentId: 'u-bruno', lastChannelId: 'ch-ana' }).id).toBe('ch-bruno')
    expect(pickSendChannel(all, { plan: 'starter', assignedAgentId: 'u-carlos', lastChannelId: 'ch-bruno' }).id).toBe('ch-bruno')
    expect(pickSendChannel(all, { plan: 'starter' }).id).toBe('ch-ana')
  })

  it('reports no connected number', () => {
    expect(() => pickSendChannel([carlosOff], { plan: 'starter' })).toThrow(expect.objectContaining({ code: 'channel_disconnected' }))
    expect(() => pickSendChannel([], { plan: 'starter' })).toThrow(expect.objectContaining({ code: 'whatsapp_not_configured' }))
  })
})

describe('pickSendChannel — WhatsApp groups', () => {
  it('lets an agent write only when their number is in the group', () => {
    expect(pickSendChannel(all, { plan: 'starter', role: 'agent', userId: 'u-bruno', groupChannelIds: ['ch-bruno'] }).id).toBe('ch-bruno')
    expect(() => pickSendChannel(all, { plan: 'starter', role: 'agent', userId: 'u-ana', groupChannelIds: ['ch-bruno'] })).toThrow(
      expect.objectContaining({ code: 'not_in_group' }),
    )
  })

  it('limits owner / admin to the numbers in the group', () => {
    expect(pickSendChannel(all, { plan: 'starter', role: 'admin', userId: 'u-owner', groupChannelIds: ['ch-bruno'] }).id).toBe('ch-bruno')
    expect(() =>
      pickSendChannel(all, { plan: 'starter', role: 'admin', userId: 'u-owner', requestedChannelId: 'ch-ana', groupChannelIds: ['ch-bruno'] }),
    ).toThrow(expect.objectContaining({ code: 'not_in_group' }))
  })

  it('refuses when no number of the account is in the group', () => {
    expect(() => pickSendChannel(all, { plan: 'starter', role: 'admin', groupChannelIds: [] })).toThrow(
      expect.objectContaining({ code: 'not_in_group' }),
    )
  })
})
