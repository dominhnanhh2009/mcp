import { parseConfig } from "./config.js";
import { startServer } from "./server.js";

const config = parseConfig();
if (config.llamaServerUrl) {
  console.warn(
    "\n*** WARNING: EMBEDDING MODEL DETECTION IS HEURISTIC ***\n" +
      "Only model IDs containing 'embed' are considered. False positives and " +
      "false negatives are common.\n",
  );
}
const server = await startServer(config);

console.log(`Minimal MCP server: http://localhost:${config.port}/mcp`);
console.log(`Health check:       http://localhost:${config.port}/health`);
console.log(`Workspace:          ${config.cwd}`);
if (config.llamaServerUrl) {
  console.log(server.memory
    ? `Memory model:       ${server.memory.model}`
    : "Memory tools:       disabled (no working embedding model found)");
}
if (config.sdServerUrl) {
  const { probeSdServer, detectLcmLora } = await import("./tools/sd-client.js");
  const sdCap = await probeSdServer(config.sdServerUrl);
  if (!sdCap) {
    console.log(`Stable Diffusion:   offline (at ${config.sdServerUrl})`);
  } else {
    const lcmLora = detectLcmLora(sdCap);
    const loraName = lcmLora?.name || lcmLora?.path;
    if (lcmLora && loraName) {
      console.warn(
        "\n************************************************************\n" +
          "*** WARNING: LCM LORA DETECTION IS HEURISTIC             ***\n" +
          `*** Picked LoRA: "${loraName}"\n` +
          "*** Substring match 'lcm' is very prone to false         ***\n" +
          "*** positives. Please verify your selected LoRA!         ***\n" +
          "************************************************************\n",
      );
      console.log(
        `Stable Diffusion:   online (Model: ${sdCap.model?.name ?? "unknown"}, LoRA: ${loraName})`,
      );
    } else {
      console.log(
        `Stable Diffusion:   online (Model: ${sdCap.model?.name ?? "unknown"}) - gen_image disabled (no LoRA matching 'lcm' found)`,
      );
    }
  }
}
console.log(`Loaded base tools (${server.loadedTools.length}):`);
for (const tool of server.loadedTools) {
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
