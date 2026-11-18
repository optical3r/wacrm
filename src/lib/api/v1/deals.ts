// ============================================================
// Shared shapes and checks for the v1 pipeline and deal endpoints.
//
// Deals point at a pipeline, one of its stages, and optionally a
// contact, a conversation and an assignee. Every one of those ids is
// caller input, so each is proven to belong to the key's account
// before it is written: a foreign id is refused exactly like a
// missing one.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { AccountDb } from '@/lib/api/core/db';
import { isUuid } from '@/lib/api/core/db';
import { badRequest } from '@/lib/api/v1/respond';
import type { JsonBody } from '@/lib/api/v1/body';

export const PIPELINE_COLUMNS = 'id, name, created_at';
export const STAGE_COLUMNS = 'id, pipeline_id, name, position, color, created_at';
export const DEAL_COLUMNS =
  'id, title, value, currency, status, notes, expected_close_date, pipeline_id, stage_id, contact_id, conversation_id, assigned_to, created_at, updated_at';

export const DEAL_STATUSES = ['open', 'won', 'lost'] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

/** Stages a new pipeline gets when the caller names none (same as the dashboard). */
export const DEFAULT_STAGES = [
  { name: 'Novo lead', color: '#3b82f6' },
  { name: 'Qualificado', color: '#eab308' },
  { name: 'Proposta enviada', color: '#f97316' },
  { name: 'Negociação', color: '#8b5cf6' },
  { name: 'Ganho', color: '#22c55e' },
] as const;

type Row = Record<string, unknown>;

export interface ApiStage {
  id: string;
  name: string;
  position: number;
  color: string;
}

export function serializeStage(row: Row): ApiStage {
  return {
    id: row.id as string,
    name: row.name as string,
    position: Number(row.position ?? 0),
    color: row.color as string,
  };
}

export function serializePipeline(row: Row, stages: Row[]) {
  return {
    id: row.id as string,
    name: row.name as string,
    created_at: row.created_at as string,
    stages: stages
      .map(serializeStage)
      .sort((a, b) => a.position - b.position),
  };
}

export function serializeDeal(row: Row) {
  return {
    id: row.id as string,
    title: row.title as string,
    value: Number(row.value ?? 0),
    currency: (row.currency as string | null) ?? null,
    status: (row.status as string | null) ?? 'open',
    notes: (row.notes as string | null) ?? null,
    expected_close_date: (row.expected_close_date as string | null) ?? null,
    pipeline_id: row.pipeline_id as string,
    stage_id: row.stage_id as string,
    contact_id: (row.contact_id as string | null) ?? null,
    conversation_id: (row.conversation_id as string | null) ?? null,
    assigned_to: (row.assigned_to as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

/** The stages of one pipeline of this account (404 when the pipeline is not ours). */
export async function listStages(db: AccountDb, pipelineId: string): Promise<Row[]> {
  const stages = await db.child('pipeline_stages', pipelineId, 'Pipeline');
  const { data, error } = await stages.select(STAGE_COLUMNS).order('position', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
}

/** Refuse an id that is not a row of this account. */
async function requireOwned(
  db: AccountDb,
  table: 'contacts' | 'conversations',
  id: unknown,
  key: string
): Promise<void> {
  if (!isUuid(id) || !(await db.owns(table, id))) {
    throw badRequest(`'${key}' não existe nesta conta`);
  }
}

/** Refuse a user id that is not a member of this account. */
export async function requireMember(db: AccountDb, userId: unknown, key: string): Promise<void> {
  if (!isUuid(userId)) throw badRequest(`'${key}' não é membro desta conta`);
  const { data } = await db.from('account_memberships').select('user_id').eq('user_id', userId).maybeSingle();
  if (!data) throw badRequest(`'${key}' não é membro desta conta`);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read and check the editable deal fields from a body. Only keys that
 * are present land in the patch. Pipeline/stage are resolved by the
 * caller (they depend on the deal's current pipeline).
 */
export async function readDealFields(db: AccountDb, body: JsonBody): Promise<Row> {
  const patch: Row = {};
  if ('title' in body) {
    const v = body.title;
    if (typeof v !== 'string' || !v.trim()) throw badRequest("'title' não pode ficar vazio");
    if (v.trim().length > 200) throw badRequest("'title' passa de 200 caracteres");
    patch.title = v.trim();
  }
  if ('value' in body) {
    const v = body.value;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw badRequest("'value' deve ser um número maior ou igual a zero");
    }
    patch.value = v;
  }
  if ('currency' in body) {
    const v = body.currency;
    if (typeof v !== 'string' || !/^[A-Z]{3}$/.test(v)) {
      throw badRequest("'currency' deve ser um código de 3 letras, como BRL");
    }
    patch.currency = v;
  }
  if ('notes' in body) {
    const v = body.notes;
    if (v !== null && typeof v !== 'string') throw badRequest("'notes' deve ser texto ou null");
    if (typeof v === 'string' && v.length > 5000) throw badRequest("'notes' passa de 5000 caracteres");
    patch.notes = typeof v === 'string' && v.trim() ? v.trim() : null;
  }
  if ('expected_close_date' in body) {
    const v = body.expected_close_date;
    if (v !== null && (typeof v !== 'string' || !DATE.test(v))) {
      throw badRequest("'expected_close_date' deve ser AAAA-MM-DD ou null");
    }
    patch.expected_close_date = v;
  }
  if ('status' in body) {
    const v = body.status;
    if (!(DEAL_STATUSES as readonly unknown[]).includes(v)) {
      throw badRequest(`'status' deve ser um de: ${DEAL_STATUSES.join(', ')}`);
    }
    patch.status = v;
  }
  if ('contact_id' in body) {
    if (body.contact_id !== null) await requireOwned(db, 'contacts', body.contact_id, 'contact_id');
    patch.contact_id = body.contact_id;
  }
  if ('conversation_id' in body) {
    if (body.conversation_id !== null) {
      await requireOwned(db, 'conversations', body.conversation_id, 'conversation_id');
    }
    patch.conversation_id = body.conversation_id;
  }
  if ('assigned_to' in body) {
    if (body.assigned_to !== null) await requireMember(db, body.assigned_to, 'assigned_to');
    patch.assigned_to = body.assigned_to;
  }
  return patch;
}

/**
 * Resolve the (pipeline, stage) a deal should sit in. A stage must
 * belong to the pipeline; with no stage the first one is used.
 */
export async function resolveStage(
  db: AccountDb,
  pipelineId: unknown,
  stageId: unknown
): Promise<{ pipeline_id: string; stage_id: string }> {
  if (!isUuid(pipelineId) || !(await db.owns('pipelines', pipelineId))) {
    throw badRequest("'pipeline_id' não existe nesta conta");
  }
  const stages = await listStages(db, pipelineId);
  if (stageId === undefined || stageId === null) {
    if (!stages.length) throw badRequest('Este funil não tem etapas');
    return { pipeline_id: pipelineId, stage_id: stages[0].id as string };
  }
  if (!stages.some((s) => s.id === stageId)) {
    throw badRequest("'stage_id' não é uma etapa deste funil");
  }
  return { pipeline_id: pipelineId, stage_id: stageId as string };
}

/**
 * The account's default currency (accounts is keyed by id, so it is
 * read here, scoped by accountId). Vetted core.
 */
export async function getAccountCurrency(db: SupabaseClient, accountId: string): Promise<string> {
  const { data } = await db.from('accounts').select('default_currency').eq('id', accountId).maybeSingle();
  return (data?.default_currency as string | undefined) ?? 'BRL';
}
