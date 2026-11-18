// ============================================================
// POST /api/oauth/authorize — the consent form's answer.
//
// The form carries a signed ticket (see src/lib/oauth/authorize.ts)
// with the request the consent page already checked, bound to the
// person who saw it. Here we check the session, the ticket, the
// workspace role, then send the person back to the app with a one-time
// code (303), or with error=access_denied when they cancelled.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { verifyConsentTicket } from '@/lib/oauth/authorize';
import { buildRedirect, redirectUriMatches } from '@/lib/oauth/core';
import { requestOrigin } from '@/lib/oauth/http';
import { createCode, getClient, isWorkspaceAdmin } from '@/lib/oauth/store';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

function page(message: string, status: number): Response {
  const safe = message.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return new Response(
    `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LabCRM</title><body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">Não foi possível conectar</h1><p>${safe}</p></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );
}

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

export async function POST(request: Request) {
  const origin = requestOrigin(request);
  // Only our own consent page posts here.
  const from = request.headers.get('origin');
  if (from && from !== origin) return page('Pedido de outra origem.', 403);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return page('Sua sessão expirou. Volte ao app e tente conectar de novo.', 401);

  const form = await request.formData().catch(() => null);
  if (!form) return page('Formulário inválido.', 400);
  const ticket = verifyConsentTicket(form.get('ticket'), user.id);
  if (!ticket) return page('Este pedido expirou. Volte ao app e tente conectar de novo.', 400);

  const db = supabaseAdmin();
  const client = await getClient(db, ticket.cid);
  if (!client || !redirectUriMatches(client.redirect_uris, ticket.ru)) {
    return page('Este app não está mais registrado no LabCRM.', 400);
  }

  if (form.get('decision') !== 'allow') {
    return seeOther(buildRedirect(ticket.ru, { error: 'access_denied', state: ticket.st, iss: origin }));
  }

  const accountId = form.get('account_id');
  if (typeof accountId !== 'string' || !(await isWorkspaceAdmin(db, accountId, user.id))) {
    return page('Só o dono ou um administrador do workspace pode conectar apps.', 403);
  }
  const { data: account } = await db.from('accounts').select('status, api_enabled').eq('id', accountId).maybeSingle();
  if (!account || (account.status && account.status !== 'active') || account.api_enabled === false) {
    return page('A API está desligada para este workspace.', 403);
  }

  const code = await createCode(db, {
    clientId: client.client_id,
    accountId,
    userId: user.id,
    redirectUri: ticket.ru,
    codeChallenge: ticket.cc,
    resource: ticket.rs,
    allowWrites: form.get('access') === 'write',
  });
  if (!code) return page('Erro ao gerar o acesso. Tente de novo.', 500);

  return seeOther(buildRedirect(ticket.ru, { code, state: ticket.st, iss: origin }));
}
