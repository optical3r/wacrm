// ============================================================
// GET   /api/v1/automations/{id} — an automation with its steps
//       (automations:read)
// PATCH /api/v1/automations/{id} — { "is_active": true|false }
//       (automations:write). Turning on runs the same checks as the
//       editor; problems answer 400 with `issues`.
// ============================================================

import { NextResponse } from 'next/server';

import { apiRoute } from '@/lib/auth/api-context';
import { ok, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { readJsonObject } from '@/lib/api/v1/body';
import { AUTOMATION_COLUMNS } from '@/lib/api/v1/flows';
import { loadStepsTree } from '@/lib/automations/steps-tree';
import { validateStepsForActivation, validateTriggerForActivation } from '@/lib/automations/validate';

const notFound = () => fail('not_found', 'Automation not found', 404);

export const GET = apiRoute<{ id: string }>('automations:read', async (ctx, _request, { id }) => {
  if (!isUuid(id)) return notFound();
  const { data } = await ctx.db.from('automations').select(AUTOMATION_COLUMNS).eq('id', id).maybeSingle();
  if (!data) return notFound();
  // Ownership proven above; the tree loader reads by automation id.
  return ok({ ...data, steps: await loadStepsTree(id) });
});

export const PATCH = apiRoute<{ id: string }>('automations:write', async (ctx, request, { id }) => {
  if (!isUuid(id)) return notFound();
  const body = await readJsonObject(request);
  if (typeof body.is_active !== 'boolean') throw badRequest("'is_active' deve ser true ou false");
  const { data: existing } = await ctx.db
    .from('automations')
    .select('id, trigger_type, trigger_config')
    .eq('id', id)
    .maybeSingle();
  if (!existing) return notFound();

  if (body.is_active) {
    const issues = [
      ...validateTriggerForActivation(existing.trigger_type as string, existing.trigger_config),
      ...validateStepsForActivation(await loadStepsTree(id)),
    ];
    if (issues.length > 0) {
      return NextResponse.json(
        { error: { code: 'automation_invalid', message: 'A automação tem problemas e não pode ser ligada' }, issues },
        { status: 400 }
      );
    }
  }

  const { data, error } = await ctx.db
    .from('automations')
    .update({ is_active: body.is_active, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(AUTOMATION_COLUMNS)
    .maybeSingle();
  if (error) return fail('internal', 'Failed to update automation', 500);
  return data ? ok(data) : notFound();
});
