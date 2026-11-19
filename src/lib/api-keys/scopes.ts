// ============================================================
// API key scopes — pure, unit-testable, no I/O.
//
// Authorization for the public API is *scopes-only*: a key's
// capabilities are defined entirely by the scopes granted to it at
// creation, independent of the role of the user who minted it. (We
// still gate *key creation* at admin+, so only trusted members can
// hand out capabilities — see the management routes.)
//
// A scope is `<resource>:<action>`. Endpoints declare the single
// scope they require; `requireApiKey(request, scope)` enforces it.
// Adding a capability = one entry here + the endpoint that checks
// it. No migration needed (the DB stores scopes as a free `text[]`).
// ============================================================

export const API_SCOPES = [
  'messages:send',
  'messages:read',
  'contacts:read',
  'contacts:write',
  'contacts:delete',
  'tags:read',
  'tags:write',
  'fields:read',
  'fields:write',
  'notes:read',
  'notes:write',
  'conversations:read',
  'conversations:write',
  'deals:read',
  'deals:write',
  'quick_replies:read',
  'quick_replies:write',
  'templates:read',
  'templates:write',
  'broadcasts:read',
  'broadcasts:send',
  'team:read',
  'channels:read',
  'flows:read',
  'flows:write',
  'automations:read',
  'automations:write',
  'notifications:read',
  'notifications:write',
  'reports:read',
  'webhooks:manage',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/** Human-readable descriptions, surfaced in the key-creation UI. */
export const SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  'messages:send': 'Enviar mensagens de WhatsApp',
  'messages:read': 'Ler mensagens e o status de entrega',
  'contacts:read': 'Listar e ler contatos',
  'contacts:write': 'Criar, editar e importar contatos',
  'contacts:delete': 'Apagar contatos (com as conversas deles)',
  'tags:read': 'Listar etiquetas',
  'tags:write': 'Criar, editar e apagar etiquetas; pôr e tirar de contatos',
  'fields:read': 'Ler campos personalizados e os valores dos contatos',
  'fields:write': 'Criar, editar e apagar campos; gravar valores nos contatos',
  'notes:read': 'Ler as notas dos contatos',
  'notes:write': 'Criar, editar e apagar notas',
  'conversations:read': 'Listar e ler conversas',
  'conversations:write': 'Iniciar conversas, mudar status e donos, marcar como lida',
  'deals:read': 'Ler funis, etapas e negócios',
  'deals:write': 'Criar, mover, editar e apagar negócios e funis',
  'quick_replies:read': 'Listar respostas rápidas',
  'quick_replies:write': 'Criar, editar e apagar respostas rápidas',
  'templates:read': 'Ler modelos de mensagem (plano Pro)',
  'templates:write': 'Criar, enviar para aprovação e apagar modelos (plano Pro)',
  'broadcasts:read': 'Ver disparos, o andamento e os destinatários',
  'broadcasts:send': 'Criar e cancelar disparos (inclui ver o andamento)',
  'team:read': 'Ver a equipe e o rodízio de leads',
  'channels:read': 'Ver os números conectados e quem atende cada um',
  'flows:read': 'Ver fluxos e as execuções deles',
  'flows:write': 'Ligar e desligar fluxos; iniciar e parar um fluxo para um contato',
  'automations:read': 'Ver automações e o histórico de execução',
  'automations:write': 'Ligar e desligar automações',
  'notifications:read': 'Ler as notificações de quem criou a chave',
  'notifications:write': 'Marcar notificações como lidas',
  'reports:read': 'Ver os números do painel (conversas, contatos, negócios, fluxos)',
  'webhooks:manage': 'Cadastrar e gerenciar webhooks de eventos',
};

/** Type-narrow an unknown value into a valid `ApiScope`. */
export function isApiScope(value: unknown): value is ApiScope {
  return (
    typeof value === 'string' &&
    (API_SCOPES as readonly string[]).includes(value)
  );
}

/**
 * Validate and de-duplicate a caller-supplied scope list. Returns
 * the cleaned list, or `null` if any entry is not a known scope
 * (callers turn that into a 400). An empty input is valid — it
 * yields a key that authenticates but can't do anything beyond the
 * scope-free endpoints (e.g. `GET /api/v1/me`).
 */
