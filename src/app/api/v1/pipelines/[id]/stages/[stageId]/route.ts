// ============================================================
// PATCH  /api/v1/pipelines/{id}/stages/{stageId} — rename, recolor or
//        move { "name"?, "color"?, "position"? }         (deals:write)
// DELETE /api/v1/pipelines/{id}/stages/{stageId} — only when no deal
//        sits in it                                       (deals:write)
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { optionalColor, optionalString, readJsonObject } from '@/lib/api/v1/body';
import { STAGE_COLUMNS, serializeStage } from '@/lib/api/v1/deals';

type P = { id: string; stageId: string };
const notFound = () => fail('not_found', 'Stage not found', 404);

export const PATCH = apiRoute<P>('deals:write', async (ctx, request, { id, stageId }) => {
  if (!isUuid(stageId)) return notFound();
  const body = await readJsonObject(request);
  const stages = await ctx.db.child('pipeline_stages', id, 'Pipeline');
  const { data: all } = await stages.select(STAGE_COLUMNS).order('position', { ascending: true });
  const list = (all ?? []) as Record<string, unknown>[];
  const current = list.find((s) => s.id === stageId);
  if (!current) return notFound();

  const patch: Record<string, unknown> = {};
  const name = optionalString(body, 'name', 60);
  if (name === null || name === '') throw badRequest("'name' não pode ficar vazio");
  if (name !== undefined) patch.name = name;
  const color = optionalColor(body);
  if (color) patch.color = color;

  if ('position' in body) {
    const pos = body.position;
    if (typeof pos !== 'number' || !Number.isInteger(pos) || pos < 0) {
      throw badRequest("'position' deve ser um inteiro a partir de 0");
    }
    // Re-number the whole pipeline so positions stay 0..n-1.
    const order = list.filter((s) => s.id !== stageId);
    order.splice(Math.min(pos, order.length), 0, current);
    for (const [i, s] of order.entries()) {
      if (Number(s.position) !== i && s.id !== stageId) {
        await stages.update({ position: i }).eq('id', s.id);
      }
      if (s.id === stageId) patch.position = i;
    }
  }
  if (Object.keys(patch).length === 0) throw badRequest('Nada para atualizar');

  const { data, error } = await stages.update(patch).eq('id', stageId).select(STAGE_COLUMNS).maybeSingle();
  if (error) return fail('internal', 'Failed to update stage', 500);
  return data ? ok(serializeStage(data as Record<string, unknown>)) : notFound();
});

export const DELETE = apiRoute<P>('deals:write', async (ctx, _request, { id, stageId }) => {
  if (!isUuid(stageId)) return notFound();
  const stages = await ctx.db.child('pipeline_stages', id, 'Pipeline');
  const { data: stage } = await stages.select('id').eq('id', stageId).maybeSingle();
  if (!stage) return notFound();
  const { count } = await ctx.db
    .from('deals')
    .select('id', { count: 'exact', head: true })
    .eq('stage_id', stageId);
  if (count && count > 0) {
    throw badRequest('Há negócios nesta etapa. Mova ou apague os negócios antes.');
  }
  const { error } = await stages.delete().eq('id', stageId);
  if (error) return fail('internal', 'Failed to delete stage', 500);
  return ok({ id: stageId, deleted: true });
});
