// ============================================================
// Change a flow's status (draft / active / archived), shared by the
// dashboard (/api/flows/[id]/activate) and the public API.
//
// Takes accountId and scopes every query by it, so the public API may
// pass the service-role client (vetted core, see
// account-db.guard.test.ts). Activating runs the full validator and
// the trigger-conflict check; drafts and archives are unconditional.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { findTriggerConflicts, validateFlowForActivation } from '@/lib/flows/validate'

export type FlowStatus = 'draft' | 'active' | 'archived'
export const FLOW_STATUSES: readonly FlowStatus[] = ['draft', 'active', 'archived']

type Issue = ReturnType<typeof validateFlowForActivation>[number]

export type SetFlowStatusResult =
  | { ok: true; flow: Record<string, unknown> }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid'; issues: Issue[] }
  | { ok: false; reason: 'error'; message: string }

export async function setFlowStatus(
  db: SupabaseClient,
  accountId: string,
  flowId: string,
  status: FlowStatus,
): Promise<SetFlowStatusResult> {
  const { data: flow } = await db
    .from('flows')
    .select('id, account_id, name, trigger_type, trigger_config, entry_node_id')
    .eq('id', flowId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!flow) return { ok: false, reason: 'not_found' }

  if (status === 'active') {
    const { data: nodes } = await db
      .from('flow_nodes')
      .select('node_key, node_type, config')
      .eq('flow_id', flowId)
    const issues = validateFlowForActivation(
      flow as {
        name: string
        trigger_type: 'keyword' | 'first_inbound_message' | 'manual'
        trigger_config: Record<string, unknown>
        entry_node_id: string | null
      },
      (nodes ?? []) as Array<{ node_key: string; node_type: string; config: Record<string, unknown> }>,
    )
    // Another active flow answering the same message would silently win.
    const { data: others } = await db
      .from('flows')
      .select('name, trigger_type, trigger_config')
      .eq('account_id', accountId)
      .eq('status', 'active')
      .neq('id', flowId)
    issues.push(
      ...findTriggerConflicts(
        flow as { name: string; trigger_type: string; trigger_config: Record<string, unknown> },
        (others ?? []) as Array<{ name: string; trigger_type: string; trigger_config: Record<string, unknown> }>,
      ),
    )
    if (issues.some((i) => i.severity === 'error')) {
      return { ok: false, reason: 'invalid', issues }
    }
  }

  const { data: updated, error } = await db
    .from('flows')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', flowId)
    .eq('account_id', accountId)
    .select()
    .maybeSingle()
  if (error) return { ok: false, reason: 'error', message: error.message }
  if (!updated) return { ok: false, reason: 'not_found' }
  return { ok: true, flow: updated as Record<string, unknown> }
}
