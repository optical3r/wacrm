// ============================================================
// Message-template submit / delete, shared by the dashboard routes
// (/api/whatsapp/templates/*) and the public API (/api/v1/templates).
//
// Both functions take an accountId and scope every query by it, so the
// public API may hand them the service-role client (vetted core, see
// account-db.guard.test.ts). Caller-visible failures are thrown as
// TemplateError with an HTTP status.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { deleteMessageTemplate, submitMessageTemplate } from '@/lib/whatsapp/meta-api';
import { validateTemplatePayload, type TemplatePayload } from '@/lib/whatsapp/template-validators';
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components';
import { ensureMediaHeaderHandle } from '@/lib/whatsapp/template-header-handle';
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize';
import { getT } from '@/lib/i18n/translate';

const t = getT('Api');

export class TemplateError extends Error {
  readonly status: number;
  readonly code?: string;
  /** Set when Meta accepted the template but the local save failed. */
  readonly metaTemplateId?: string;
  constructor(message: string, status: number, extra?: { code?: string; metaTemplateId?: string }) {
    super(message);
    this.name = 'TemplateError';
    this.status = status;
    this.code = extra?.code;
    this.metaTemplateId = extra?.metaTemplateId;
  }
}

export function isTemplatesDryRun(): boolean {
  return (
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'
  );
}

function buildUpsertRow(
  accountId: string,
  userId: string,
  payload: TemplatePayload,
  extras: { status: string; metaTemplateId: string | null; submissionError: string | null }
) {
  return {
    account_id: accountId,
    // Original author, audit only.
    user_id: userId,
    name: payload.name,
    category: payload.category,
    language: payload.language,
    header_type: payload.header_type ?? null,
    header_content: payload.header_content ?? null,
    header_media_url: payload.header_media_url ?? null,
    header_handle: payload.header_handle ?? null,
    body_text: payload.body_text,
    footer_text: payload.footer_text ?? null,
    buttons: payload.buttons ?? null,
    sample_values: payload.sample_values ?? null,
    status: extras.status,
    meta_template_id: extras.metaTemplateId,
    submission_error: extras.submissionError,
    // Cleared on every (re)submit; the webhook sets it again on rejection.
    rejection_reason: null,
    last_submitted_at: new Date().toISOString(),
  };
}

function upsertTemplateRow(db: SupabaseClient, row: ReturnType<typeof buildUpsertRow>) {
  // TODO(account-sharing): conflict target is still the legacy
  // (user_id, name, language) unique index.
  return db
    .from('message_templates')
    .upsert(row, { onConflict: 'user_id,name,language' })
    .select()
    .single();
}

/** The account's default number (several per Starter account since 051). */
async function defaultConfig(db: SupabaseClient, accountId: string) {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return error ? null : data;
}

/**
 * Validate a template, submit it to Meta for approval and save it.
 * Returns the saved row. On a Meta failure the row is kept as DRAFT
 * with the error, and a TemplateError (502, or 429) is thrown.
 */
export async function submitTemplate(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  payload: TemplatePayload
): Promise<{ template: Record<string, unknown>; dryRun: boolean }> {
  if (!payload || typeof payload !== 'object') {
    throw new TemplateError(t('templates.invalidJsonBody'), 400);
  }
  if (payload.category === 'Authentication') {
    throw new TemplateError(t('templates.authNotSupported'), 400);
  }
  try {
    validateTemplatePayload(payload);
  } catch (e) {
    throw new TemplateError(e instanceof Error ? e.message : t('templates.validationFailed'), 400);
  }

  const dryRun = isTemplatesDryRun();
  let metaTemplateId: string;
  let metaStatus: string;

  if (dryRun) {
    metaTemplateId = `dry-run-${crypto.randomUUID()}`;
    metaStatus = 'PENDING';
  } else {
    const config = await defaultConfig(db, accountId);
    if (!config) throw new TemplateError(t('common.whatsappNotConfiguredConnect'), 400);
    if (!config.waba_id) throw new TemplateError(t('common.wabaIdMissing'), 400);
    const accessToken = decrypt(config.access_token);

    // Media headers need a Resumable-Upload handle (Meta refuses a URL).
    try {
      await ensureMediaHeaderHandle(payload, accessToken);
    } catch (e) {
      throw new TemplateError(e instanceof Error ? e.message : t('templates.headerUploadFailed'), 400);
    }

    try {
      const meta = await submitMessageTemplate({
        wabaId: config.waba_id,
        accessToken,
        payload: buildMetaTemplatePayload(payload),
      });
      metaTemplateId = meta.id;
      metaStatus = meta.status;
    } catch (e) {
      const message = e instanceof Error ? e.message : t('templates.metaSubmitFailed');
      // Keep the attempt so the user can fix and retry.
      await upsertTemplateRow(
        db,
        buildUpsertRow(accountId, userId, payload, {
          status: 'DRAFT',
          metaTemplateId: null,
          submissionError: message,
        })
      );
      const isRateLimit = /\b429\b/.test(message);
      throw new TemplateError(isRateLimit ? t('templates.rateLimit') : message, isRateLimit ? 429 : 502, {
        code: isRateLimit ? 'rate_limited' : 'meta_error',
      });
    }
  }

  const { data: row, error } = await upsertTemplateRow(
    db,
    buildUpsertRow(accountId, userId, payload, {
      status: normalizeStatus(metaStatus),
      metaTemplateId,
      submissionError: null,
    })
  );
  if (error || !row) {
    // Submitted on Meta, not saved here: "Sync from Meta" recovers it.
    throw new TemplateError(
      t('templates.submittedSaveFailed', { message: error?.message ?? '' }),
      500,
      { metaTemplateId }
    );
  }
  return { template: row as Record<string, unknown>, dryRun };
}

/**
 * Delete a template on Meta (when it was submitted) and locally.
 * Returns false when the id is not a template of this account.
 */
export async function deleteTemplate(
  db: SupabaseClient,
  accountId: string,
  id: string
): Promise<{ deleted: boolean; dryRun: boolean }> {
  const dryRun = isTemplatesDryRun();
  const { data: existing, error: lookupErr } = await db
    .from('message_templates')
    .select('id, name, meta_template_id')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (lookupErr || !existing) return { deleted: false, dryRun };

  if (existing.meta_template_id && !dryRun) {
    const config = await defaultConfig(db, accountId);
    if (!config || !config.waba_id) throw new TemplateError(t('templates.notConfiguredDelete'), 400);
    try {
      await deleteMessageTemplate({
        wabaId: config.waba_id,
        accessToken: decrypt(config.access_token),
        name: existing.name,
        metaTemplateId: existing.meta_template_id,
      });
    } catch (e) {
      throw new TemplateError(e instanceof Error ? e.message : t('templates.metaDeleteFailed'), 502, {
        code: 'meta_error',
      });
    }
  }

  const { error: delErr } = await db
    .from('message_templates')
    .delete()
    .eq('id', id)
    .eq('account_id', accountId);
  if (delErr) {
    throw new TemplateError(t('templates.deletedLocalFailed', { message: delErr.message }), 500);
  }
  return { deleted: true, dryRun };
}
