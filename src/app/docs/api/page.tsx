// ============================================================
// /docs/api — public API reference in Portuguese.
//
// Built from the same data as /api/v1/openapi.json (src/lib/api/
// openapi.ts, derived from the MCP tool list), so a new endpoint shows
// up here without editing this page. The page is public; every call
// still needs a key.
// ============================================================

import type { Metadata } from 'next';
import { headers } from 'next/headers';

import { LabCrmMark } from '@/components/brand/labcrm-mark';
import { buildOperations, type DocOperation } from '@/lib/api/openapi';
import { SCOPE_DESCRIPTIONS } from '@/lib/api-keys/scopes';
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_LABELS_PT } from '@/lib/webhooks/events';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Documentação da API',
  description: 'Referência da API REST e do MCP do LabCRM.',
};

const METHOD_STYLE: Record<DocOperation['method'], string> = {
  GET: 'bg-sky-500/15 text-sky-400',
  POST: 'bg-emerald-500/15 text-emerald-400',
  PUT: 'bg-amber-500/15 text-amber-400',
  PATCH: 'bg-amber-500/15 text-amber-400',
  DELETE: 'bg-red-500/15 text-red-400',
};

function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

type Schema = { type?: string | string[]; description?: string; enum?: unknown[]; items?: Schema; anyOf?: Schema[] };

function typeLabel(s: Schema | undefined): string {
  if (!s) return 'qualquer';
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (s.anyOf) return s.anyOf.map(typeLabel).join(' | ');
  const t = Array.isArray(s.type) ? s.type.join(' | ') : s.type;
  if (t === 'array') return `lista de ${typeLabel(s.items)}`;
  return ({ string: 'texto', number: 'número', integer: 'inteiro', boolean: 'sim/não', object: 'objeto' } as Record<string, string>)[t ?? ''] ?? t ?? 'qualquer';
}

function example(s: Schema | undefined, name: string): unknown {
  if (!s) return null;
  if (s.enum) return s.enum[0];
  if (s.anyOf) return example(s.anyOf[0], name);
  const t = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (t) {
    case 'integer':
    case 'number':
      return name === 'limit' ? 50 : 1;
    case 'boolean':
      return true;
    case 'array':
      return [example(s.items, name)];
    case 'object':
      return {};
    default:
      return name.endsWith('id') ? `<${name}>` : name === 'phone' || name === 'to' ? '5511900000000' : '...';
  }
}

function curl(origin: string, op: DocOperation): string {
  const path = op.path.replace(/\{(\w+)\}/g, '<$1>');
  const lines = [`curl -X ${op.method} "${origin}${path}"`, `  -H "Authorization: Bearer $LABCRM_API_KEY"`];
  if (op.body) {
    const props = (op.body.schema.properties ?? {}) as Record<string, Schema>;
    const keys = op.body.required.length ? op.body.required : Object.keys(props).slice(0, 2);
    const body = Object.fromEntries(keys.map((k) => [k, example(props[k], k)]));
    lines.push(`  -H "Content-Type: application/json"`, `  -d '${JSON.stringify(body)}'`);
  }
  return lines.join(' \\\n');
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>;
}

function Pre({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
      {children}
    </pre>
  );
}

