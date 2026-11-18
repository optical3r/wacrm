// ============================================================
// Account-scoped database access for the public API and the MCP.
//
// Public-API callers have no Supabase session, so their requests run
// with the service-role client, which ignores RLS. Isolation between
// accounts therefore lives HERE: every read, update and delete on an
// account table gets `account_id = <the key's account>`, every insert
// gets that account_id stamped on, and child tables (rows with no
// account_id of their own) are reached only through a parent row that
// is first proven to belong to the account.
//
// Routes under /api/v1 and the MCP tools must go through this module.
// `account-db.guard.test.ts` fails the build if one reaches the
// service-role client directly. The one escape hatch, `trusted`, is
// for vetted internal libraries that already take an accountId and
// scope by it (send core, broadcast core); its uses are allow-listed
// in that same test.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from '@/lib/api/v1/respond';

/** Tables that carry their own `account_id`. */
export const ACCOUNT_TABLES = [
  'ai_configs',
  'ai_knowledge_chunks',
  'ai_knowledge_documents',
  'ai_usage_log',
  'api_keys',
  'automation_logs',
  'automations',
  'broadcasts',
  'contact_notes',
  'contacts',
  'conversations',
  'custom_fields',
  'deals',
  'flow_runs',
  'flows',
  'lead_rotation',
  'message_templates',
  'notifications',
  'pipelines',
  'quick_replies',
  'tags',
  'webhook_endpoints',
  'whatsapp_channel_members',
  'whatsapp_config',
  'account_memberships',
] as const;
export type AccountTable = (typeof ACCOUNT_TABLES)[number];

/** Tables reached through a parent row, and the column that points at it. */
export const CHILD_TABLES = {
  messages: { parent: 'conversations', fk: 'conversation_id' },
  pipeline_stages: { parent: 'pipelines', fk: 'pipeline_id' },
  contact_tags: { parent: 'contacts', fk: 'contact_id' },
  contact_custom_values: { parent: 'contacts', fk: 'contact_id' },
  broadcast_recipients: { parent: 'broadcasts', fk: 'broadcast_id' },
  flow_nodes: { parent: 'flows', fk: 'flow_id' },
  flow_run_events: { parent: 'flow_runs', fk: 'flow_run_id' },
  message_reactions: { parent: 'conversations', fk: 'conversation_id' },
  automation_steps: { parent: 'automations', fk: 'automation_id' },
} as const satisfies Record<string, { parent: AccountTable; fk: string }>;
export type ChildTable = keyof typeof CHILD_TABLES;

type Row = Record<string, unknown>;

// supabase-js builders are deeply generic; the API layer works with
// untyped rows, so the scoped builders are typed loosely on purpose.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Builder = any;

export interface ScopedTable {
  select(columns?: string, options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): Builder;
  insert(rows: Row | Row[]): Builder;
  upsert(rows: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }): Builder;
  update(patch: Row): Builder;
  delete(): Builder;
}

export interface AccountDb {
  readonly accountId: string;
  /** An account table, filtered to this account. */
  from(table: AccountTable): ScopedTable;
  /**
   * A child table under one parent row. Throws a 404 ApiError when the
   * parent does not exist in this account, so a foreign id behaves
   * exactly like a missing one.
   */
  child(table: ChildTable, parentId: string, parentName?: string): Promise<ScopedTable>;
  /** True when `id` is a row of `table` in this account. */
  owns(table: AccountTable, id: string): Promise<boolean>;
  /**
   * The raw service-role client, for vetted internal libraries that
   * take `accountId` and scope by it themselves. Allow-listed.
   */
  readonly trusted: SupabaseClient;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function notFound(what = 'Resource'): ApiError {
  return new ApiError('not_found', `${what} not found`, 404);
}

/** Drop any caller-supplied account_id and stamp ours. */
function stamp(rows: Row | Row[], accountId: string): Row | Row[] {
  const one = (r: Row) => ({ ...withoutAccount(r), account_id: accountId });
  return Array.isArray(rows) ? rows.map(one) : one(rows);
}

function withoutAccount(r: Row): Row {
  const rest = { ...r };
  delete rest.account_id;
  return rest;
}

export function createAccountDb(admin: SupabaseClient, accountId: string): AccountDb {
  if (!isUuid(accountId)) throw new Error('createAccountDb: invalid accountId');

  const from = (table: AccountTable): ScopedTable => ({
    select: (columns = '*', options) =>
      admin.from(table).select(columns, options).eq('account_id', accountId),
    insert: (rows) => admin.from(table).insert(stamp(rows, accountId)),
    upsert: (rows, options) => admin.from(table).upsert(stamp(rows, accountId), options),
    update: (patch) => admin.from(table).update(withoutAccount(patch)).eq('account_id', accountId),
    delete: () => admin.from(table).delete().eq('account_id', accountId),
  });

  const owns = async (table: AccountTable, id: string): Promise<boolean> => {
    if (!isUuid(id)) return false;
    const { data, error } = await admin
      .from(table)
      .select('id')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ApiError('internal', 'Database error', 500);
    return Boolean(data);
  };

  const child = async (
    table: ChildTable,
    parentId: string,
    parentName?: string
  ): Promise<ScopedTable> => {
    const { parent, fk } = CHILD_TABLES[table];
    if (!(await owns(parent, parentId))) throw notFound(parentName);
    const pin = (r: Row) => ({ ...r, [fk]: parentId });
    return {
      select: (columns = '*', options) => admin.from(table).select(columns, options).eq(fk, parentId),
      insert: (rows) => admin.from(table).insert(Array.isArray(rows) ? rows.map(pin) : pin(rows)),
      upsert: (rows, options) =>
        admin.from(table).upsert(Array.isArray(rows) ? rows.map(pin) : pin(rows), options),
      update: (patch) => {
        const rest = { ...patch };
        delete rest[fk];
        return admin.from(table).update(rest).eq(fk, parentId);
      },
      delete: () => admin.from(table).delete().eq(fk, parentId),
    };
  };

  return { accountId, from, child, owns, trusted: admin };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
