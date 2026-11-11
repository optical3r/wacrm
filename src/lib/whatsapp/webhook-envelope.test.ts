import { describe, expect, it } from 'vitest'
import { describeShape, unwrapWebhookBody } from './webhook-envelope'

const value = {
  messaging_product: 'whatsapp',
  metadata: { display_phone_number: '557193166600', phone_number_id: '139' },
  contacts: [{ profile: { name: 'R' }, wa_id: '5571991525334' }],
  messages: [{ id: 'wamid.1', from: '5571991525334', type: 'text', text: { body: 'Oi' } }],
}
const meta = { object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value }] }] }

describe('unwrapWebhookBody', () => {
  it('keeps a Meta body', () => {
    expect(unwrapWebhookBody(meta)).toEqual({ entry: meta.entry })
  })

  it('opens envelopes around the Meta body', () => {
    expect(unwrapWebhookBody({ event: 'messages', payload: meta })).toEqual({ entry: meta.entry })
    expect(unwrapWebhookBody({ event: 'messages', data: meta })).toEqual({ entry: meta.entry })
    expect(unwrapWebhookBody({ body: JSON.stringify(meta) })).toEqual({ entry: meta.entry })
  })

  it('rebuilds the entry from a bare change value', () => {
    const out = unwrapWebhookBody({ event: 'messages', waba_id: 'w1', data: value })
    expect(out?.entry[0].id).toBe('w1')
    expect(out?.entry[0].changes[0]).toEqual({ field: 'messages', value })
  })

  it('rebuilds the entry from a single change', () => {
    const out = unwrapWebhookBody({ event: 'messages', data: { field: 'messages', value } })
    expect(out?.entry[0].changes[0].value).toEqual(value)
  })

  it('names the field of a bare value, the way Coexy sends it', () => {
    expect(unwrapWebhookBody(value)?.entry[0].changes[0].field).toBe('messages')
    const echo = { messaging_product: 'whatsapp', metadata: value.metadata, message_echoes: [{ id: 'wamid.2' }] }
    expect(unwrapWebhookBody(echo)?.entry[0].changes[0].field).toBe('smb_message_echoes')
    const tpl = { event: 'APPROVED', message_template_id: 1, message_template_name: 'x' }
    expect(unwrapWebhookBody(tpl)?.entry[0].changes[0].field).toBe('message_template_status_update')
    const quality = { message_template_id: 1, previous_quality_score: 'GREEN', new_quality_score: 'YELLOW' }
    expect(unwrapWebhookBody(quality)?.entry[0].changes[0].field).toBe('message_template_quality_update')
  })

  it('returns null for anything else', () => {
    expect(unwrapWebhookBody({ event: 'account_update', data: { foo: 1 } })).toBeNull()
    expect(unwrapWebhookBody(null)).toBeNull()
  })
})

describe('describeShape', () => {
  it('lists keys without values', () => {
    expect(describeShape({ event: 'x', data: { secret: 'y' } })).toBe('{event:string,data:{secret:string}}')
  })
})
