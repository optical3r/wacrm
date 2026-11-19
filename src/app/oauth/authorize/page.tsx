// ============================================================
// /oauth/authorize — the consent screen.
//
// An app (claude.ai, Claude Code, Codex…) sends the person here to
// connect to LabCRM. They log in, pick the workspace and choose
// read-only or read-and-write, then the form posts to
// /api/oauth/authorize, which sends them back to the app with a code.
//
// Only an owner or admin of a workspace can connect apps to it (same
// rule as API keys). Text is Portuguese only, like the API messages.
// ============================================================

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { LabCrmMark } from '@/components/brand/labcrm-mark';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { signConsentTicket, validateAuthorizeRequest } from '@/lib/oauth/authorize';
import { buildRedirect } from '@/lib/oauth/core';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Conectar app',
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

async function currentOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

function queryString(params: SearchParams): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string') q.set(k, v);
    else if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
  }
  return q.toString();
}

function Shell({ title, description, children }: { title: string; description?: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <LabCrmMark className="h-12 w-12" />
          </div>
          <CardTitle className="text-xl text-foreground">{title}</CardTitle>
          {description ? <CardDescription className="text-muted-foreground">{description}</CardDescription> : null}
        </CardHeader>
        {children ? <CardContent>{children}</CardContent> : null}
      </Card>
    </div>
  );
}

interface Workspace {
  id: string;
  name: string;
}

async function adminWorkspaces(userId: string): Promise<Workspace[]> {
  const db = supabaseAdmin();
  const { data: rows } = await db
    .from('account_memberships')
    .select('account_id, role')
    .eq('user_id', userId)
    .in('role', ['owner', 'admin']);
  const ids = ((rows ?? []) as Array<{ account_id: string }>).map((r) => r.account_id);
  if (ids.length === 0) return [];
  const { data: accounts } = await db
    .from('accounts')
    .select('id, name, status, api_enabled')
    .in('id', ids)
    .order('name', { ascending: true });
  return ((accounts ?? []) as Array<{ id: string; name: string | null; status: string | null; api_enabled: boolean | null }>)
    .filter((a) => (!a.status || a.status === 'active') && a.api_enabled !== false)
    .map((a) => ({ id: a.id, name: a.name?.trim() || 'Workspace sem nome' }));
}

export default async function OAuthAuthorizePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const origin = await currentOrigin();

  // Log in first: an anonymous visitor never makes us fetch a client
  // metadata document or touch the database.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${queryString(params)}`)}`);
  }

  const validation = await validateAuthorizeRequest(supabaseAdmin(), params, origin);
  if (!validation.ok) {
    if (validation.kind === 'redirect') {
      redirect(
        buildRedirect(validation.redirectUri, {
          error: validation.error,
          error_description: validation.description,
          state: validation.state,
          iss: origin,
        })
      );
    }
    return <Shell title="Não foi possível conectar" description={validation.message} />;
  }
  const req = validation.request;


  const appName = req.client.client_name ?? 'Um app';
  const returnUrl = new URL(req.redirectUri);
  const returnHost = returnUrl.host;
  // Any app can register itself with any name. Hosts we know are shown
  // plainly; anything else gets a warning to check the address.
  const knownHost =
    returnUrl.hostname === 'claude.ai' ||
    returnUrl.hostname.endsWith('.claude.ai') ||
    returnUrl.hostname === 'claude.com' ||
    returnUrl.hostname.endsWith('.claude.com') ||
    returnUrl.hostname === 'localhost' ||
    returnUrl.hostname === '127.0.0.1';
  const workspaces = await adminWorkspaces(user.id);

  if (workspaces.length === 0) {
    return (
      <Shell
        title="Nenhum workspace disponível"
        description="Só o dono ou um administrador do workspace pode conectar apps. Peça acesso a quem administra a sua conta, ou confira se a API está ligada para ela."
      />
    );
  }

  const ticket = signConsentTicket(user.id, req);

  return (
    <Shell
      title={`Conectar ${appName} ao LabCRM`}
      description={`${appName} quer acessar o LabCRM em seu nome. Depois de permitir, você volta para ${returnHost}.`}
    >
      <form method="post" action="/api/oauth/authorize" className="flex flex-col gap-6">
        <input type="hidden" name="ticket" value={ticket} />

        <div
          className={
            knownHost
              ? 'rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground'
              : 'rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300'
          }
        >
          O nome &quot;{appName}&quot; é informado pelo próprio app. O acesso vai para <strong>{returnHost}</strong>.
          {knownHost ? null : ' Só continue se você reconhece esse endereço e foi você quem pediu para conectar.'}
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium text-foreground">Workspace</legend>
          {workspaces.map((w, i) => (
            <label
              key={w.id}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-foreground has-[:checked]:border-primary"
            >
              <input type="radio" name="account_id" value={w.id} defaultChecked={i === 0} required className="accent-primary" />
              {w.name}
            </label>
          ))}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium text-foreground">O que o app pode fazer</legend>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm has-[:checked]:border-primary">
            <input type="radio" name="access" value="read" defaultChecked className="mt-1 accent-primary" />
            <span>
              <span className="block font-medium text-foreground">Só leitura</span>
              <span className="text-muted-foreground">Ver contatos, conversas, negócios, relatórios e o resto. Não muda nada.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm has-[:checked]:border-primary">
            <input type="radio" name="access" value="write" className="mt-1 accent-primary" />
            <span>
              <span className="block font-medium text-foreground">Leitura e escrita</span>
              <span className="text-muted-foreground">
                Também criar e editar, enviar mensagens e disparos. Envios e exclusões sempre pedem a sua confirmação no chat.
              </span>
            </span>
          </label>
        </fieldset>

        <p className="text-xs text-muted-foreground">
          Você pode desconectar o app quando quiser em Configurações, na seção de API, em &quot;Apps conectados&quot;.
        </p>

        <div className="flex gap-3">
          <Button type="submit" name="decision" value="deny" variant="outline" className="h-10 flex-1">
            Cancelar
          </Button>
          <Button type="submit" name="decision" value="allow" className="h-10 flex-1 bg-primary text-primary-foreground hover:bg-primary/90">
            Permitir
          </Button>
        </div>
      </form>
    </Shell>
  );
}
