import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { FLOW_STATUSES, setFlowStatus, type FlowStatus } from '@/lib/flows/status-core'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * POST /api/flows/[id]/activate
 *
 * Body: { status: 'draft' | 'active' | 'archived' }
 *
 * Activating runs the full validator and refuses on any 'error'
 * severity issue. Drafts and archives are unconditional — users
 * need to be able to save broken-work-in-progress and pause flows
 * without first fixing them.
 *
 * Returns the updated flow on success; on validation failure returns
 * the full issue list so the builder can highlight each problem.
 * The work lives in `setFlowStatus` (shared with the public API).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  // Changing status is a write: `agent` or above. The service-role
  // client below bypasses RLS; setFlowStatus scopes by accountId.
  let accountId: string
  try {
    accountId = (await requireRole('agent')).accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = (await request.json().catch(() => null)) as { status?: FlowStatus } | null
  const status = body?.status
  if (!status || !FLOW_STATUSES.includes(status)) {
    return NextResponse.json({ error: t('flows.statusInvalid') }, { status: 400 })
  }

  const result = await setFlowStatus(supabaseAdmin(), accountId, id, status)
  if (result.ok) return NextResponse.json({ flow: result.flow })
  if (result.reason === 'not_found') {
    return NextResponse.json({ error: t('common.notFound') }, { status: 404 })
  }
  if (result.reason === 'invalid') {
    return NextResponse.json({ error: t('flows.cannotActivate'), issues: result.issues }, { status: 422 })
  }
  return NextResponse.json({ error: result.message }, { status: 500 })
}
