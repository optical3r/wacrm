import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt } from './encryption'
import { DAPI_ACCESS_TOKEN, dapiClient, dapiPhoneNumberId, hasDapiApiKey } from './dapi'

/**
 * Bookkeeping shared by the D-API connect route and its webhook: keep
 * dapi_sessions and whatsapp_config in step with each session's state.
 * Every member of a Starter account has their own session and their own
 * whatsapp_config row (migration 051). Service-role client only.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any>

export const NUMBER_LIMIT_MESSAGE = 'Esta conta já usa todos os números do plano. Fale com o suporte para aumentar o limite.'

/** Postgres error raised by enforce_whatsapp_number_limit (migration 051). */
export function isNumberLimitError(error: { message?: string; hint?: string } | null | undefined): boolean {
  return Boolean(error && (error.hint === 'whatsapp_number_limit' || /number limit reached/.test(error.message ?? '')))
}

/**
 * Save a connected session as its owner's number. Returns an error
 * message, or null.
 */
export async function saveDapiConnection(
  admin: Admin,
  args: { accountId: string; ownerUserId: string | null; sessionId: string; phone: string | null },
): Promise<string | null> {
  const { accountId, ownerUserId, sessionId, phone } = args
  const now = new Date().toISOString()
  const phoneNumberId = dapiPhoneNumberId(sessionId)

  await admin
    .from('dapi_sessions')
    .update({ status: 'connected', ...(phone ? { phone } : {}), updated_at: now })
    .eq('session_id', sessionId)

  if (!ownerUserId) return null

  const { data: existing } = await admin
    .from('whatsapp_config')
    .select('id, phone_number_id, status')
    .eq('account_id', accountId)
    .eq('owner_user_id', ownerUserId)
    .maybeSingle()
  if (existing?.phone_number_id === phoneNumberId && existing.status === 'connected') return null

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

  if (existing) {
    const { error } = await admin.from('whatsapp_config').update(fields).eq('id', existing.id)
    if (error) {
      console.error('[dapi] failed to update whatsapp_config:', error.message)
      return 'Não foi possível salvar a conexão.'
    }
    return null
  }

  const { data: hasDefault } = await admin
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    .eq('is_default', true)
    .limit(1)
    .maybeSingle()
  const { error } = await admin.from('whatsapp_config').insert({
    ...fields,
    account_id: accountId,
    user_id: ownerUserId,
    owner_user_id: ownerUserId,
    is_default: !hasDefault,
  })
  if (error) {
    if (isNumberLimitError(error)) return NUMBER_LIMIT_MESSAGE
    console.error('[dapi] failed to save whatsapp_config:', error.message)
    return 'Não foi possível salvar a conexão.'
  }
  return null
}

/** Mark one session and its number as disconnected. History is kept. */
export async function markDapiDisconnected(admin: Admin, sessionId: string): Promise<void> {
  const now = new Date().toISOString()
  await admin.from('dapi_sessions').update({ status: 'disconnected', updated_at: now }).eq('session_id', sessionId)
  await admin
    .from('whatsapp_config')
    .update({ status: 'disconnected', updated_at: now })
    .eq('phone_number_id', dapiPhoneNumberId(sessionId))
}

/**
 * Log D-API sessions out: all of the account's, or only one member's.
 * Best effort: used by /admin (plan change, manual disconnect) and when a
 * member leaves the account, and never fails the caller.
 */
export async function logoutDapiSession(
  admin: Admin,
  accountId: string,
  opts: { ownerUserId?: string } = {},
): Promise<void> {
  try {
    let query = admin.from('dapi_sessions').select('session_id').eq('account_id', accountId)
    if (opts.ownerUserId) query = query.eq('owner_user_id', opts.ownerUserId)
    const { data: rows } = await query
    for (const row of (rows ?? []) as Array<{ session_id: string }>) {
      if (hasDapiApiKey()) {
        await dapiClient().sessions.delete(row.session_id).catch((err: unknown) => {
          console.warn('[dapi] logout failed:', err instanceof Error ? err.message : err)
        })
      }
      await markDapiDisconnected(admin, row.session_id)
    }
    // A member's number whose session record is gone still reads as
    // disconnected. (/admin marks every number of the account itself.)
    if (opts.ownerUserId) {
      await admin
        .from('whatsapp_config')
        .update({ status: 'disconnected', updated_at: new Date().toISOString() })
        .eq('account_id', accountId)
        .eq('owner_user_id', opts.ownerUserId)
        .like('phone_number_id', 'dapi:%')
    }
  } catch (err) {
    console.warn('[dapi] logout skipped:', err instanceof Error ? err.message : err)
  }
}
