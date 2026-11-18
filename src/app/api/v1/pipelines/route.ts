// ============================================================
// GET  /api/v1/pipelines — list pipelines with their stages (deals:read)
// POST /api/v1/pipelines — create one (deals:write)
//   { "name": "Vendas", "stages": [{ "name": "Novo", "color": "#3b82f6" }] }
//   Without `stages` the dashboard's default five are created.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, okList, fail, badRequest } from '@/lib/api/v1/respond';
import { readJsonObject, requiredString } from '@/lib/api/v1/body';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import {
  DEFAULT_STAGES,
  PIPELINE_COLUMNS,
  STAGE_COLUMNS,
  serializePipeline,
} from '@/lib/api/v1/deals';

type Row = Record<string, unknown>;
const HEX = /^#[0-9a-f]{6}$/i;

export const GET = apiRoute('deals:read', async (ctx) => {
  const { data, error } = await ctx.db
    .from('pipelines')
    .select(PIPELINE_COLUMNS)
    .order('created_at', { ascending: true });
  if (error) return fail('internal', 'Failed to list pipelines', 500);
  const pipelines = (data ?? []) as Row[];
  const out = [];
  for (const p of pipelines) {
    const stages = await ctx.db.child('pipeline_stages', p.id as string, 'Pipeline');
    const { data: rows } = await stages.select(STAGE_COLUMNS);
    out.push(serializePipeline(p, (rows ?? []) as Row[]));
  }
  return okList(out, null);
});

export const POST = apiRoute('deals:write', async (ctx, request) => {
  const body = await readJsonObject(request);
  const name = requiredString(body, 'name', 80);

  let stages: { name: string; color: string }[] = DEFAULT_STAGES.map((s) => ({ ...s }));
  if ('stages' in body) {
    if (!Array.isArray(body.stages) || body.stages.length === 0 || body.stages.length > 20) {
      throw badRequest("'stages' deve ser uma lista de 1 a 20 etapas");
    }
    stages = body.stages.map((s, i) => {
      const n = typeof s?.name === 'string' ? s.name.trim() : '';
      if (!n || n.length > 60) throw badRequest(`Etapa ${i + 1}: 'name' é obrigatório (até 60 caracteres)`);
      const c = typeof s?.color === 'string' && HEX.test(s.color) ? s.color.toLowerCase() : '#3b82f6';
      return { name: n, color: c };
    });
  }

  // Vetted core: scopes by accountId itself.
  const userId = await resolveAuditUserId(ctx.db.trusted, ctx.accountId);
  const { data: pipeline, error } = await ctx.db
    .from('pipelines')
    .insert({ name, user_id: userId })
    .select(PIPELINE_COLUMNS)
    .single();
  if (error || !pipeline) return fail('internal', 'Failed to create pipeline', 500);

  const child = await ctx.db.child('pipeline_stages', pipeline.id as string, 'Pipeline');
  const { data: rows, error: stErr } = await child
    .insert(stages.map((s, position) => ({ name: s.name, color: s.color, position })))
    .select(STAGE_COLUMNS);
  if (stErr) return fail('internal', 'Pipeline created, but its stages failed', 500);

  return ok(serializePipeline(pipeline as Row, (rows ?? []) as Row[]), 201);
});
