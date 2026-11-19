import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({}) }));

const { buildOperations, buildOpenApi } = await import('@/lib/api/openapi');
const { MCP_TOOLS } = await import('@/lib/mcp/tools');

describe('OpenAPI from the MCP tools', () => {
  const ops = buildOperations();

  it('has one operation per tool, with real paths', () => {
    expect(ops.length).toBeGreaterThanOrEqual(MCP_TOOLS.length);
    for (const op of ops) {
      expect(op.path).toMatch(/^\/api\/v1\//);
      expect(op.path).not.toMatch(/undefined|\u0000|%7B/);
    }
  });

  it('maps path, query and body fields', () => {
    const get = ops.find((o) => o.id === 'get_contact')!;
    expect(get.path).toBe('/api/v1/contacts/{id}');
    expect(get.params[0]).toMatchObject({ name: 'id', in: 'path', required: true });

    const list = ops.find((o) => o.id === 'list_contacts')!;
    expect(list.params.map((p) => p.name)).toEqual(expect.arrayContaining(['search', 'limit', 'cursor']));
    expect(list.body).toBeNull();

    const create = ops.find((o) => o.method === 'POST' && o.path === '/api/v1/contacts')!;
    expect(Object.keys(create.body!.schema.properties as object).length).toBeGreaterThan(0);
  });

  it('never documents the MCP-only confirmar field', () => {
    expect(JSON.stringify(buildOpenApi('https://x.example'))).not.toContain('confirmar');
  });

  it('is a valid-looking OpenAPI document', () => {
    const doc = buildOpenApi('https://x.example') as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths).length).toBeGreaterThan(40);
  });
});
