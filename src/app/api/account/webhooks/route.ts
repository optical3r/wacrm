// ============================================================
// /api/account/webhooks — the webhooks screen (Configurações › API e MCP).
//
//   GET   the workspace's endpoints (no secrets)
//   POST  { url, events } → creates one; the signing secret comes back
//         once, like through POST /api/v1/webhooks.
//
// admin+ only. webhook_endpoints has RLS (admin+ writes, migration
// 028), so these go through the caller's own session client.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { encrypt } from '@/lib/whatsapp/encryption';
import { normalizeEvents } from '@/lib/webhooks/events';
import {
  MAX_WEBHOOK_ENDPOINTS,
  WEBHOOK_PUBLIC_COLUMNS,
  generateWebhookSecret,
  normalizeWebhookUrl,
  serializeWebhookEndpoint,
} from '@/lib/webhooks/endpoints';

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false });
    if (error) {
      console.error('[GET /api/account/webhooks]', error.message);
      return NextResponse.json({ error: 'Não foi possível carregar os webhooks' }, { status: 500 });
    }
    return NextResponse.json({
      webhooks: ((data ?? []) as Record<string, unknown>[]).map(serializeWebhookEndpoint),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const url = normalizeWebhookUrl(body?.url);
    if (!url) return NextResponse.json({ error: 'Informe um endereço https:// válido' }, { status: 400 });
    const events = normalizeEvents(body?.events);
    if (!events) return NextResponse.json({ error: 'Escolha pelo menos um evento' }, { status: 400 });

    const { count } = await ctx.supabase
      .from('webhook_endpoints')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', ctx.accountId);
    if ((count ?? 0) >= MAX_WEBHOOK_ENDPOINTS) {
      return NextResponse.json(
        { error: `Limite de ${MAX_WEBHOOK_ENDPOINTS} webhooks por workspace` },
        { status: 400 }
      );
    }

    const secret = generateWebhookSecret();
    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .insert({ account_id: ctx.accountId, created_by: ctx.userId, url, secret: encrypt(secret), events })
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .single();
    if (error || !data) {
      console.error('[POST /api/account/webhooks]', error?.message);
      return NextResponse.json({ error: 'Não foi possível criar o webhook' }, { status: 500 });
    }
    return NextResponse.json({ webhook: serializeWebhookEndpoint(data as Record<string, unknown>), secret }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
