// ============================================================
// OpenAPI 3.1 for /api/v1, built from the code.
//
// Every MCP tool (src/lib/mcp/tools.ts) is an adapter over one v1
// route and already declares the method, the path, the input fields
// with Portuguese descriptions (zod), how they map to query string or
// body, and the route's scope. So the reference is derived from that
// list instead of being written by hand: a new tool shows up in
// /docs/api and /api/v1/openapi.json without anyone touching docs.
//
// The mapping is read by calling the tool's path/query/body builders
// with a probe object that records which input each field comes from.
// ============================================================

import { z } from 'zod';

import { MCP_TOOLS, type McpToolDef } from '@/lib/mcp/tools';
import { SCOPE_DESCRIPTIONS, type ApiScope } from '@/lib/api-keys/scopes';

type Json = Record<string, unknown>;

export interface DocParam {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  description?: string;
  schema: Json;
}

export interface DocOperation {
  id: string;
  title: string;
  description: string;
  method: McpToolDef['method'];
  path: string;
  tag: string;
  scope: ApiScope | null;
  /** Writes need a key with that scope; via MCP also "Permitir escrita". */
  kind: McpToolDef['kind'];
  params: DocParam[];
  body: { schema: Json; required: string[] } | null;
}

const MARK = '\u0000';

/** Probe: every property read returns a marker naming the input. */
function probe(onRead?: (key: string) => string) {
  return new Proxy(
    {},
    {
      get: (_t, key) => (typeof key === 'string' ? (onRead ? onRead(key) : `${MARK}${key}`) : undefined),
    }
  ) as Record<string, unknown>;
}

function inputSchemas(tool: McpToolDef): { props: Record<string, Json>; required: string[] } {
  const shape = { ...tool.input };
  delete (shape as Record<string, unknown>).confirmar;
  const schema = z.toJSONSchema(z.object(shape), { unrepresentable: 'any' }) as {
    properties?: Record<string, Json>;
    required?: string[];
  };
  return { props: schema.properties ?? {}, required: schema.required ?? [] };
}

/** API field → input key, for a query or body builder. */
function fieldMap(builder: ((a: Record<string, unknown>) => Record<string, unknown>) | undefined): Map<string, string | null> | null {
  if (!builder) return null;
  try {
    const out = new Map<string, string | null>();
    for (const [field, value] of Object.entries(builder(probe()))) {
      out.set(field, typeof value === 'string' && value.startsWith(MARK) ? value.slice(1) : null);
    }
    return out;
  } catch {
    return null;
  }
}

const TAGS: Record<string, string> = {
  me: 'Conta',
  contacts: 'Contatos',
  tags: 'Etiquetas',
  fields: 'Campos personalizados',
  notes: 'Notas',
  conversations: 'Conversas',
  messages: 'Mensagens',
  pipelines: 'Funis e negócios',
  deals: 'Funis e negócios',
  'quick-replies': 'Respostas rápidas',
  templates: 'Modelos (Pro)',
  broadcasts: 'Disparos',
  team: 'Equipe e números',
  channels: 'Equipe e números',
  'lead-rotation': 'Equipe e números',
  flows: 'Fluxos',
  'flow-runs': 'Fluxos',
  automations: 'Automações',
  groups: 'Grupos (Starter)',
  notifications: 'Notificações',
  reports: 'Relatórios',
  webhooks: 'Webhooks',
};

/**
 * Routes no MCP tool covers (managing webhooks is left out of the MCP
 * on purpose). Written by hand, kept to the minimum.
 */
const EXTRA_OPERATIONS: DocOperation[] = [
  {
    id: 'create_webhook',
    title: 'Cadastrar webhook',
    description:
      'Cadastra um endereço https que recebe os eventos escolhidos. A resposta traz o `secret` de assinatura uma única vez: guarde-o para conferir o cabeçalho X-Wacrm-Signature. Até 10 por workspace.',
    method: 'POST',
    path: '/api/v1/webhooks',
    tag: 'Webhooks',
    scope: 'webhooks:manage',
    kind: 'write',
    params: [],
    body: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Endereço https que recebe os eventos.' },
          events: { type: 'array', items: { type: 'string' }, description: 'Eventos, por exemplo message.received e deal.stage_changed.' },
        },
        required: ['url', 'events'],
      },
      required: ['url', 'events'],
    },
  },
  {
    id: 'get_webhook',
    title: 'Ver webhook',
    description: 'Mostra um webhook (sem o segredo).',
    method: 'GET',
    path: '/api/v1/webhooks/{id}',
    tag: 'Webhooks',
    scope: 'webhooks:manage',
    kind: 'read',
    params: [{ name: 'id', in: 'path', required: true, description: 'ID do webhook.', schema: { type: 'string' } }],
    body: null,
  },
  {
    id: 'update_webhook',
    title: 'Editar webhook',
    description: 'Muda o endereço, os eventos ou liga e desliga. Religar zera a contagem de falhas.',
    method: 'PATCH',
    path: '/api/v1/webhooks/{id}',
    tag: 'Webhooks',
    scope: 'webhooks:manage',
    kind: 'write',
    params: [{ name: 'id', in: 'path', required: true, description: 'ID do webhook.', schema: { type: 'string' } }],
    body: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          events: { type: 'array', items: { type: 'string' } },
          is_active: { type: 'boolean' },
        },
      },
      required: [],
    },
  },
];

