# Minimal Node.js MCP server

A small, stateless MCP server built with TypeScript, `tsx`, Zod, and the official
Model Context Protocol SDK.

## Run

```bash
npm install
npm start
```

The MCP endpoint is `http://localhost:5555/mcp`. A readable health endpoint is
available at `http://localhost:5555/health`.

Choose another workspace or port:

```bash
npm start -- --cwd ./my-workspace --port 6000
```

`--cwd` is resolved from the project root/current launch directory. When omitted,
the server creates:

```text
sandbox/yymmdd-hhMMss
```

The timestamp is captured once, when the server process starts. For example:
`sandbox/260729-013045`.

## Stateless behavior

This server intentionally uses stateless Streamable HTTP. It does not issue or
require an `Mcp-Session-Id`; every MCP request can be handled independently.
The configured workspace and its files still persist for the lifetime of the
server process (and on disk afterward).

Each `run_cmd` call starts a new shell process in the configured workspace.
Shell-local state such as `cd`, aliases, and environment variables does not carry
over to later tool calls. To work in a subdirectory for one command, use a single
command such as `cd project && npm test`.

## Use with llama.cpp WebUI

Current llama.cpp WebUI releases support MCP over Streamable HTTP. Because this
server does not currently add browser CORS headers, use llama-server's built-in
MCP proxy.

1. Start this MCP server:

   ```bash
   npm start
   ```

2. Start `llama-server` with its MCP proxy enabled:

   ```bash
   llama-server [your usual model options] --ui-mcp-proxy
   ```

3. In the llama.cpp WebUI MCP settings, add:

   - URL: `http://127.0.0.1:5555/mcp`
   - Transport: Streamable HTTP
   - Use llama-server proxy: enabled

`--webui-mcp-proxy` is the deprecated name of the llama.cpp option; prefer
`--ui-mcp-proxy`. The WebUI may keep a live MCP connection and reconnect it, but
this server remains stateless and does not depend on transport-session continuity.

## Included tools

- Filesystem: `ls`, `read_file`, `write_file`, `mkdir`, `delete_file`
- Command: `run_cmd`
- Computation: `js_calculator`
- Real world: `get_current_time`

There is intentionally no command sandbox or path restriction.

## Add a tool

Create or edit a module under `src/tools`, then add its exported array to
`src/tools/index.ts`:

```ts
{
  name: "echo",
  description: "Return the supplied text.",
  inputSchema: {
    text: z.string(),
  },
  handler: ({ text }) => ({ text }),
}
```

The registry handles MCP registration, Zod validation, result serialization, and
error conversion.
