import { parseConfig } from "./config.js";
import { startServer } from "./server.js";
import { tools } from "./tools/index.js";

const config = parseConfig();
const server = await startServer(config);

console.log(`Minimal MCP server: http://localhost:${config.port}/mcp`);
console.log(`Health check:       http://localhost:${config.port}/health`);
console.log(`Workspace:          ${config.cwd}`);
console.log(`Loaded tools (${tools.length}):`);
for (const tool of tools) {
  console.log(`  - ${tool.name}`);
}

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    console.error(`\nReceived ${signal} again; forcing shutdown.`);
    server.closeAllConnections();
    process.exit(130);
  }

  shuttingDown = true;
  console.log(
    `\nReceived ${signal}; stopping new connections and waiting for active requests...`,
  );

  server.close((error) => {
    if (error) {
      console.error("Server shutdown failed:", error);
      process.exitCode = 1;
    } else {
      console.log("Server stopped safely.");
    }
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
