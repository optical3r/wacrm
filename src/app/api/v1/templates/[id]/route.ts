// ============================================================
// GET    /api/v1/templates/{id} — read a template   (templates:read)
// DELETE /api/v1/templates/{id} — delete on Meta and here
//                                                    (templates:write)
// Plano Pro only.
// ============================================================

import { apiRoute, requirePlan } from '@/lib/auth/api-context';
import { ok, fail } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { TEMPLATE_COLUMNS, serializeTemplate } from '@/lib/api/v1/templates';
import { deleteTemplate } from '@/lib/whatsapp/template-core';

const notFound = () => fail('not_found', 'Template not found', 404);

export const GET = apiRoute<{ id: string }>('templates:read', async (ctx, _request, { id }) => {
  requirePlan(ctx, 'pro', 'Modelos de mensagem');
  if (!isUuid(id)) return notFound();
  const { data } = await ctx.db.from('message_templates').select(TEMPLATE_COLUMNS).eq('id', id).maybeSingle();
  return data ? ok(serializeTemplate(data as Record<string, unknown>)) : notFound();
});

export const DELETE = apiRoute<{ id: string }>('templates:write', async (ctx, _request, { id }) => {
  requirePlan(ctx, 'pro', 'Modelos de mensagem');
  if (!isUuid(id)) return notFound();
  // Vetted core: scopes by accountId itself.
  const { deleted } = await deleteTemplate(ctx.db.trusted, ctx.accountId, id);
  return deleted ? ok({ id, deleted: true }) : notFound();
});
