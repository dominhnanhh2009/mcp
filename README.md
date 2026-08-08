# Minimal Node.js MCP server

A small, stateless MCP server built with TypeScript, `tsx`, Zod, and the official
Model Context Protocol SDK.

## Run

```bash
npm install
npm start
```

On Windows, running through `npm.cmd` can show `Terminate batch job (Y/N)?`
after Ctrl+C. That prompt comes from the Windows batch wrapper, not this server.
Once `Server stopped safely.` appears, active work has already finished and it is
safe to answer `Y`. To avoid the batch prompt entirely, launch Node directly:

```powershell
node --import tsx src/index.ts
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

Models should use `run_cmd` for shell operations such as listing files (`ls`),
creating directories (`mkdir dir`), deleting files (`rm file`), copying files
(`cp a.txt b.txt`), moving files (`mv a.txt dir/`), and renaming files
(`mv a.txt b.txt`). Use `text_editor` for all UTF-8 file reads and writes. Its
`file` field selects the path, `select` selects text to search, and providing
`replacement` switches the tool from inspection to editing. Omit `select` and
`replacement` to read a whole file; add `replacement` to create or completely
rewrite one. Providing `select` means ordinary search mode, which returns up to
three matches scoring at least 90%.
This is especially important on Windows: a process started by `run_cmd` can keep
a file open, and Windows will not allow a later shell command to delete that file
until the owning process exits.

## Use with llama.cpp WebUI

Current llama.cpp WebUI releases support MCP over Streamable HTTP. This server
allows browser CORS requests from every origin, including preflight and Chromium
private-network requests, so it can be connected directly or through
llama-server's built-in MCP proxy.

1. Start this MCP server:

   ```bash
   npm start
   ```

2. Either connect the WebUI directly, or start `llama-server` with its MCP proxy:

   ```bash
   llama-server [your usual model options] --ui-mcp-proxy
   ```

3. In the llama.cpp WebUI MCP settings, add:

   - URL: `http://127.0.0.1:5555/mcp`
   - Transport: Streamable HTTP
   - Use llama-server proxy: optional

`--webui-mcp-proxy` is the deprecated name of the llama.cpp option; prefer
`--ui-mcp-proxy`. The WebUI may keep a live MCP connection and reconnect it, but
this server remains stateless and does not depend on transport-session continuity.

Press Ctrl+C once to stop accepting new connections and wait for active MCP
requests (including file writes and commands) to finish. Press Ctrl+C a second
time only when you intentionally want to force the process to stop.

## Included tools

- Filesystem: `text_editor`
- Command: `run_cmd`
- Computation: `js_calculator`
- Real world: `get_current_time`

There is intentionally no command sandbox or path restriction.

`js_calculator` runs JavaScript as a script and returns its final expression;
for example, `const x = Math.pow(2, 10); x + Math.log(Math.E)` returns `1025`.
Top-level `return`, `console.log` output, and Node.js APIs such as `process` and
`require` are not supported.

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

When a tool should derive new information instead of returning its input, keep
the response compact:

```ts
{
  name: "text_length",
  description: "Count the characters in supplied text.",
  inputSchema: {
    text: z.string(),
  },
  handler: ({ text }) => ({ characters: text.length }),
}
```

Avoid echoing input arguments unless returning them is the tool's purpose. For
mutation tools, a compact confirmation or useful measurement is usually enough.

The registry handles MCP registration, Zod validation, result serialization, and
error conversion.
