// ============================================================
// /api/mcp — the LabCRM remote MCP server (Streamable HTTP, stateless).
//
// Connect Claude Code, Codex or any MCP client with:
//   URL:     https://crm.cerqueiralabs.com.br/api/mcp
//   Header:  Authorization: Bearer <chave da API>
//
// The key fixes the account: every tool runs on the same
// account-scoped context as /api/v1, so one workspace never sees
// another's data. The key must have "Usar no MCP" on; write tools
// also need "Permitir escrita pelo MCP".
// ============================================================

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { authenticateApi } from '@/lib/auth/api-context';
import { forbidden, toApiErrorResponse } from '@/lib/api/v1/respond';
import { buildMcpServer } from '@/lib/mcp/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function handle(request: Request): Promise<Response> {
  try {
    const ctx = await authenticateApi(request);
    if (!ctx.mcp.enabled) throw forbidden('O MCP está desligado para esta chave');

    const server = buildMcpServer(ctx, new URL(request.url).origin);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (err) {
    const res = toApiErrorResponse(err);
    if (res.status === 401) {
      res.headers.set('WWW-Authenticate', 'Bearer realm="labcrm"');
    }
    return res;
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
