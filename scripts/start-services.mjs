import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getServices } from "./service-registry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = [];
const services = getServices();
const gatewayTargets = Object.fromEntries(services.filter(([name]) => name !== "gateway").map(([name, port]) => {
  const key = `${name.toUpperCase()}_SERVICE_URL`;
  return [key, process.env[key] ?? `http://127.0.0.1:${port}`];
}));

function start([name, port, entry]) {
  const env = name === "gateway" ? { ...process.env, ...gatewayTargets } : { ...process.env };
  const child = spawn(process.execPath, [path.join(root, entry)], { cwd: root, env: { ...env, SERVICE_MODE: "http", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on("exit", (code, signal) => { if (code !== 0 && signal === null) console.error(`[${name}] exited with code ${code}`); });
  children.push(child);
}

function cleanup() { for (const child of children.reverse()) if (!child.killed) child.kill("SIGTERM"); }
process.once("SIGINT", () => { cleanup(); process.exit(0); });
process.once("SIGTERM", () => { cleanup(); process.exit(0); });
for (const service of services) start(service);
console.log(`已启动 ${services.length} 个 HTTP 服务。运行 pnpm health:services 检查状态，按 Ctrl+C 停止。`);