export function normalizeScopes(input: unknown): ApiScope[] | null {
  if (!Array.isArray(input)) return null;
  const out: ApiScope[] = [];
  for (const entry of input) {
    if (!isApiScope(entry)) return null;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * True iff `granted` contains `required`. The single source of
 * truth for "is this key allowed to do X?" — both `requireApiKey`
 * and any future inline check should call this rather than poking
 * at the array directly.
 */
export function hasScope(
  granted: readonly string[],
  required: ApiScope
): boolean {
  if (granted.includes(required)) return true;
  return granted.some((g) => SCOPE_IMPLIES[g as ApiScope]?.includes(required));
}

/**
 * Scopes that carry others with them. `broadcasts:send` predates
 * `broadcasts:read` and always let a key watch its own broadcasts, so
 * keys minted before the split keep doing that.
 */
const SCOPE_IMPLIES: Partial<Record<ApiScope, readonly ApiScope[]>> = {
  'broadcasts:send': ['broadcasts:read'],
};

// ------------------------------------------------------------
// Areas: how the key dialog groups scopes. A person picks, per area,
// "Nenhum", "Leitura" or "Escrita" (which includes reading) instead of
// ticking technical scope names. The scopes themselves don't change.
// ------------------------------------------------------------

export type AreaLevel = 'none' | 'read' | 'write';

export interface ApiArea {
  id: string;
  label: string;
  read: readonly ApiScope[];
  write: readonly ApiScope[];
  /** Only exists on one plan. */
  plan?: 'starter' | 'pro';
}

export const API_AREAS: readonly ApiArea[] = [
  { id: 'contacts', label: 'Contatos', read: ['contacts:read'], write: ['contacts:write', 'contacts:delete'] },
  { id: 'tags', label: 'Etiquetas', read: ['tags:read'], write: ['tags:write'] },
  { id: 'fields', label: 'Campos personalizados', read: ['fields:read'], write: ['fields:write'] },
  { id: 'notes', label: 'Notas', read: ['notes:read'], write: ['notes:write'] },
  { id: 'conversations', label: 'Conversas e grupos', read: ['conversations:read'], write: ['conversations:write'] },
  { id: 'messages', label: 'Mensagens', read: ['messages:read'], write: ['messages:send'] },
  { id: 'deals', label: 'Funis e negócios', read: ['deals:read'], write: ['deals:write'] },
  { id: 'quick_replies', label: 'Respostas rápidas', read: ['quick_replies:read'], write: ['quick_replies:write'] },
  { id: 'templates', label: 'Modelos de mensagem', read: ['templates:read'], write: ['templates:write'], plan: 'pro' },
  { id: 'broadcasts', label: 'Disparos', read: ['broadcasts:read'], write: ['broadcasts:send'] },
  { id: 'flows', label: 'Fluxos', read: ['flows:read'], write: ['flows:write'] },
  { id: 'automations', label: 'Automações', read: ['automations:read'], write: ['automations:write'] },
  { id: 'notifications', label: 'Notificações', read: ['notifications:read'], write: ['notifications:write'] },
  { id: 'team', label: 'Equipe e números', read: ['team:read', 'channels:read'], write: [] },
  { id: 'reports', label: 'Relatórios', read: ['reports:read'], write: [] },
  { id: 'webhooks', label: 'Webhooks', read: [], write: ['webhooks:manage'] },
];

/** Levels an area offers (an area with no write scopes stops at read). */
export function areaLevels(area: ApiArea): AreaLevel[] {
  const out: AreaLevel[] = ['none'];
  if (area.read.length) out.push('read');
  if (area.write.length) out.push('write');
  return out;
}

/** Scopes for a set of area levels. */
export function scopesFromAreas(levels: Record<string, AreaLevel>): ApiScope[] {
  const out = new Set<ApiScope>();
  for (const area of API_AREAS) {
    const level = levels[area.id] ?? 'none';
    if (level === 'none') continue;
    area.read.forEach((s) => out.add(s));
    if (level === 'write') area.write.forEach((s) => out.add(s));
  }
  return API_SCOPES.filter((s) => out.has(s));
}

/**
 * The level each area has on a key, for display. An area counts as
 * "write" when any of its write scopes is there, "read" when only its
 * read scopes are.
 */
export function areasFromScopes(scopes: readonly string[]): Record<string, AreaLevel> {
  const out: Record<string, AreaLevel> = {};
  for (const area of API_AREAS) {
    if (area.write.some((s) => scopes.includes(s))) out[area.id] = 'write';
    else if (area.read.some((s) => hasScope(scopes, s))) out[area.id] = 'read';
    else out[area.id] = 'none';
  }
  return out;
}
