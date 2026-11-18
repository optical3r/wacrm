// ============================================================
// POST /api/v1/flows/{id}/start — { "conversation_id" } (flows:write).
// Starts an active flow for the contact of that conversation, like
// "Iniciar fluxo" in the inbox. Groups are refused; a contact already
// in a flow answers 409.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { readJsonObject } from '@/lib/api/v1/body';
import { startFlowManually } from '@/lib/flows/engine';

const REASONS = {
  flow_not_found: { status: 404, message: 'Flow not found' },
  flow_inactive: { status: 409, message: 'O fluxo não está ativo' },
  already_in_flow: { status: 409, message: 'O contato já está em um fluxo' },
  start_failed: { status: 500, message: 'Não foi possível iniciar o fluxo' },
} as const;

export const POST = apiRoute<{ id: string }>('flows:write', async (ctx, request, { id }) => {
  if (!isUuid(id)) return fail('not_found', 'Flow not found', 404);
  const body = await readJsonObject(request);
  if (!isUuid(body.conversation_id)) throw badRequest("'conversation_id' é obrigatório");
  const { data: conv } = await ctx.db
    .from('conversations')
    .select('id, contact_id, is_group')
    .eq('id', body.conversation_id)
    .maybeSingle();
  if (!conv || !conv.contact_id) return fail('not_found', 'Conversation not found', 404);
  if (conv.is_group) throw badRequest('Fluxos não rodam em grupos');

  // The engine checks the flow belongs to ctx.accountId.
  const result = await startFlowManually({
    accountId: ctx.accountId,
    flowId: id,
    conversationId: conv.id as string,
    contactId: conv.contact_id as string,
  });
  if (!result.ok) {
    const r = REASONS[result.reason];
    return fail(result.reason, r.message, r.status);
  }
  return ok({ flow_run_id: result.flow_run_id }, 201);
});
