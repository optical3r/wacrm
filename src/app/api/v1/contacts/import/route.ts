// ============================================================
// POST /api/v1/contacts/import — create or update up to 500 contacts
// in one call (scope: contacts:write).
//
// Body: { "contacts": [ { "phone": "+5511…", "name", "email",
//          "company", "tags": ["vip"] } ] }
//
// Each row is find-or-create by phone (same dedupe as POST /contacts).
// An existing contact keeps its data (use PATCH /contacts/{id} to
// change it). Tags are ADDED (never removed). One bad row does not
// stop the others: the response lists each row's outcome.
// ============================================================

import { apiRoute } from '@/lib/auth/api-context';
import { ok, badRequest } from '@/lib/api/v1/respond';
import { readJsonObject } from '@/lib/api/v1/body';
import {
  addContactTagsByName,
  findOrCreateContact,
  resolveAuditUserId,
} from '@/lib/api/v1/contacts';

export const maxDuration = 60;

const MAX_ROWS = 500;

type RowResult =
  | { index: number; status: 'created' | 'existing'; id: string }
  | { index: number; status: 'error'; error: string };

const str = (v: unknown, max = 200) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

export const POST = apiRoute('contacts:write', async (ctx, request) => {
  const body = await readJsonObject(request);
  const rows = body.contacts;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw badRequest("'contacts' deve ser uma lista com pelo menos um contato");
  }
  if (rows.length > MAX_ROWS) {
    throw badRequest(`No máximo ${MAX_ROWS} contatos por chamada`);
  }

  // Vetted cores: each takes accountId and scopes by it.
  const auditUserId = await resolveAuditUserId(ctx.db.trusted, ctx.accountId);

  const results: RowResult[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] as Record<string, unknown> | null;
    const phone = str(row?.phone, 40);
    if (!row || typeof row !== 'object' || !phone) {
      results.push({ index, status: 'error', error: "'phone' é obrigatório" });
      continue;
    }
    try {
      const { id, created } = await findOrCreateContact(ctx.db.trusted, ctx.accountId, auditUserId, {
        phone,
        name: str(row.name),
        email: str(row.email),
        company: str(row.company),
      });
      if (Array.isArray(row.tags)) {
        await addContactTagsByName(
          ctx.db.trusted,
          ctx.accountId,
          auditUserId,
          id,
          row.tags.filter((t): t is string => typeof t === 'string').slice(0, 20)
        );
      }
      results.push({ index, status: created ? 'created' : 'existing', id });
    } catch (err) {
      results.push({
        index,
        status: 'error',
        error: err instanceof Error && err.name === 'ContactError' ? err.message : 'Falha ao gravar o contato',
      });
    }
  }

  return ok({
    created: results.filter((r) => r.status === 'created').length,
    existing: results.filter((r) => r.status === 'existing').length,
    failed: results.filter((r) => r.status === 'error').length,
    results,
  });
});