export function buildOperations(): DocOperation[] {
  return [...toolOperations(), ...EXTRA_OPERATIONS];
}

function toolOperations(): DocOperation[] {
  return MCP_TOOLS.map((tool) => {
    const pathKeys: string[] = [];
    const path = decodeURIComponent(
      tool.path(
        probe((k) => {
          pathKeys.push(k);
          return `{${k}}`;
        })
      )
    );
    const { props, required } = inputSchemas(tool);
    const params: DocParam[] = pathKeys.map((k) => ({
      name: k,
      in: 'path',
      required: true,
      description: props[k]?.description as string | undefined,
      schema: { type: 'string' },
    }));

    const rest = Object.keys(props).filter((k) => !pathKeys.includes(k));
    const query = fieldMap(tool.query);
    const body = fieldMap(tool.body);
    const sendsBody = tool.method !== 'GET' && tool.method !== 'DELETE';

    const queryFields: Array<[string, string | null]> = query
      ? [...query.entries()]
      : sendsBody
        ? []
        : rest.map((k) => [k, k]);
    for (const [field, from] of queryFields) {
      const s = from ? props[from] : undefined;
      params.push({
        name: field,
        in: 'query',
        required: from ? required.includes(from) : false,
        description: s?.description as string | undefined,
        schema: s ? { ...s, description: undefined } : { type: 'string' },
      });
    }

    let bodyDoc: DocOperation['body'] = null;
    const bodyFields: Array<[string, string | null]> = body ? [...body.entries()] : sendsBody ? rest.map((k) => [k, k]) : [];
    if (bodyFields.length) {
      const properties: Record<string, Json> = {};
      const req: string[] = [];
      for (const [field, from] of bodyFields) {
        properties[field] = from && props[from] ? props[from] : {};
        if (from && required.includes(from)) req.push(field);
      }
      bodyDoc = { schema: { type: 'object', properties, ...(req.length ? { required: req } : {}) }, required: req };
    }

    const segment = path.split('/')[3] ?? '';
    return {
      id: tool.name,
      title: tool.title,
      description: tool.description,
      method: tool.method,
      path,
      tag: TAGS[segment] ?? 'Outros',
      scope: tool.route.scope,
      kind: tool.kind,
      params,
      body: bodyDoc,
    };
  });
}

const ERROR_SCHEMA = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' } },
      required: ['code', 'message'],
    },
  },
};

export function buildOpenApi(origin: string): Json {
  const paths: Record<string, Record<string, Json>> = {};
  for (const op of buildOperations()) {
    const entry = (paths[op.path] ??= {});
    entry[op.method.toLowerCase()] = {
      operationId: op.id,
      summary: op.title,
      description: op.scope ? `${op.description}\n\nPermissão: \`${op.scope}\` (${SCOPE_DESCRIPTIONS[op.scope]}).` : op.description,
      tags: [op.tag],
      ...(op.scope ? { 'x-scope': op.scope } : {}),
      parameters: op.params.map((p) => ({ name: p.name, in: p.in, required: p.required, description: p.description, schema: p.schema })),
      ...(op.body
        ? { requestBody: { required: true, content: { 'application/json': { schema: op.body.schema } } } }
        : {}),
      responses: {
        '200': {
          description: 'Sucesso. O resultado vem em `data`; listas trazem `meta.next_cursor`.',
          content: { 'application/json': { schema: { type: 'object', properties: { data: {}, meta: { type: 'object' } } } } },
        },
        '400': { description: 'Pedido inválido', content: { 'application/json': { schema: ERROR_SCHEMA } } },
        '401': { description: 'Chave ausente, inválida ou revogada', content: { 'application/json': { schema: ERROR_SCHEMA } } },
        '403': { description: 'Sem a permissão, API desligada ou ação de outro plano', content: { 'application/json': { schema: ERROR_SCHEMA } } },
        '404': { description: 'Não existe neste workspace', content: { 'application/json': { schema: ERROR_SCHEMA } } },
        '429': { description: 'Limite de chamadas por minuto', content: { 'application/json': { schema: ERROR_SCHEMA } } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'API do LabCRM',
      version: '1.0.0',
      description:
        'API REST do LabCRM. Cada chave pertence a um workspace e só enxerga os dados dele. Envie `Authorization: Bearer <chave>`. As chaves são criadas em Configurações › API e MCP, por dono ou administrador.',
    },
    servers: [{ url: origin }],
    security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    paths,
  };
}
