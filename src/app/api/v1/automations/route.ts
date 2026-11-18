// ============================================================
// GET /api/v1/automations — list automations (automations:read).
//   ?active=true|false
// Building or editing steps stays in the dashboard editor.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { okList, fail, badRequest } from '@/lib/api/v1/respond';
import { AUTOMATION_COLUMNS } from '@/lib/api/v1/flows';

export const GET = apiRoute('automations:read', async (ctx, request) => {
  const active = new URL(request.url).searchParams.get('active');
  let query = ctx.db.from('automations').select(AUTOMATION_COLUMNS);
  if (active !== null) {
    if (active !== 'true' && active !== 'false') throw badRequest("'active' deve ser true ou false");
    query = query.eq('is_active', active === 'true');
  }
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return fail('internal', 'Failed to list automations', 500);
  return okList(data ?? [], null);
});
