// ============================================================
// GET /api/v1/broadcasts/{id}/recipients — who got the broadcast and
// how far each one went (broadcasts:read), keyset-paginated.
//   ?status=pending|sent|delivered|read|replied|failed
// Each row carries the contact's name and phone. Plano Pro only.
// ============================================================

import { apiRoute, requirePlan } from '@/lib/auth/api-context';
import { okList, fail, badRequest } from '@/lib/api/v1/respond';
import { parseListParams, keysetFilter, buildPage } from '@/lib/api/v1/pagination';
import { RECIPIENT_COLUMNS, RECIPIENT_STATUSES } from '@/lib/api/v1/broadcasts';

type Row = Record<string, unknown>;

export const GET = apiRoute<{ id: string }>('broadcasts:read', async (ctx, request, { id }) => {
  requirePlan(ctx, 'pro', 'Disparos');
  const { limit, cursor } = parseListParams(request);
  const status = new URL(request.url).searchParams.get('status');
  const recipients = await ctx.db.child('broadcast_recipients', id, 'Broadcast');
  let query = recipients.select(RECIPIENT_COLUMNS);
  if (status !== null) {
    if (!(RECIPIENT_STATUSES as readonly string[]).includes(status)) {
      throw badRequest(`'status' deve ser um de: ${RECIPIENT_STATUSES.join(', ')}`);
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
  if (error) return fail('internal', 'Failed to list recipients', 500);
  const { items, nextCursor } = buildPage(
    (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
    limit
  );

  // Contact name/phone, read through the account scope.
  const ids = [...new Set((items as unknown as Row[]).map((r) => r.contact_id).filter(Boolean))] as string[];
  const contacts = new Map<string, Row>();
  if (ids.length) {
    const { data: rows } = await ctx.db.from('contacts').select('id, name, phone').in('id', ids);
    for (const c of (rows ?? []) as Row[]) contacts.set(c.id as string, c);
  }
  return okList(
    (items as unknown as Row[]).map((r) => {
      const c = contacts.get(r.contact_id as string);
      return { ...r, contact: c ? { id: c.id, name: c.name ?? null, phone: c.phone } : null };
    }),
    nextCursor
  );
});
