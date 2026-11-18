// Same document as oauth-authorization-server, for clients that look here first.
import { authorizationServerMetadata, oauthJson, preflight, requestOrigin } from '@/lib/oauth/http';

export function GET(request: Request) {
  return oauthJson(authorizationServerMetadata(requestOrigin(request)));
}

export const OPTIONS = preflight;
