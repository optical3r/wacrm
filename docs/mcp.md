# MCP server

wacrm ships a [Model Context Protocol](https://modelcontextprotocol.io)
server so you can drive your CRM from AI assistants — Claude Desktop,
Claude Code, Cursor, and any other MCP client — in natural language:

> "How many conversations are still open today?"
> "Show the last five messages with +1 415 555 0123."
> "Send the `order_update` template to that contact."

It lives in [`mcp-server/`](../mcp-server) and is published to npm as
[`wacrm-mcp`](https://www.npmjs.com/package/wacrm-mcp). Under the hood
it's a thin wrapper over the [public API](./public-api.md), so every
request is authenticated and scoped by your instance exactly like any
other API call.

## Remote MCP (LabCRM) — no install

Every LabCRM deployment also serves the MCP itself, over Streamable
HTTP, at `/api/mcp`. One API key = one workspace: the tools only ever
see that workspace's data.

1. **Settings → API keys → New API key**. Pick the scopes, keep
   **Use with MCP** on, and switch on **Allow writes through MCP** only
   if the assistant should create contacts or send messages.
2. Connect:

   ```bash
   # Claude Code
   claude mcp add --transport http labcrm https://crm.cerqueiralabs.com.br/api/mcp \
     --header "Authorization: Bearer <key>"
   ```

   ```toml
   # Codex — ~/.codex/config.toml (then export LABCRM_API_KEY=<key>)
   [mcp_servers.labcrm]
   url = "https://crm.cerqueiralabs.com.br/api/mcp"
   bearer_token_env_var = "LABCRM_API_KEY"
   ```

Rules: a read-only key lists only read tools; write tools need the
key's MCP-writes switch; sending messages, broadcasts and deletes also
need `confirmar: true` in the call. Each call is rate-limited with the
API (Starter 60/min, Pro 120/min by default) and logged in
`api_request_log` with `via = 'mcp'`.

### claude.ai connector (OAuth, no key)

claude.ai (site and phone app) can't take a pasted key, so LabCRM is
also the OAuth 2.1 authorization server of its own MCP:

1. On claude.ai: **Settings → Connectors → Add custom connector**, URL
   `https://crm.cerqueiralabs.com.br/api/mcp`, no client id/secret.
2. claude.ai opens the LabCRM consent screen (`/oauth/authorize`): log
   in, pick the workspace (only those where you are owner or admin) and
   choose **Só leitura** or **Leitura e escrita**.
3. The connection shows up in **Settings → API → Apps conectados**,
   with who connected it and its last use. **Desconectar** cuts it off
   at once.

How it works (migration 064, `src/lib/oauth`):

| Piece | Where |
| --- | --- |
| Resource metadata (RFC 9728) | `/.well-known/oauth-protected-resource/api/mcp`, also named in the MCP's 401 `WWW-Authenticate` |
| Server metadata (RFC 8414) | `/.well-known/oauth-authorization-server` (same at `openid-configuration`) |
| Dynamic client registration (RFC 7591) | `POST /api/oauth/register`, 30/hour per IP; unused apps are deleted after 30 days |
| Client ID metadata documents | a `client_id` that is an https URL is fetched (public hosts only, 5 s, 64 KB) |
| Consent | `/oauth/authorize` → `POST /api/oauth/authorize` (signed ticket bound to the person, same-origin check) |
| Tokens | `POST /api/oauth/token`: `authorization_code` (PKCE S256 required) and `refresh_token` |
| Revocation (RFC 7009) | `POST /api/oauth/revoke` |

Rules:

- Access tokens (`lcoa_…`) last 1 hour, refresh tokens (`lcor_…`) 60
  days and are replaced on every refresh. Codes (`lcoc_…`) last 10
  minutes. Only SHA-256 hashes are stored.
- A refresh token used twice, or a code used twice, revokes the
  connection.
- OAuth tokens work only on `/api/mcp`; `/api/v1` refuses them.
- Every call re-checks that the person is still owner or admin of the
  workspace and that the workspace's API is on. Rate limit and request
  log are per connection (`api_request_log.oauth_grant_id`).
- Read-only connections get every `:read` scope; read-and-write get all
  scopes. Sends and deletes still need `confirmar: true`.
- The consent ticket is signed with `OAUTH_SIGNING_SECRET`, or
  `ENCRYPTION_KEY` when that is not set.

## Quick start (local npm package)

1. Create an API key in the dashboard: **Settings → API keys**. Grant
   only the scopes your assistant needs (a read-only assistant only
   needs the `*:read` scopes).
2. Add the server to your MCP client config:

   ```jsonc
   {
     "mcpServers": {
       "wacrm": {
         "command": "npx",
         "args": ["-y", "wacrm-mcp"],
         "env": {
           "WACRM_BASE_URL": "https://crm.example.com",
           "WACRM_API_KEY": "wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx"
         }
       }
     }
   }
   ```

That's **read-only** — the safe default. To let the assistant change
data or send messages, add `"WACRM_ENABLE_WRITES": "true"` (and
`"WACRM_ENABLE_BROADCASTS": "true"` for mass sends) to `env`.

## What it exposes

- **Reads (always on):** `whoami`, contacts (list/get), conversations
  (list/get), messages (list), broadcast status.
- **Writes (opt-in):** send a message, create/update a contact.
- **Broadcasts (opt-in):** launch a template broadcast — requires an
  explicit `confirm` and is marked destructive.

## Safety

Because sending WhatsApp messages is a real side effect, the server is
**read-only until you opt in**, layered on top of the API key's own
scopes. Give an assistant a read-only key and read-only config and it
physically cannot send anything. See the
[server README](../mcp-server/README.md) for the full tool list and
safety model.
