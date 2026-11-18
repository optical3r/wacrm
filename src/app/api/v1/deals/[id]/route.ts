// ============================================================
// GET    /api/v1/deals/{id} — read a deal                   (deals:read)
// PATCH  /api/v1/deals/{id} — edit, move or close it        (deals:write)
//   Any of the POST fields, plus "status": open|won|lost. To move to
//   another pipeline send pipeline_id (and optionally stage_id); a
//   stage_id alone must belong to the deal's current pipeline.
// DELETE /api/v1/deals/{id} — delete it                     (deals:write)
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { readJsonObject } from '@/lib/api/v1/body';
import { DEAL_COLUMNS, readDealFields, resolveStage, serializeDeal } from '@/lib/api/v1/deals';

const notFound = () => fail('not_found', 'Deal not found', 404);

export const GET = apiRoute<{ id: string }>('deals:read', async (ctx, _request, { id }) => {
  if (!isUuid(id)) return notFound();
  const { data } = await ctx.db.from('deals').select(DEAL_COLUMNS).eq('id', id).maybeSingle();
  return data ? ok(serializeDeal(data as Record<string, unknown>)) : notFound();
});

export const PATCH = apiRoute<{ id: string }>('deals:write', async (ctx, request, { id }) => {
  if (!isUuid(id)) return notFound();
  const { data: current } = await ctx.db.from('deals').select('id, pipeline_id').eq('id', id).maybeSingle();
  if (!current) return notFound();

  const body = await readJsonObject(request);
  const patch = await readDealFields(ctx.db, body);
  if ('pipeline_id' in body || 'stage_id' in body) {
    const pipelineId = 'pipeline_id' in body ? body.pipeline_id : current.pipeline_id;
    Object.assign(patch, await resolveStage(ctx.db, pipelineId, body.stage_id));
  }
  if (Object.keys(patch).length === 0) throw badRequest('Nada para atualizar');
  patch.updated_at = new Date().toISOString();

  const { data, error } = await ctx.db
    .from('deals')
    .update(patch)
    .eq('id', id)
    .select(DEAL_COLUMNS)
    .maybeSingle();
  if (error) return fail('internal', 'Failed to update deal', 500);
  return data ? ok(serializeDeal(data as Record<string, unknown>)) : notFound();
});

export const DELETE = apiRoute<{ id: string }>('deals:write', async (ctx, _request, { id }) => {
  if (!isUuid(id)) return notFound();
  const { data, error } = await ctx.db.from('deals').delete().eq('id', id).select('id').maybeSingle();
  if (error) return fail('internal', 'Failed to delete deal', 500);
  return data ? ok({ id: data.id, deleted: true }) : notFound();
});
