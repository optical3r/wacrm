// ============================================================
// POST /api/v1/pipelines/{id}/stages — add a stage at the end
//   { "name": "Proposta", "color": "#f97316" }        (deals:write)
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, fail } from '@/lib/api/v1/respond';
import { optionalColor, readJsonObject, requiredString } from '@/lib/api/v1/body';
import { STAGE_COLUMNS, serializeStage } from '@/lib/api/v1/deals';

export const POST = apiRoute<{ id: string }>('deals:write', async (ctx, request, { id }) => {
  const body = await readJsonObject(request);
  const name = requiredString(body, 'name', 60);
  const color = optionalColor(body) ?? '#3b82f6';
  const stages = await ctx.db.child('pipeline_stages', id, 'Pipeline');
  const { data: existing } = await stages.select('position');
  const next =
    ((existing ?? []) as { position: number }[]).reduce((m, s) => Math.max(m, Number(s.position) + 1), 0);
  const { data, error } = await stages
    .insert({ name, color, position: next })
    .select(STAGE_COLUMNS)
    .single();
  if (error || !data) return fail('internal', 'Failed to add stage', 500);
  return ok(serializeStage(data as Record<string, unknown>), 201);
});
