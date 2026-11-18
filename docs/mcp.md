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
`api_request_log` with `via = 'mcp'`. The claude.ai connector (OAuth)
comes in a later phase.

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
