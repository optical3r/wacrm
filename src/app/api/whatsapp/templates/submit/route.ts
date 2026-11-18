import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'
import { TemplateError, submitTemplate } from '@/lib/whatsapp/template-core'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * Submit a template to Meta for approval AND persist it locally.
 *
 * The work lives in `submitTemplate` (src/lib/whatsapp/template-core.ts),
 * shared with the public API. When WHATSAPP_TEMPLATES_DRY_RUN=true the
 * Meta call is skipped and a synthetic `dry-run-<uuid>` id is stored.
 */
export async function POST(request: Request) {
  try {
    // Message templates are settings-class data: 'admin' only, and the
    // Meta call is an external side effect RLS can't roll back.
    const { supabase, accountId, userId, account } = await requireRole('admin')
    if (account.plan === 'starter') {
      return NextResponse.json({ error: 'Templates não estão disponíveis no plano Starter.' }, { status: 403 })
    }

    let payload: TemplatePayload
    try {
      payload = (await request.json()) as TemplatePayload
    } catch {
      return NextResponse.json({ error: t('templates.invalidJsonBody') }, { status: 400 })
    }

    const { template, dryRun } = await submitTemplate(supabase, accountId, userId, payload)
    return NextResponse.json({ success: true, template, dry_run: dryRun })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error)
    }
    if (error instanceof TemplateError) {
      return NextResponse.json(
        error.metaTemplateId
          ? { error: error.message, meta_template_id: error.metaTemplateId }
          : { error: error.message },
        { status: error.status },
      )
    }
    console.error('Error submitting template:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : t('templates.submitFailed') },
      { status: 500 },
    )
  }
}
