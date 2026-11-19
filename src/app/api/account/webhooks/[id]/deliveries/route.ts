// GET /api/account/webhooks/{id}/deliveries — the last 30 delivery
// attempts of one endpoint (migration 065). admin+. The table has no
// RLS policies, so it is read with the service role, filtered by the
// caller's account and the endpoint id.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    const { data, error } = await supabaseAdmin()
      .from('webhook_deliveries')
      .select('id, event, ok, status_code, error, duration_ms, created_at')
      .eq('account_id', ctx.accountId)
      .eq('endpoint_id', id)
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) {
      console.error('[GET webhook deliveries]', error.message);
      return NextResponse.json({ deliveries: [] });
    }
    return NextResponse.json({ deliveries: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