function FieldTable({ rows }: { rows: Array<{ name: string; where?: string; required: boolean; schema?: Schema; description?: string }> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-1.5 pr-3 font-normal">Campo</th>
            <th className="py-1.5 pr-3 font-normal">Tipo</th>
            <th className="py-1.5 font-normal">Descrição</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={`${r.where}-${r.name}`} className="align-top">
              <td className="py-1.5 pr-3 font-mono text-xs">
                {r.name}
                {r.required ? <span className="text-red-400"> *</span> : null}
                {r.where ? <span className="block text-[10px] text-muted-foreground">{r.where}</span> : null}
              </td>
              <td className="py-1.5 pr-3 text-xs text-muted-foreground">{typeLabel(r.schema)}</td>
              <td className="py-1.5 text-xs">{r.description ?? r.schema?.description ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Operation({ op, origin }: { op: DocOperation; origin: string }) {
  const params = op.params.map((p) => ({
    name: p.name,
    where: p.in === 'path' ? 'no caminho' : 'na URL',
    required: p.required,
    schema: p.schema as Schema,
    description: p.description,
  }));
  const bodyProps = (op.body?.schema.properties ?? {}) as Record<string, Schema>;
  const body = Object.entries(bodyProps).map(([name, schema]) => ({
    name,
    required: op.body?.required.includes(name) ?? false,
    schema,
  }));
  return (
    <article id={op.id} className="scroll-mt-6 space-y-3 border-t border-border pt-6">
      <h3 className="text-base font-semibold text-foreground">{op.title}</h3>
      <p className="flex flex-wrap items-center gap-2 font-mono text-sm">
        <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${METHOD_STYLE[op.method]}`}>{op.method}</span>
        <span className="break-all">{op.path}</span>
      </p>
      <p className="text-sm text-muted-foreground">{op.description}</p>
      {op.scope ? (
        <p className="text-xs text-muted-foreground">
          Permissão: <Code>{op.scope}</Code> · {SCOPE_DESCRIPTIONS[op.scope]}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Qualquer chave válida.</p>
      )}
      {params.length > 0 && <FieldTable rows={params} />}
      {body.length > 0 && (
        <>
          <p className="text-xs font-medium text-foreground">Corpo (JSON)</p>
          <FieldTable rows={body} />
        </>
      )}
      <Pre>{curl(origin, op)}</Pre>
    </article>
  );
}

export default async function ApiDocsPage() {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'crm.cerqueiralabs.com.br';
  const origin = `${h.get('x-forwarded-proto') ?? 'https'}://${host}`;

  const ops = buildOperations();
  const tags: Array<{ tag: string; ops: DocOperation[] }> = [];
  for (const op of ops) {
    const group = tags.find((g) => g.tag === op.tag);
    if (group) group.ops.push(op);
    else tags.push({ tag: op.tag, ops: [op] });
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4">
          <LabCrmMark className="h-8 w-8" />
          <div>
            <p className="font-semibold">API do LabCRM</p>
            <p className="text-xs text-muted-foreground">REST, webhooks e MCP · {ops.length} operações</p>
          </div>
          <a href="/api/v1/openapi.json" className="ml-auto text-xs text-primary hover:text-primary/80">
            openapi.json
          </a>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-8 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav className="hidden lg:block">
          <div className="sticky top-6 space-y-1 text-sm">
            {['Começo', 'MCP', 'Webhooks'].map((s) => (
              <a key={s} href={`#${slug(s)}`} className="block text-muted-foreground hover:text-foreground">
                {s}
              </a>
            ))}
            <p className="pt-3 text-xs uppercase tracking-wide text-muted-foreground">Endpoints</p>
            {tags.map((g) => (
              <a key={g.tag} href={`#${slug(g.tag)}`} className="block text-muted-foreground hover:text-foreground">
                {g.tag}
              </a>
            ))}
          </div>
        </nav>

        <main className="min-w-0 space-y-10">
          <section id="comeco" className="space-y-3 text-sm leading-relaxed">
            <h1 className="text-2xl font-bold">Documentação da API</h1>
            <p>
              A API dá acesso aos dados de um workspace do LabCRM: contatos, conversas, mensagens, negócios, fluxos e o resto.
              Cada chave pertence a um workspace e só enxerga os dados dele. Dono ou administrador cria as chaves em{' '}
              <strong>Configurações › API e MCP</strong>, escolhendo leitura ou escrita por área.
            </p>
            <Pre>{`Authorization: Bearer $LABCRM_API_KEY\nBase: ${origin}/api/v1`}</Pre>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                Respostas em JSON: <Code>{'{ "data": ... }'}</Code> no sucesso e <Code>{'{ "error": { "code", "message" } }'}</Code> no erro.
              </li>
              <li>
                Listas são paginadas: use <Code>limit</Code> (até 100) e passe o <Code>meta.next_cursor</Code> recebido em{' '}
                <Code>cursor</Code> para a próxima página.
              </li>
              <li>
                Limite por chave, por minuto: 60 no Starter e 120 no Pro. Acima disso a resposta é 429, com{' '}
                <Code>Retry-After</Code>.
              </li>
              <li>Um ID de outro workspace responde 404, nunca 403.</li>
              <li>
                Regras de plano valem aqui: modelos e disparos por modelo só no Pro, grupos só no Starter, janela de 24 horas só no
                Pro.
              </li>
            </ul>
          </section>

          <section id="mcp" className="space-y-3 text-sm leading-relaxed">
            <h2 className="text-xl font-semibold">MCP</h2>
            <p>
              O mesmo acesso está disponível como servidor MCP em <Code>{`${origin}/api/mcp`}</Code>. Quase todo endpoint abaixo é também
              uma ferramenta do MCP, com o mesmo nome do título. A chave precisa de &quot;Usar no MCP&quot;; ferramentas que mudam
              dados precisam de &quot;Permitir escrita pelo MCP&quot;; envios e exclusões pedem <Code>confirmar: true</Code>.
            </p>
            <Pre>{`# Claude Code\nclaude mcp add --transport http labcrm ${origin}/api/mcp \\\n  --header "Authorization: Bearer $LABCRM_API_KEY"\n\n# Codex (~/.codex/config.toml)\n[mcp_servers.labcrm]\nurl = "${origin}/api/mcp"\nbearer_token_env_var = "LABCRM_API_KEY"`}</Pre>
            <p>
              No claude.ai (site e app do celular), adicione um conector personalizado com o endereço acima: o claude.ai abre o
              login do LabCRM, você escolhe o workspace e se ele pode só ler ou também escrever. Não precisa de chave. Esse
              acesso aparece em &quot;Apps conectados&quot; e pode ser desconectado a qualquer momento.
            </p>
          </section>

          <section id="webhooks" className="space-y-3 text-sm leading-relaxed">
            <h2 className="text-xl font-semibold">Webhooks</h2>
            <p>
              O LabCRM faz um POST no seu endereço quando um evento acontece. Cada envio traz{' '}
              <Code>X-Wacrm-Event</Code> e a assinatura <Code>X-Wacrm-Signature: t=&lt;segundos&gt;,v1=&lt;hmac&gt;</Code>, onde o
              HMAC-SHA256 é calculado com o segredo do webhook sobre <Code>{'<t>.<corpo bruto>'}</Code>. Recuse assinaturas com mais
              de 5 minutos. Depois de 15 falhas seguidas o webhook é desligado.
            </p>
            <Pre>{`{\n  "id": "<id da entrega>",\n  "event": "deal.stage_changed",\n  "occurred_at": "2026-11-19T12:00:00.000Z",\n  "account_id": "<workspace>",\n  "data": { ... }\n}`}</Pre>
            <FieldTable
              rows={WEBHOOK_EVENTS.map((e) => ({ name: e, required: false, schema: { type: 'object' }, description: WEBHOOK_EVENT_LABELS_PT[e] }))}
            />
          </section>

          {tags.map((g) => (
            <section key={g.tag} id={slug(g.tag)} className="space-y-4">
              <h2 className="text-xl font-semibold">{g.tag}</h2>
              {g.ops.map((op) => (
                <Operation key={op.id} op={op} origin={origin} />
              ))}
            </section>
          ))}
        </main>
      </div>
    </div>
  );
}
