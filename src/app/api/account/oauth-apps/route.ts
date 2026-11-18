// ============================================================
// /api/account/oauth-apps — "Apps conectados" (Configurações › API).
//
//   GET     the live OAuth connections of the current workspace
//           (claude.ai and other apps a person allowed), with who
//           connected them and when they were last used.
//   DELETE  ?id=<grant>  disconnect one: its tokens stop working at once.
//
// admin+ only. oauth_grants has no RLS policies (service role only,
// migration 064), so every query here is filtered by the caller's
// account id.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { revokeGrant } from '@/lib/oauth/store';

export const runtime = 'nodejs';

interface GrantRow {
  id: string;
  client_id: string;
  user_id: string;
  allow_writes: boolean;
  created_at: string;
  last_used_at: string | null;
  refresh_expires_at: string | null;
}

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const db = supabaseAdmin();
    const { data, error } = await db
      .from('oauth_grants')
      .select('id, client_id, user_id, allow_writes, created_at, last_used_at, refresh_expires_at')
      .eq('account_id', ctx.accountId)
      .is('revoked_at', null)
      .gt('refresh_expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });
    if (error) {
      console.error('[GET /api/account/oauth-apps]', error.message);
      return NextResponse.json({ error: 'Não foi possível carregar os apps conectados' }, { status: 500 });
    }
    const grants = (data ?? []) as GrantRow[];

    const clientIds = [...new Set(grants.map((g) => g.client_id))];
    const userIds = [...new Set(grants.map((g) => g.user_id))];
    const [{ data: clients }, { data: people }] = await Promise.all([
      clientIds.length
        ? db.from('oauth_clients').select('client_id, client_name').in('client_id', clientIds)
        : Promise.resolve({ data: [] }),
      userIds.length
        ? db.from('profiles').select('user_id, full_name, email').in('user_id', userIds)
        : Promise.resolve({ data: [] }),
    ]);
    const clientName = new Map(
      ((clients ?? []) as Array<{ client_id: string; client_name: string | null }>).map((c) => [c.client_id, c.client_name])
    );
    const person = new Map(
      ((people ?? []) as Array<{ user_id: string; full_name: string | null; email: string | null }>).map((p) => [
        p.user_id,
        p.full_name || p.email || null,
      ])
    );

    return NextResponse.json({
      apps: grants.map((g) => ({
        id: g.id,
        name: clientName.get(g.client_id) || 'App sem nome',
        allow_writes: g.allow_writes,
        connected_by: person.get(g.user_id) ?? null,
        created_at: g.created_at,
        last_used_at: g.last_used_at,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'Informe o app' }, { status: 400 });
    const db = supabaseAdmin();
    const { data } = await db
      .from('oauth_grants')
      .select('id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!data) return NextResponse.json({ error: 'App não encontrado' }, { status: 404 });
    await revokeGrant(db, data.id as string);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
