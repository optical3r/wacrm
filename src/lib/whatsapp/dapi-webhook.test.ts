import { describe, expect, it } from 'vitest'
import { extractDapiGroupMessages, translateDapiWebhook } from './dapi-webhook'
import { decodeDapiMediaId } from './dapi'

const PNID = 'dapi:labcrm-acc1'

function firstChange(t: ReturnType<typeof translateDapiWebhook>) {
  return t.body!.entry[0].changes[0]
}

describe('translateDapiWebhook', () => {
  it('reads a Baileys text message', () => {
    const t = translateDapiWebhook(
      {
        event: 'messages.upsert',
        data: {
          messages: [
            {
              key: { remoteJid: '5571999990000@s.whatsapp.net', fromMe: false, id: 'ABC' },
              pushName: 'Ana',
              messageTimestamp: 1761480000,
              message: { conversation: 'Oi' },
            },
          ],
        },
      },
      PNID,
    )
    const change = firstChange(t)
    expect(change.field).toBe('messages')
    expect(change.value.metadata.phone_number_id).toBe(PNID)
    expect(change.value.messages![0]).toMatchObject({
      id: 'ABC',
      from: '5571999990000',
      timestamp: '1761480000',
      type: 'text',
      text: { body: 'Oi' },
    })
    expect(change.value.contacts![0]).toEqual({ wa_id: '5571999990000', profile: { name: 'Ana' } })
  })

  it('reads a whatsmeow image with case-different keys and encodes the media ref', () => {
    const t = translateDapiWebhook(
      {
        type: 'Message',
        data: {
          Info: { ID: 'IMG1', Chat: '5571988887777@s.whatsapp.net', IsFromMe: false, PushName: 'Bia', Timestamp: '2026-10-26T12:00:00Z' },
          Message: {
            imageMessage: { URL: 'https://mmg.whatsapp.net/x', mimetype: 'image/jpeg', mediaKey: 'S0VZ', fileSHA256: 'SEE=', fileLength: 1234, caption: 'foto' },
          },
        },
      },
      PNID,
    )
    const msg = firstChange(t).value.messages![0]
    expect(msg.type).toBe('image')
    expect(msg.image!.caption).toBe('foto')
    expect(msg.image!.mime_type).toBe('image/jpeg')
    const ref = decodeDapiMediaId(msg.image!.id)
    expect(ref).toMatchObject({ s: 'labcrm-acc1', url: 'https://mmg.whatsapp.net/x', media_key: 'S0VZ', file_sha256: 'SEE=', file_length: 1234 })
  })

  it('reads the flat ChatMessage shape', () => {
    const t = translateDapiWebhook(
      { event: 'message', data: { messageId: 'M1', chatId: '5571977776666@s.whatsapp.net', fromMe: false, senderName: 'Caio', timestamp: 1761480000000, type: 'text', content: 'Bom dia' } },
      PNID,
    )
    expect(firstChange(t).value.messages![0]).toMatchObject({ id: 'M1', from: '5571977776666', timestamp: '1761480000', text: { body: 'Bom dia' } })
  })

  it('skips groups', () => {
    const t = translateDapiWebhook(
      { event: 'messages.upsert', data: { key: { remoteJid: '1203630@g.us', id: 'G1' }, message: { conversation: 'x' } } },
      PNID,
    )
    expect(t.body).toBeNull()
  })

  it('turns fromMe into an echo addressed to the customer', () => {
    const t = translateDapiWebhook(
      { event: 'messages.upsert', data: { key: { remoteJid: '5571999990000@s.whatsapp.net', fromMe: true, id: 'OUT1' }, message: { conversation: 'Respondi pelo celular' } } },
      PNID,
    )
    const change = firstChange(t)
    expect(change.field).toBe('smb_message_echoes')
    expect(t.echoIds).toEqual(['OUT1'])
    const echo = (change.value as unknown as { message_echoes: Array<{ to: string; text: { body: string } }> }).message_echoes[0]
    expect(echo.to).toBe('5571999990000')
    expect(echo.text.body).toBe('Respondi pelo celular')
  })

  it('maps a quick-reply tap to a button_reply', () => {
    const t = translateDapiWebhook(
      {
        event: 'messages.upsert',
        data: {
          key: { remoteJid: '5571999990000@s.whatsapp.net', id: 'TAP' },
          message: { interactiveResponseMessage: { body: { text: 'Sim' }, nativeFlowResponseMessage: { paramsJson: '{"id":"btn_yes"}' } } },
        },
      },
      PNID,
    )
    expect(firstChange(t).value.messages![0].interactive).toEqual({ type: 'button_reply', button_reply: { id: 'btn_yes', title: 'Sim' } })
  })

  it('maps receipts to statuses', () => {
    const t = translateDapiWebhook(
      { event: 'messages.update', data: [{ key: { remoteJid: '5571999990000@s.whatsapp.net', id: 'OUT1' }, update: { status: 4 } }] },
      PNID,
    )
    expect(firstChange(t).value.statuses).toEqual([
      expect.objectContaining({ id: 'OUT1', status: 'read', recipient_id: '5571999990000' }),
    ])
  })

  it('maps whatsmeow receipts with several ids', () => {
    const t = translateDapiWebhook(
      { event: 'receipt', data: { MessageIDs: ['A', 'B'], Chat: '5571999990000@s.whatsapp.net', Type: 'delivered' } },
      PNID,
    )
    expect(firstChange(t).value.statuses!.map((s) => [s.id, s.status])).toEqual([['A', 'delivered'], ['B', 'delivered']])
  })

  it('detects connection events', () => {
    expect(translateDapiWebhook({ event: 'session.connected', data: { phone: '5571999990000' } }, PNID).connection)
      .toEqual({ status: 'connected', phone: '5571999990000' })
    expect(translateDapiWebhook({ event: 'connection.update', data: { connection: 'close' } }, PNID).connection)
      .toEqual({ status: 'disconnected', phone: undefined })
  })

  it('reads the documented messages.received envelope', () => {
    const t = translateDapiWebhook(
      {
        event: 'messages.received',
        sessionId: 'labcrm-acc1',
        timestamp: '2026-10-26T20:20:00.000Z',
        traceId: 'x',
        data: {
          id: '3EB0ABC',
          type: 'text',
          message: 'Olá, tudo bem?',
          timestamp: 1793044800000,
          fromMe: false,
          is_group: false,
          from: { jid: '5571988887777@s.whatsapp.net', name: 'Bia' },
          from_name: 'Bia',
          media_url: null,
        },
      },
      PNID,
    )
    const change = firstChange(t)
    expect(change.value.messages![0]).toMatchObject({ id: '3EB0ABC', from: '5571988887777', type: 'text', text: { body: 'Olá, tudo bem?' } })
    expect(change.value.contacts![0]).toEqual({ wa_id: '5571988887777', profile: { name: 'Bia' } })
  })

  it('reads documented delivery and read events', () => {
    const t = translateDapiWebhook({ event: 'message.read', data: { id: 'OUT9', to: { jid: '5571988887777@s.whatsapp.net' } } }, PNID)
    expect(firstChange(t).value.statuses).toEqual([expect.objectContaining({ id: 'OUT9', status: 'read', recipient_id: '5571988887777' })])
  })

  it('reads a documented image with a ready media_url', () => {
    const t = translateDapiWebhook(
      { event: 'messages.received', data: { id: 'I1', type: 'image', message: 'legenda', fromMe: false, from: { jid: '5571988887777@s.whatsapp.net' }, media_url: 'https://cdn.example/x.jpg', mimetype: 'image/jpeg' } },
      PNID,
    )
    const msg = firstChange(t).value.messages![0]
    expect(msg.type).toBe('image')
    expect(decodeDapiMediaId(msg.image!.id)).toMatchObject({ url: 'https://cdn.example/x.jpg' })
  })
})

