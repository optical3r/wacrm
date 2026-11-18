// ============================================================
// GET  /api/v1/deals — list deals (deals:read), keyset-paginated.
//   Filters: ?pipeline_id= &stage_id= &status=open|won|lost
//            &contact_id= &assigned_to=
// POST /api/v1/deals — create a deal (deals:write)
//   { "title", "pipeline_id", "stage_id"?, "value"?, "currency"?,
//     "contact_id"?, "conversation_id"?, "assigned_to"?, "notes"?,
//     "expected_close_date"? }
//   Without stage_id the deal goes to the pipeline's first stage;
//   without currency, the account's default currency.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, okList, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/core/db';
import { readJsonObject } from '@/lib/api/v1/body';
import { parseListParams, keysetFilter, buildPage } from '@/lib/api/v1/pagination';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import {
  DEAL_COLUMNS,
  DEAL_STATUSES,
  getAccountCurrency,
  readDealFields,
  resolveStage,
  serializeDeal,
} from '@/lib/api/v1/deals';

export const GET = apiRoute('deals:read', async (ctx, request) => {
  const { limit, cursor } = parseListParams(request);
  const url = new URL(request.url);
  let query = ctx.db.from('deals').select(DEAL_COLUMNS);

  for (const key of ['pipeline_id', 'stage_id', 'contact_id', 'assigned_to']) {
    const v = url.searchParams.get(key);
    if (v === null) continue;
    if (!isUuid(v)) throw badRequest(`'${key}' deve ser um ID`);
    query = query.eq(key, v);
  }
  const status = url.searchParams.get('status');
  if (status !== null) {
    if (!(DEAL_STATUSES as readonly string[]).includes(status)) {
      throw badRequest(`'status' deve ser um de: ${DEAL_STATUSES.join(', ')}`);
    }
    query = query.eq('status', status);
  }

  query = query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);
  const kf = keysetFilter(cursor);
  if (kf) query = query.or(kf);

  const { data, error } = await query;
  if (error) {
    console.error('[api/v1/deals] list error:', error);
    return fail('internal', 'Failed to list deals', 500);
  }
  const { items, nextCursor } = buildPage(
    (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
    limit
  );
  return okList(items.map((r) => serializeDeal(r as unknown as Record<string, unknown>)), nextCursor);
});

export const POST = apiRoute('deals:write', async (ctx, request) => {
  const body = await readJsonObject(request);
  if (typeof body.title !== 'string' || !body.title.trim()) throw badRequest("'title' é obrigatório");
  const fields = await readDealFields(ctx.db, body);
  const placement = await resolveStage(ctx.db, body.pipeline_id, body.stage_id);

  // Vetted cores: both scope by accountId themselves.
  const userId = await resolveAuditUserId(ctx.db.trusted, ctx.accountId);
  const currency = fields.currency ?? (await getAccountCurrency(ctx.db.trusted, ctx.accountId));

  const { data, error } = await ctx.db
    .from('deals')
    .insert({
      value: 0,
      status: 'open',
      ...fields,
      ...placement,
      currency,
      user_id: userId,
    })
    .select(DEAL_COLUMNS)
    .single();
  if (error || !data) {
    console.error('[api/v1/deals] create error:', error);
    return fail('internal', 'Failed to create deal', 500);
  }
  return ok(serializeDeal(data as Record<string, unknown>), 201);
});
