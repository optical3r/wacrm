import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./dapi', async (orig) => {
  const actual = await orig<typeof import('./dapi')>()
  return {
    ...actual,
    dapiSendText: vi.fn(async () => ({ messageId: 'dapi-msg' })),
    dapiMediaUrl: vi.fn(async () => ({ url: 'https://s3/x', mimeType: 'image/jpeg', fileSize: 10 })),
  }
})

import { downloadMedia, getMediaUrl, sendTemplateMessage, sendTextMessage, sendTypingIndicator } from './meta-api'
import { dapiSendText } from './dapi'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

afterEach(() => fetchMock.mockReset())

describe('meta-api routing for D-API (Starter) connections', () => {
  it('sends text through D-API and never calls Meta', async () => {
    const res = await sendTextMessage({ phoneNumberId: 'dapi:labcrm-a', accessToken: 'dapi', to: '5571999990000', text: 'oi' })
    expect(res.messageId).toBe('dapi-msg')
    expect(dapiSendText).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: 'dapi:labcrm-a', to: '5571999990000', text: 'oi' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses templates', async () => {
    await expect(
      sendTemplateMessage({ phoneNumberId: 'dapi:labcrm-a', accessToken: 'dapi', to: '1', templateName: 't' }),
    ).rejects.toThrow(/Starter/)
  })

  it('skips the typing indicator', async () => {
    await sendTypingIndicator({ phoneNumberId: 'dapi:labcrm-a', accessToken: 'dapi', messageId: 'm' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves D-API media ids and downloads without a bearer header', async () => {
    const info = await getMediaUrl({ mediaId: 'dapi.eyJzIjoieCJ9', accessToken: 'dapi' })
    expect(info.url).toBe('https://s3/x')
    fetchMock.mockResolvedValue(new Response('abc', { headers: { 'content-type': 'image/jpeg' } }))
    await downloadMedia({ downloadUrl: info.url, accessToken: 'dapi' })
    expect(fetchMock).toHaveBeenCalledWith('https://s3/x', { headers: {} })
  })
})
