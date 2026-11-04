import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getFlowTemplate } from '@/lib/flows/templates'
import { getT } from '@/lib/i18n/translate'
import {
  MAX_IMPORT_BYTES,
  buildFlowExport,
  clearForeignRefs,
  collectRefs,
  copyName,
  emptyRefs,
  parseFlowImport,
  type AccountRefs,
  type PortableFlow,
} from '@/lib/flows/portable'

const t = getT('Api')

/**
 * GET /api/flows — list the caller's flows.
 * POST /api/flows — create a new (draft) flow.
 *
 * Available to every authenticated user. The previous per-account
 * beta gate was removed when Flows went to soft-GA; the UI still
 * shows a "Beta" label so users know the surface is young, but the
 * routes themselves are open.
 */

async function requireUser(): Promise<
  | { ok: true; userId: string; supabase: Awaited<ReturnType<typeof createClient>> }
  | { ok: false; status: number; body: { error: string } }
> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, status: 401, body: { error: t('common.unauthorized') } }
  }
  return { ok: true, userId: user.id, supabase }
}

export async function GET() {
  const guard = await requireUser()
  if (!guard.ok) {
    return NextResponse.json(guard.body, { status: guard.status })
  }
  const { supabase } = guard

  const { data, error } = await supabase
    .from('flows')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ flows: data ?? [] })
}

export async function POST(request: Request) {
  // Creating a flow is a write — the RLS flows_insert policy requires
  // `agent`, but this route inserts via the service-role client which
  // bypasses RLS, so the role must be enforced here.
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const guard = await requireUser()
  if (!guard.ok) {
    return NextResponse.json(guard.body, { status: guard.status })
  }
  const { userId, supabase } = guard

  // Resolve the caller's account_id — `flows.account_id` is NOT NULL
  // post-017, so an INSERT without it trips the not-null constraint
  // even though the admin client below bypasses RLS.
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .single()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json(
      { error: t('common.profileNotLinked') },
      { status: 403 },
    )
  }

  const body = (await request.json().catch(() => null)) as
    | {
        name?: string
        description?: string | null
        trigger_type?: 'keyword' | 'first_inbound_message' | 'manual'
        trigger_config?: Record<string, unknown>
        /**
         * If set, clone the matching template's name + trigger +
         * entry_node_id + nodes[] into a fresh draft for this user.
         * `name` from the body overrides the template default if
         * provided.
         */
        template_slug?: string
        /** Copy one of the caller's flows as a new draft ("Duplicar"). */
        duplicate_of?: string
        /** A file made by "Exportar", possibly from another account. */
        import?: unknown
      }
    | null
  if (!body) {
    return NextResponse.json({ error: t('common.invalidJson') }, { status: 400 })
  }

  const admin = supabaseAdmin()

  // -------- Duplicate path --------
  if (body.duplicate_of) {
    // Read through the RLS client so only the caller's own flows can
    // be copied.
    const [{ data: source }, { data: sourceNodes }] = await Promise.all([
      supabase.from('flows').select('*').eq('id', body.duplicate_of).maybeSingle(),
      supabase
        .from('flow_nodes')
        .select('node_key, node_type, config, position_x, position_y')
        .eq('flow_id', body.duplicate_of)
        .order('created_at', { ascending: true }),
    ])
    if (!source) {
      return NextResponse.json({ error: t('common.notFound') }, { status: 404 })
    }
    const data = buildFlowExport(source, sourceNodes ?? [])
    data.flow.name = copyName(source.name, t('flows.copySuffix'))
    return insertPortable(admin, userId, accountId, data, 0)
  }

  // -------- Import path --------
  if (body.import !== undefined) {
    if (JSON.stringify(body.import).length > MAX_IMPORT_BYTES) {
      return NextResponse.json({ error: t('flows.importTooLarge') }, { status: 413 })
    }
    const parsed = parseFlowImport(body.import)
    if (!parsed.ok) {
      return NextResponse.json(
        { error: t(`flows.import.${parsed.error}`), code: parsed.error },
        { status: 400 },
      )
    }
    const known = await knownRefs(supabase, collectRefs(parsed.data))
    const { data, cleared } = clearForeignRefs(parsed.data, known)
    return insertPortable(admin, userId, accountId, data, cleared)
  }

  // -------- Template clone path --------
  if (body.template_slug) {
    const template = getFlowTemplate(body.template_slug)
    if (!template) {
      return NextResponse.json(
        { error: t('flows.unknownTemplate', { slug: String(body.template_slug) }) },
        { status: 400 },
      )
    }
    const { data: flow, error: flowErr } = await admin
      .from('flows')
      .insert({
        user_id: userId,
        account_id: accountId,
        name: body.name?.trim() || template.name,
        description: template.description,
        status: 'draft',
        trigger_type: template.trigger_type,
        trigger_config: template.trigger_config,
        entry_node_id: template.entry_node_id,
      })
      .select()
      .single()
    if (flowErr || !flow) {
      return NextResponse.json(
        { error: flowErr?.message ?? t('flows.insertFailed') },
        { status: 500 },
      )
    }
    if (template.nodes.length > 0) {
      const { error: nodesErr } = await admin.from('flow_nodes').insert(
        template.nodes.map((n) => ({
          flow_id: flow.id,
          node_key: n.node_key,
          node_type: n.node_type,
          config: n.config,
        })),
      )
      if (nodesErr) {
        // Roll back the parent flow so a half-cloned template doesn't
        // sit as an empty draft. CASCADE on flow_id removes the
        // (probably zero) nodes too.
        await admin.from('flows').delete().eq('id', flow.id)
        return NextResponse.json(
          { error: nodesErr.message },
          { status: 500 },
        )
      }
    }
    return NextResponse.json({ flow }, { status: 201 })
  }

  // -------- Plain (empty) create path --------
  if (!body.name?.trim()) {
    return NextResponse.json({ error: t('flows.nameRequired') }, { status: 400 })
  }
  const trigger_type = body.trigger_type ?? 'keyword'

  const { data, error } = await admin
    .from('flows')
    .insert({
      user_id: userId,
      account_id: accountId,
      name: body.name.trim(),
      description: body.description ?? null,
      status: 'draft',
      trigger_type,
      trigger_config: body.trigger_config ?? {},
    })
    .select()
    .single()
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? t('common.insertFailed') },
      { status: 500 },
    )
  }
  return NextResponse.json({ flow: data }, { status: 201 })
}

