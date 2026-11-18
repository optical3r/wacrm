// RFC 9728 protected-resource metadata for the MCP (/api/mcp).
import { oauthJson, preflight, protectedResourceMetadata, requestOrigin } from '@/lib/oauth/http';

export function GET(request: Request) {
  return oauthJson(protectedResourceMetadata(requestOrigin(request)));
}

export const OPTIONS = preflight;
