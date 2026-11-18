// ============================================================
// Small input helpers shared by the v1 routes. Each throws an
// ApiError (400) so a route can read its body in one line.
// ============================================================

import { badRequest } from '@/lib/api/v1/respond';

export type JsonBody = Record<string, unknown>;

/** The request body as a JSON object, or a 400. */
export async function readJsonObject(request: Request): Promise<JsonBody> {
  const body = (await request.json().catch(() => null)) as unknown;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('O corpo da requisição deve ser um objeto JSON');
  }
  return body as JsonBody;
}

/** A required, trimmed, non-empty string of at most `max` chars. */
export function requiredString(body: JsonBody, key: string, max = 500): string {
  const v = body[key];
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`'${key}' é obrigatório`);
  if (v.trim().length > max) throw badRequest(`'${key}' passa de ${max} caracteres`);
  return v.trim();
}

/**
 * An optional string: undefined when the key is absent, null when the
 * caller sent null, else the trimmed string. Any other type is a 400.
 */
export function optionalString(body: JsonBody, key: string, max = 500): string | null | undefined {
  if (!(key in body)) return undefined;
  const v = body[key];
  if (v === null) return null;
  if (typeof v !== 'string') throw badRequest(`'${key}' deve ser texto ou null`);
  if (v.length > max) throw badRequest(`'${key}' passa de ${max} caracteres`);
  return v.trim();
}

/** A list of strings (other entries dropped), or a 400 when not an array. */
export function stringArray(body: JsonBody, key: string, maxItems = 100): string[] | undefined {
  if (!(key in body)) return undefined;
  const v = body[key];
  if (!Array.isArray(v)) throw badRequest(`'${key}' deve ser uma lista`);
  if (v.length > maxItems) throw badRequest(`'${key}' aceita no máximo ${maxItems} itens`);
  return v.filter((x): x is string => typeof x === 'string');
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** An optional #rrggbb color. */
export function optionalColor(body: JsonBody, key = 'color'): string | undefined {
  if (!(key in body) || body[key] === null) return undefined;
  const v = body[key];
  if (typeof v !== 'string' || !HEX_COLOR.test(v)) {
    throw badRequest(`'${key}' deve ser uma cor no formato #rrggbb`);
  }
  return v.toLowerCase();
}
