import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getServices } from "./service-registry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ports = { auth: 3201, plot: 3202, iot: 3203, telemetry: 3204, weather: 3205, decision: 3206, operation: 3207, control: 3208, video: 3209, finance: 3210, trace: 3211, message: 3212, file: 3213, platform: 3214, gateway: 8280 };
const env = { ...process.env, ...Object.fromEntries(Object.entries(ports).map(([name, port]) => [`AGRI_${name.toUpperCase()}_PORT`, String(port)])) };
const services = getServices(env);
const children = [];

function start([name, port, entry]) {
  const gatewayEnv = name === "gateway" ? Object.fromEntries(services.filter(([service]) => service !== "gateway").map(([service, targetPort]) => [`${service.toUpperCase()}_SERVICE_URL`, `http://127.0.0.1:${targetPort}`])) : {};
  const child = spawn(process.execPath, [path.join(root, entry)], { cwd: root, env: { ...env, ...gatewayEnv, SERVICE_MODE: "http", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  children.push(child);
}
async function waitFor(name, port) { const deadline = Date.now() + 15000; while (Date.now() < deadline) { try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.ok) return; } catch {} await delay(200); } throw new Error(`${name} 健康检查超时`); }
async function cleanup() { for (const child of children.reverse()) if (!child.killed) child.kill("SIGTERM"); await delay(300); for (const child of children) if (!child.killed) child.kill("SIGKILL"); }
try { for (const service of services) start(service); await Promise.all(services.map(([name, port]) => waitFor(name, port))); console.log(`全量服务健康检查通过: ${services.length} 个服务`); } finally { await cleanup(); }
