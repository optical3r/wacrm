// ============================================================
// POST /api/v1/flows/{id}/status — { "status": "active" | "draft" |
// "archived" } (flows:write). Activating runs the same checks as the
// editor; a flow with problems answers 422 with the `issues` list.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { readJsonObject } from '@/lib/api/v1/body';
import { serializeFlow } from '@/lib/api/v1/flows';
import { FLOW_STATUSES, setFlowStatus, type FlowStatus } from '@/lib/flows/status-core';
import { NextResponse } from 'next/server';

export const POST = apiRoute<{ id: string }>('flows:write', async (ctx, request, { id }) => {
  if (!isUuid(id)) return fail('not_found', 'Flow not found', 404);
  const body = await readJsonObject(request);
  const status = body.status as FlowStatus;
  if (!FLOW_STATUSES.includes(status)) {
    throw badRequest(`'status' deve ser um de: ${FLOW_STATUSES.join(', ')}`);
  }
  // Vetted core: scopes by accountId itself.
  const result = await setFlowStatus(ctx.db.trusted, ctx.accountId, id, status);
  if (result.ok) return ok(serializeFlow(result.flow));
  if (result.reason === 'not_found') return fail('not_found', 'Flow not found', 404);
  if (result.reason === 'invalid') {
    return NextResponse.json(
      {
        error: { code: 'flow_invalid', message: 'O fluxo tem problemas e não pode ser ativado' },
        issues: result.issues,
      },
      { status: 422 }
    );
  }
  return fail('internal', 'Failed to change flow status', 500);
});
