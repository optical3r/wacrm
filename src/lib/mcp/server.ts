// ============================================================
// Builds the per-request MCP server for one authenticated key.
// Stateless: a new server per HTTP request, holding nothing between
// calls, so any instance can answer any request.
// ============================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { logApiRequest, type ApiContext } from '@/lib/auth/api-context';
import { hasScope } from '@/lib/api-keys/scopes';
import { MCP_TOOLS, type McpToolDef } from './tools';

export const MCP_SERVER_INFO = { name: 'labcrm', version: '1.0.0' } as const;

function text(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Why `tool` is unavailable to this key, or null when it may run. */
export function toolBlock(ctx: ApiContext, tool: McpToolDef): string | null {
  if (tool.route.scope && !hasScope(ctx.scopes, tool.route.scope)) {
    return `Esta chave não tem a permissão '${tool.route.scope}'.`;
  }
  if (tool.kind !== 'read' && !ctx.mcp.allowWrites) {
    return 'Esta chave só permite leitura pelo MCP. Ative "Permitir escrita pelo MCP" na chave, em Configurações › API.';
  }
  return null;
}

function buildRequest(origin: string, tool: McpToolDef, args: Record<string, unknown>, auth: string | null): Request {
  const url = new URL(tool.path(args), origin);
  for (const [k, v] of Object.entries(tool.query?.(args) ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = auth;
  return new Request(url, {
    method: tool.method,
    headers,
    body: tool.body ? JSON.stringify(tool.body(args)) : undefined,
  });
}

/**
 * Run one tool for `ctx`. Exported for tests; the server below wires
 * every allowed tool to it.
 */
export async function runTool(
  ctx: ApiContext,
  tool: McpToolDef,
  args: Record<string, unknown>,
  origin: string
): Promise<CallToolResult> {
  const blocked = toolBlock(ctx, tool);
  if (blocked) return text(blocked, true);
  if (tool.kind === 'confirm' && args.confirmar !== true) {
    return text('Ação não executada: envie confirmar = true depois de confirmar com o usuário.', true);
  }

  const started = Date.now();
  const request = buildRequest(origin, tool, args, null);
  let status = 500;
  try {
    const response = await tool.route.run(ctx, request, tool.params?.(args) ?? {});
    status = response.status;
    const body = (await response.json().catch(() => null)) as
      | { data?: unknown; meta?: unknown; error?: { code: string; message: string } }
      | null;
    if (!response.ok || !body || body.error) {
      const err = body?.error;
      return text(err ? `${err.message} (${err.code})` : `Erro ${response.status}`, true);
    }
    return text(body.meta ? { data: body.data, meta: body.meta } : body.data);
  } catch (err) {
    const e = err as { status?: number; message?: string; code?: string };
    status = typeof e.status === 'number' ? e.status : 500;
    return text(status < 500 && e.message ? e.message : 'Erro interno ao executar a ferramenta.', true);
  } finally {
    logApiRequest({
      accountId: ctx.accountId,
      keyId: ctx.keyId,
      via: 'mcp',
      method: 'TOOL',
      route: `mcp:${tool.name}`,
      status,
      durationMs: Date.now() - started,
    });
  }
}

/**
 * The MCP server for this key: only tools the key may actually use are
 * listed, so the client never offers an action that would be refused.
 */
export function buildMcpServer(ctx: ApiContext, origin: string): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions:
      'Ferramentas do LabCRM (CRM de WhatsApp) para uma única conta. Tudo o que você lê e altera fica restrito a essa conta. Antes de enviar mensagens ou apagar algo, confirme com o usuário e passe confirmar = true.',
  });

  for (const tool of MCP_TOOLS) {
    if (toolBlock(ctx, tool)) continue;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.kind === 'read',
          destructiveHint: tool.kind === 'confirm',
          openWorldHint: tool.name === 'send_message' || tool.name === 'send_broadcast',
        },
      },
      async (args: Record<string, unknown>) => runTool(ctx, tool, args, origin)
    );
  }
  return server;
}
