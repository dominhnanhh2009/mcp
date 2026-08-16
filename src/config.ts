import path from "node:path";

export interface AppConfig {
  port: number;
  cwd: string;
  llamaServerUrl?: string;
}

function defaultWorkspace(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = [
    String(now.getFullYear()).slice(-2),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");

  return path.resolve(process.cwd(), "sandbox", stamp);
}

function readFlag(args: string[], name: string): string | undefined {
  const equalsArg = args.find((arg) => arg.startsWith(`${name}=`));
  if (equalsArg) return equalsArg.slice(name.length + 1);

  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function parseConfig(args = process.argv.slice(2)): AppConfig {
  const portText = readFlag(args, "--port") ?? "5555";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid --port: ${portText}`);
  }

  const cwdFlag = readFlag(args, "--cwd");
  return {
    port,
    cwd: cwdFlag ? path.resolve(process.cwd(), cwdFlag) : defaultWorkspace(),
    llamaServerUrl: readFlag(args, "--llama-server-url"),
  };
}
