import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  isMetadataDocumentClientId,
  isValidRedirectUri,
  redirectUriMatches,
  resourceMatches,
  scopesForGrant,
  verifyPkce,
} from '@/lib/oauth/core';
import { safeOAuthNext } from '@/lib/oauth/next';

const ORIGIN = 'https://crm.example.com';

describe('redirect URIs', () => {
  it('accepts https and loopback http only', () => {
    expect(isValidRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(isValidRedirectUri('http://localhost:33418/callback')).toBe(true);
    expect(isValidRedirectUri('http://127.0.0.1:5000/cb')).toBe(true);
    expect(isValidRedirectUri('http://evil.example/cb')).toBe(false);
    expect(isValidRedirectUri('javascript:alert(1)')).toBe(false);
    expect(isValidRedirectUri('https://claude.ai/cb#frag')).toBe(false);
    expect(isValidRedirectUri('https://user:pw@claude.ai/cb')).toBe(false);
    expect(isValidRedirectUri(42)).toBe(false);
  });

  it('matches exactly, except the port of a loopback redirect', () => {
    const reg = ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:1234/callback'];
    expect(redirectUriMatches(reg, 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(redirectUriMatches(reg, 'https://claude.ai/api/mcp/auth_callback/')).toBe(false);
    expect(redirectUriMatches(reg, 'https://claude.ai.evil.example/api/mcp/auth_callback')).toBe(false);
    expect(redirectUriMatches(reg, 'http://localhost:9999/callback')).toBe(true);
    expect(redirectUriMatches(reg, 'http://localhost:9999/other')).toBe(false);
    expect(redirectUriMatches(reg, 'http://127.0.0.1:1234/callback')).toBe(false);
  });
});

describe('PKCE S256', () => {
  const verifier = 'a'.repeat(43) + '-._~';
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  it('accepts the matching verifier', () => {
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });
  it('refuses a wrong, short or missing verifier', () => {
    expect(verifyPkce('b'.repeat(50), challenge)).toBe(false);
    expect(verifyPkce('short', challenge)).toBe(false);
    expect(verifyPkce(undefined, challenge)).toBe(false);
  });
});

describe('resource (audience)', () => {
  it('accepts only our MCP', () => {
    expect(resourceMatches(null, ORIGIN)).toBe(true);
    expect(resourceMatches(`${ORIGIN}/api/mcp`, ORIGIN)).toBe(true);
    expect(resourceMatches(`${ORIGIN}/api/mcp/`, ORIGIN)).toBe(true);
    expect(resourceMatches(ORIGIN, ORIGIN)).toBe(true);
    expect(resourceMatches('https://other.example/api/mcp', ORIGIN)).toBe(false);
    expect(resourceMatches(`${ORIGIN}/api/v1`, ORIGIN)).toBe(false);
  });
});

describe('grant scopes', () => {
  it('read-only grants get only :read scopes', () => {
    const read = scopesForGrant(false);
    expect(read.length).toBeGreaterThan(5);
    expect(read.every((s) => s.endsWith(':read'))).toBe(true);
    expect(scopesForGrant(true)).toContain('messages:send');
  });
});

describe('login next', () => {
  it('only goes back to the consent screen', () => {
    expect(safeOAuthNext('/oauth/authorize?client_id=x')).toBe('/oauth/authorize?client_id=x');
    expect(safeOAuthNext('/dashboard')).toBeNull();
    expect(safeOAuthNext('//evil.example/oauth/authorize')).toBeNull();
    expect(safeOAuthNext('https://evil.example')).toBeNull();
    expect(safeOAuthNext(null)).toBeNull();
  });
});

describe('client metadata document ids', () => {
  it('needs an https URL with a path', () => {
    expect(isMetadataDocumentClientId('https://claude.ai/oauth/mcp-oauth-client-metadata')).toBe(true);
    expect(isMetadataDocumentClientId('https://claude.ai')).toBe(false);
    expect(isMetadataDocumentClientId('lcc_abc')).toBe(false);
    expect(isMetadataDocumentClientId('http://claude.ai/x')).toBe(false);
  });
});
