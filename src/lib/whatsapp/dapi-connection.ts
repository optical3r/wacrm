import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt } from './encryption'
import { DAPI_ACCESS_TOKEN, dapiClient, dapiPhoneNumberId, hasDapiApiKey } from './dapi'

/**
 * Bookkeeping shared by the D-API connect route and its webhook: keep
 * dapi_sessions and the account's whatsapp_config in step with the
 * session's state. Service-role client only.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any>

/** Save a connected session as the account's WhatsApp connection. Returns an error message, or null. */
export async function saveDapiConnection(
  admin: Admin,
  args: { accountId: string; userId: string | null; sessionId: string; phone: string | null },
): Promise<string | null> {
  const { accountId, userId, sessionId, phone } = args
  const now = new Date().toISOString()
  const phoneNumberId = dapiPhoneNumberId(sessionId)

  await admin
    .from('dapi_sessions')
    .update({ status: 'connected', ...(phone ? { phone } : {}), updated_at: now })
    .eq('account_id', accountId)

  const { data: existing } = await admin
    .from('whatsapp_config')
    .select('id, phone_number_id, status')
    .eq('account_id', accountId)
    .maybeSingle()
  if (existing?.phone_number_id === phoneNumberId && existing.status === 'connected') return null
  if (!existing && !userId) return null

  const fields = {
    phone_number_id: phoneNumberId,
    waba_id: null,
    access_token: encrypt(DAPI_ACCESS_TOKEN),
    status: 'connected',
    connected_at: now,
    registered_at: now,
    subscribed_apps_at: now,
    last_registration_error: null,
    updated_at: now,
  }
  const { error } = existing
    ? await admin.from('whatsapp_config').update(fields).eq('id', existing.id)
    : await admin.from('whatsapp_config').insert({ ...fields, account_id: accountId, user_id: userId })
  if (error) {
    console.error('[dapi] failed to save whatsapp_config:', error.message)
    return 'Não foi possível salvar a conexão.'
  }
  return null
}

/** Mark the session and the account's D-API connection as disconnected. History is kept. */
export async function markDapiDisconnected(admin: Admin, accountId: string): Promise<void> {
  const now = new Date().toISOString()
  await admin.from('dapi_sessions').update({ status: 'disconnected', updated_at: now }).eq('account_id', accountId)
  await admin
    .from('whatsapp_config')
    .update({ status: 'disconnected', updated_at: now })
    .eq('account_id', accountId)
    .like('phone_number_id', 'dapi:%')
}

/**
 * Log the account's D-API session out, if it has one. Best effort: used
 * by /admin when a plan change or a manual disconnect must drop the
 * number, and never fails the caller.
 */
export async function logoutDapiSession(admin: Admin, accountId: string): Promise<void> {
  try {
    const { data: row } = await admin
      .from('dapi_sessions')
      .select('session_id')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!row) return
    if (hasDapiApiKey()) {
      await dapiClient().sessions.delete(row.session_id).catch((err: unknown) => {
        console.warn('[dapi] logout failed:', err instanceof Error ? err.message : err)
      })
    }
    await markDapiDisconnected(admin, accountId)
  } catch (err) {
    console.warn('[dapi] logout skipped:', err instanceof Error ? err.message : err)
  }
}
