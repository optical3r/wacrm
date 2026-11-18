// Shared shapes for the v1 flow and automation endpoints.

export const FLOW_COLUMNS =
  'id, name, description, status, trigger_type, trigger_config, entry_node_id, execution_count, last_executed_at, created_at, updated_at';

export function serializeFlow(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    status: row.status as string,
    trigger_type: row.trigger_type as string,
    trigger_config: row.trigger_config ?? {},
    entry_node_key: (row.entry_node_id as string | null) ?? null,
    execution_count: Number(row.execution_count ?? 0),
    last_executed_at: (row.last_executed_at as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

export const RUN_COLUMNS =
  'id, flow_id, contact_id, conversation_id, status, current_node_key, vars, started_at, last_advanced_at, ended_at, end_reason';

export const RUN_STATUSES = ['active', 'completed', 'handed_off', 'timed_out', 'paused_by_agent', 'failed'] as const;

export const AUTOMATION_COLUMNS =
  'id, name, description, trigger_type, trigger_config, is_active, execution_count, last_executed_at, created_at, updated_at';

export const AUTOMATION_LOG_COLUMNS = 'id, contact_id, trigger_event, steps_executed, status, error_message, created_at';
