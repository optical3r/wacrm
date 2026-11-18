// ============================================================
// Message templates — plano Pro only (the Starter plan has no
// templates).
//
// GET  /api/v1/templates — list (templates:read)
//   ?status=APPROVED|PENDING|REJECTED|DRAFT|...  ?language=pt_BR
// POST /api/v1/templates — create and submit to Meta for approval
//   (templates:write). Body: name, category (Marketing | Utility),
//   language, body_text, and optionally header_type / header_content /
//   header_media_url, footer_text, buttons, sample_values — the same
//   payload the dashboard's template editor sends.
// ============================================================

import { apiRoute, requirePlan } from '@/lib/auth/api-context';
import { ok, okList, fail, badRequest } from '@/lib/api/v1/respond';
import { readJsonObject } from '@/lib/api/v1/body';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { TEMPLATE_COLUMNS, serializeTemplate } from '@/lib/api/v1/templates';
import { submitTemplate } from '@/lib/whatsapp/template-core';
import type { TemplatePayload } from '@/lib/whatsapp/template-validators';

const STATUSES = ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION'];

export const GET = apiRoute('templates:read', async (ctx, request) => {
  requirePlan(ctx, 'pro', 'Modelos de mensagem');
  const url = new URL(request.url);
  let query = ctx.db.from('message_templates').select(TEMPLATE_COLUMNS);
  const status = url.searchParams.get('status');
  if (status !== null) {
    if (!STATUSES.includes(status)) throw badRequest(`'status' deve ser um de: ${STATUSES.join(', ')}`);
    query = query.eq('status', status);
  }
  const language = url.searchParams.get('language');
  if (language !== null) {
    if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language)) throw badRequest("'language' inválido (ex.: pt_BR)");
    query = query.eq('language', language);
  }
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return fail('internal', 'Failed to list templates', 500);
  return okList(((data ?? []) as Record<string, unknown>[]).map(serializeTemplate), null);
});

export const POST = apiRoute('templates:write', async (ctx, request) => {
  requirePlan(ctx, 'pro', 'Modelos de mensagem');
  const body = await readJsonObject(request);
  // Vetted cores: both scope by accountId themselves.
  const userId = await resolveAuditUserId(ctx.db.trusted, ctx.accountId);
  const { template, dryRun } = await submitTemplate(ctx.db.trusted, ctx.accountId, userId, {
    ...body,
  } as unknown as TemplatePayload);
  return ok({ ...serializeTemplate(template), dry_run: dryRun }, 201);
});