describe('extractDapiGroupMessages', () => {
  it('reads a Baileys group message with its participant', () => {
    const payload = {
      event: 'messages.upsert',
      data: { key: { remoteJid: '120363000111@g.us', id: 'G1', participant: '5571911112222@s.whatsapp.net' }, pushName: 'Lia', message: { conversation: 'Oi grupo' } },
    }
    expect(translateDapiWebhook(payload, PNID).body).toBeNull()
    const [m] = extractDapiGroupMessages(payload, PNID)
    expect(m).toMatchObject({ id: 'G1', groupJid: '120363000111@g.us', fromMe: false, senderId: '5571911112222', senderName: 'Lia' })
    expect(m.message).toMatchObject({ type: 'text', text: { body: 'Oi grupo' }, from: '120363000111' })
  })

  it('reads the D-API envelope with is_group and group_name', () => {
    const payload = {
      event: 'messages.received',
      data: {
        id: '3EBG',
        type: 'text',
        message: 'Bom dia, equipe',
        timestamp: 1793044800000,
        fromMe: false,
        is_group: true,
        group_name: 'Vendas',
        from: { jid: '5571933334444@s.whatsapp.net', lid: '99887766@lid', name: 'Davi' },
        to: { jid: '120363000222@g.us', name: 'Vendas' },
      },
    }
    expect(translateDapiWebhook(payload, PNID).body).toBeNull()
    expect(extractDapiGroupMessages(payload, PNID)[0]).toMatchObject({
      id: '3EBG',
      groupJid: '120363000222@g.us',
      groupName: 'Vendas',
      senderId: '5571933334444',
      senderName: 'Davi',
      timestamp: '1793044800',
    })
  })

  it('keeps the opaque id when the phone is hidden', () => {
    const payload = {
      event: 'messages.received',
      data: { id: 'L1', type: 'text', message: 'x', is_group: true, chatId: '120363000333@g.us', from: { jid: '4455@lid', name: 'Eva' } },
    }
    expect(extractDapiGroupMessages(payload, PNID)[0]).toMatchObject({ groupJid: '120363000333@g.us', senderId: '4455@lid', senderName: 'Eva' })
  })

  it('marks our own group messages as fromMe with no sender', () => {
    const payload = {
      event: 'messages.sent',
      data: { id: 'S1', type: 'text', message: 'Enviado', fromMe: true, is_group: true, to: { jid: '120363000444@g.us' } },
    }
    expect(extractDapiGroupMessages(payload, PNID)[0]).toMatchObject({ id: 'S1', fromMe: true, senderId: null })
    expect(translateDapiWebhook(payload, PNID).body).toBeNull()
  })

  it('ignores one-to-one messages, receipts and connection events', () => {
    expect(
      extractDapiGroupMessages({ event: 'messages.received', data: { id: 'P1', type: 'text', message: 'oi', is_group: false, from: { jid: '5571988887777@s.whatsapp.net' } } }, PNID),
    ).toEqual([])
    expect(extractDapiGroupMessages({ event: 'message.read', data: { id: 'G1', to: { jid: '120363000111@g.us' } } }, PNID)).toEqual([])
    expect(extractDapiGroupMessages({ event: 'connection.status', data: { status: 'connected' } }, PNID)).toEqual([])
  })
})
