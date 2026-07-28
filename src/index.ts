import { parseConfig } from "./config.js";
import { startServer } from "./server.js";

const config = parseConfig();
await startServer(config);

console.log(`Minimal MCP server: http://localhost:${config.port}/mcp`);
console.log(`Health check:       http://localhost:${config.port}/health`);
console.log(`Workspace:          ${config.cwd}`);
