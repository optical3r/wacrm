// ============================================================
// GET    /api/v1/pipelines/{id} — a pipeline with its stages (deals:read)
// PATCH  /api/v1/pipelines/{id} — rename { "name" }       (deals:write)
// DELETE /api/v1/pipelines/{id} — delete it AND all its deals (deals:write)
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, fail } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { readJsonObject, requiredString } from '@/lib/api/v1/body';
import { PIPELINE_COLUMNS, listStages, serializePipeline } from '@/lib/api/v1/deals';

type Row = Record<string, unknown>;
const notFound = () => fail('not_found', 'Pipeline not found', 404);

export const GET = apiRoute<{ id: string }>('deals:read', async (ctx, _request, { id }) => {
  if (!isUuid(id)) return notFound();
  const { data } = await ctx.db.from('pipelines').select(PIPELINE_COLUMNS).eq('id', id).maybeSingle();
  if (!data) return notFound();
  return ok(serializePipeline(data as Row, await listStages(ctx.db, id)));
});

export const PATCH = apiRoute<{ id: string }>('deals:write', async (ctx, request, { id }) => {
  if (!isUuid(id)) return notFound();
  const body = await readJsonObject(request);
  const name = requiredString(body, 'name', 80);
  const { data, error } = await ctx.db
    .from('pipelines')
    .update({ name })
    .eq('id', id)
    .select(PIPELINE_COLUMNS)
    .maybeSingle();
  if (error) return fail('internal', 'Failed to update pipeline', 500);
  if (!data) return notFound();
  return ok(serializePipeline(data as Row, await listStages(ctx.db, id)));
});

export const DELETE = apiRoute<{ id: string }>('deals:write', async (ctx, _request, { id }) => {
  if (!isUuid(id)) return notFound();
  // ON DELETE CASCADE removes the stages and the deals.
  const { data, error } = await ctx.db.from('pipelines').delete().eq('id', id).select('id').maybeSingle();
  if (error) return fail('internal', 'Failed to delete pipeline', 500);
  return data ? ok({ id: data.id, deleted: true }) : notFound();
});
