// ============================================================
// GET /api/v1/reports/summary — the dashboard numbers for a period
// (reports:read). ?days=1..365 (default 30), counted back from now.
//
//   conversations: open / pending / closed now, opened in the period,
//                  and open ones per owner
//   contacts:      total and created in the period
//   deals:         open now (count + value), won and lost in the
//                  period (count + value, by last update)
//   flows:         runs started, completed and handed off in the period
//   broadcasts:    sent in the period with their totals (Pro)
//
// Groups are left out of every count.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, badRequest } from '@/lib/api/v1/respond';

type Row = Record<string, unknown>;
const sum = (rows: Row[], key: string) => rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);

export const GET = apiRoute('reports:read', async (ctx, request) => {
  const raw = new URL(request.url).searchParams.get('days');
  const days = raw === null ? 30 : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw badRequest("'days' deve ser de 1 a 365");
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const db = ctx.db;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const count = async (q: PromiseLike<any>) => {
    const { count: c, error } = (await q) as { count: number | null; error: unknown };
    if (error) throw new Error('report query failed');
    return c ?? 0;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = async (q: PromiseLike<any>) => {
    const { data, error } = (await q) as { data: Row[] | null; error: unknown };
    if (error) throw new Error('report query failed');
    return data ?? [];
  };
  const head = { count: 'exact' as const, head: true };

  const [
    open, pending, closed, openedInPeriod, openRows,
    contactsTotal, contactsNew,
    dealsOpen, dealsWon, dealsLost,
    runs, broadcasts,
  ] = await Promise.all([
    count(db.from('conversations').select('id', head).eq('is_group', false).eq('status', 'open')),
    count(db.from('conversations').select('id', head).eq('is_group', false).eq('status', 'pending')),
    count(db.from('conversations').select('id', head).eq('is_group', false).eq('status', 'closed')),
    count(db.from('conversations').select('id', head).eq('is_group', false).gte('created_at', since)),
    rows(db.from('conversations').select('owner_ids').eq('is_group', false).eq('status', 'open')),
    count(db.from('contacts').select('id', head).eq('is_group', false)),
    count(db.from('contacts').select('id', head).eq('is_group', false).gte('created_at', since)),
    rows(db.from('deals').select('value').eq('status', 'open')),
    rows(db.from('deals').select('value').eq('status', 'won').gte('updated_at', since)),
    rows(db.from('deals').select('value').eq('status', 'lost').gte('updated_at', since)),
    rows(db.from('flow_runs').select('status').gte('started_at', since)),
    ctx.plan === 'pro'
      ? rows(
          db
            .from('broadcasts')
            .select('total_recipients, sent_count, delivered_count, read_count, replied_count, failed_count')
            .gte('created_at', since)
        )
      : Promise.resolve([] as Row[]),
  ]);

  const perOwner: Record<string, number> = {};
  let unassigned = 0;
  for (const r of openRows) {
    const owners = (r.owner_ids as string[] | null) ?? [];
    if (!owners.length) unassigned += 1;
    for (const o of owners) perOwner[o] = (perOwner[o] ?? 0) + 1;
  }
  const runsBy = (s: string) => runs.filter((r) => r.status === s).length;

  return ok({
    period: { days, since },
    conversations: {
      open, pending, closed,
      opened_in_period: openedInPeriod,
      open_by_owner: perOwner,
      open_unassigned: unassigned,
    },
    contacts: { total: contactsTotal, created_in_period: contactsNew },
    deals: {
      open: { count: dealsOpen.length, value: sum(dealsOpen, 'value') },
      won_in_period: { count: dealsWon.length, value: sum(dealsWon, 'value') },
      lost_in_period: { count: dealsLost.length, value: sum(dealsLost, 'value') },
    },
    flows: {
      runs_started: runs.length,
      completed: runsBy('completed'),
      handed_off: runsBy('handed_off'),
      timed_out: runsBy('timed_out'),
      active: runsBy('active'),
    },
    broadcasts:
      ctx.plan === 'pro'
        ? {
            count: broadcasts.length,
            recipients: sum(broadcasts, 'total_recipients'),
            sent: sum(broadcasts, 'sent_count'),
            delivered: sum(broadcasts, 'delivered_count'),
            read: sum(broadcasts, 'read_count'),
            replied: sum(broadcasts, 'replied_count'),
            failed: sum(broadcasts, 'failed_count'),
          }
        : null,
  });
});
