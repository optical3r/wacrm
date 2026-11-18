// RFC 8414 authorization-server metadata (claude.ai reads this to log in).
import { authorizationServerMetadata, oauthJson, preflight, requestOrigin } from '@/lib/oauth/http';

export function GET(request: Request) {
  return oauthJson(authorizationServerMetadata(requestOrigin(request)));
}

export const OPTIONS = preflight;