type Db = Awaited<ReturnType<typeof createClient>>

/**
 * Which of the ids a file mentions exist in the caller's account. The
 * lookups go through the RLS client, so another account's rows never
 * count as known.
 */
async function knownRefs(supabase: Db, wanted: AccountRefs): Promise<AccountRefs> {
  const known = emptyRefs()
  const look = async (
    table: string,
    column: string,
    ids: Set<string>,
    into: Set<string>,
  ) => {
    // Ids come from a user file; only uuid-looking values reach the query.
    const list = [...ids].filter((v) => /^[0-9a-f-]{36}$/i.test(v)).slice(0, 500)
    if (list.length === 0) return
    const { data } = await supabase.from(table).select(column).in(column, list)
    for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      const v = row[column]
      if (typeof v === 'string') into.add(v)
    }
  }
  await Promise.all([
    look('tags', 'id', wanted.tags, known.tags),
    look('pipelines', 'id', wanted.pipelines, known.pipelines),
    look('pipeline_stages', 'id', wanted.stages, known.stages),
    look('profiles', 'user_id', wanted.users, known.users),
    look('flows', 'id', wanted.flows, known.flows),
    look('whatsapp_config', 'id', wanted.channels, known.channels),
  ])
  return known
}

/** Inserts a portable flow as a new draft, with its nodes. */
async function insertPortable(
  admin: ReturnType<typeof supabaseAdmin>,
  userId: string,
  accountId: string,
  data: PortableFlow,
  cleared: number,
) {
  const { data: flow, error: flowErr } = await admin
    .from('flows')
    .insert({
      user_id: userId,
      account_id: accountId,
      name: data.flow.name,
      description: data.flow.description,
      status: 'draft',
      trigger_type: data.flow.trigger_type,
      trigger_config: data.flow.trigger_config,
      entry_node_id: data.flow.entry_node_id,
      ...(data.flow.fallback_policy ? { fallback_policy: data.flow.fallback_policy } : {}),
    })
    .select()
    .single()
  if (flowErr || !flow) {
    return NextResponse.json(
      { error: flowErr?.message ?? t('flows.insertFailed') },
      { status: 500 },
    )
  }
  if (data.nodes.length > 0) {
    const { error: nodesErr } = await admin.from('flow_nodes').insert(
      data.nodes.map((n) => ({
        flow_id: flow.id,
        node_key: n.node_key,
        node_type: n.node_type,
        config: n.config,
        position_x: n.position_x ?? 0,
        position_y: n.position_y ?? 0,
      })),
    )
    if (nodesErr) {
      await admin.from('flows').delete().eq('id', flow.id)
      return NextResponse.json({ error: nodesErr.message }, { status: 500 })
    }
  }
  return NextResponse.json({ flow, cleared }, { status: 201 })
}
