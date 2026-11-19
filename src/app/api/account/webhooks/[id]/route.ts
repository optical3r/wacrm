// PATCH  /api/account/webhooks/{id}  { url?, events?, is_active? }
// DELETE /api/account/webhooks/{id}
// admin+, through the session client (RLS) and filtered by account.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { normalizeEvents } from '@/lib/webhooks/events';
import {
  WEBHOOK_PUBLIC_COLUMNS,
  normalizeWebhookUrl,
  serializeWebhookEndpoint,
} from '@/lib/webhooks/endpoints';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: 'Corpo inválido' }, { status: 400 });

    const updates: Record<string, unknown> = {};
    if ('url' in body) {
      const url = normalizeWebhookUrl(body.url);
      if (!url) return NextResponse.json({ error: 'Informe um endereço https:// válido' }, { status: 400 });
      updates.url = url;
    }
    if ('events' in body) {
      const events = normalizeEvents(body.events);
      if (!events) return NextResponse.json({ error: 'Escolha pelo menos um evento' }, { status: 400 });
      updates.events = events;
    }
    if ('is_active' in body) {
      if (typeof body.is_active !== 'boolean') return NextResponse.json({ error: 'is_active inválido' }, { status: 400 });
      updates.is_active = body.is_active;
      if (body.is_active) updates.failure_count = 0;
    }
    if (Object.keys(updates).length === 0) return NextResponse.json({ error: 'Nada para mudar' }, { status: 400 });

    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .update(updates)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .maybeSingle();
    if (error) return NextResponse.json({ error: 'Não foi possível salvar' }, { status: 500 });
    if (!data) return NextResponse.json({ error: 'Webhook não encontrado' }, { status: 404 });
    return NextResponse.json({ webhook: serializeWebhookEndpoint(data as Record<string, unknown>) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')
      .maybeSingle();
    if (error) return NextResponse.json({ error: 'Não foi possível apagar' }, { status: 500 });
    if (!data) return NextResponse.json({ error: 'Webhook não encontrado' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
