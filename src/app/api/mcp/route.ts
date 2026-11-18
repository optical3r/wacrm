// ============================================================
// /api/mcp — the LabCRM remote MCP server (Streamable HTTP, stateless).
//
// Connect Claude Code, Codex or any MCP client with:
//   URL:     https://crm.cerqueiralabs.com.br/api/mcp
//   Header:  Authorization: Bearer <chave da API>
// or add the URL as a custom connector on claude.ai, which logs in
// with OAuth (src/lib/oauth, /oauth/authorize) instead of a key.
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
import { mcpWwwAuthenticate } from '@/lib/oauth/http';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function handle(request: Request): Promise<Response> {
  try {
    const ctx = await authenticateApi(request, { allowOAuth: true });
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
      // Tells claude.ai where to log in (RFC 9728).
      res.headers.set('WWW-Authenticate', mcpWwwAuthenticate(new URL(request.url).origin));
    }
    return res;
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
