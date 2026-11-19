// ============================================================
// GET /api/account/api-usage — "Uso" in Configurações › API e MCP.
//
// Calls and errors of the last 30 days per credential
// (API key or connected app), plus the latest errors, all from
// api_request_log (migrations 062 and 065). admin+; read with the
// service role and always filtered by the caller's account.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';

interface SummaryRow {
  key_id: string | null;
  oauth_grant_id: string | null;
  via: string;
  calls: number;
  errors: number;
  last_at: string;
}

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const db = supabaseAdmin();

    const [summaryRes, errorsRes] = await Promise.all([
      db.rpc('api_usage_summary', { p_account: ctx.accountId, p_days: 30 }),
      db
        .from('api_request_log')
        .select('key_id, oauth_grant_id, via, method, route, status, created_at')
        .eq('account_id', ctx.accountId)
        .gte('status', 400)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);
    if (summaryRes.error) console.warn('[api-usage] summary:', summaryRes.error.message);

    const summary = ((summaryRes.data ?? []) as SummaryRow[]).map((r) => ({
      ...r,
      calls: Number(r.calls),
      errors: Number(r.errors),
    }));

    // Names for the credentials, from this account only.
    const keyIds = [...new Set(summary.map((r) => r.key_id).filter(Boolean))] as string[];
    const grantIds = [...new Set(summary.map((r) => r.oauth_grant_id).filter(Boolean))] as string[];
    const [keysRes, grantsRes] = await Promise.all([
      keyIds.length
        ? db.from('api_keys').select('id, name').eq('account_id', ctx.accountId).in('id', keyIds)
        : Promise.resolve({ data: [] }),
      grantIds.length
        ? db.from('oauth_grants').select('id, client_id').eq('account_id', ctx.accountId).in('id', grantIds)
        : Promise.resolve({ data: [] }),
    ]);
    const keyName = new Map(((keysRes.data ?? []) as Array<{ id: string; name: string }>).map((k) => [k.id, k.name]));
    const grants = (grantsRes.data ?? []) as Array<{ id: string; client_id: string }>;
    const clientIds = [...new Set(grants.map((g) => g.client_id))];
    const { data: clients } = clientIds.length
      ? await db.from('oauth_clients').select('client_id, client_name').in('client_id', clientIds)
      : { data: [] };
    const clientName = new Map(
      ((clients ?? []) as Array<{ client_id: string; client_name: string | null }>).map((c) => [c.client_id, c.client_name])
    );
    const grantName = new Map(grants.map((g) => [g.id, clientName.get(g.client_id) || 'App conectado']));

    const label = (keyId: string | null, grantId: string | null) =>
      keyId ? (keyName.get(keyId) ?? 'Chave apagada') : grantId ? (grantName.get(grantId) ?? 'App desconectado') : 'Sem credencial';

    // One line per credential, API and MCP calls added up.
    const byCredential = new Map<string, { name: string; kind: 'key' | 'app'; calls: number; errors: number; mcp_calls: number; last_at: string }>();
    for (const r of summary) {
      const id = r.key_id ?? r.oauth_grant_id ?? 'none';
      const cur = byCredential.get(id) ?? {
        name: label(r.key_id, r.oauth_grant_id),
        kind: r.oauth_grant_id ? ('app' as const) : ('key' as const),
        calls: 0,
        errors: 0,
        mcp_calls: 0,
        last_at: r.last_at,
      };
      cur.calls += r.calls;
      cur.errors += r.errors;
      if (r.via === 'mcp') cur.mcp_calls += r.calls;
      if (r.last_at > cur.last_at) cur.last_at = r.last_at;
      byCredential.set(id, cur);
    }

    return NextResponse.json({
      total: summary.reduce((n, r) => n + r.calls, 0),
      errors: summary.reduce((n, r) => n + r.errors, 0),
      credentials: [...byCredential.values()].sort((a, b) => b.calls - a.calls),
      recent_errors: ((errorsRes.data ?? []) as Array<Record<string, unknown>>).map((e) => ({
        credential: label((e.key_id as string) ?? null, (e.oauth_grant_id as string) ?? null),
        via: e.via,
        method: e.method,
        route: e.route,
        status: e.status,
        created_at: e.created_at,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
