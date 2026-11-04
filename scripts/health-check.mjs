import { getServices } from "./service-registry.mjs";

const services = getServices();

const checks = await Promise.all(services.map(async ([name, port]) => {
  try { const response = await fetch(`http://127.0.0.1:${port}/health`); return { name, port, ok: response.ok, status: response.status }; }
  catch (error) { return { name, port, ok: false, status: error instanceof Error ? error.message : String(error) }; }
}));
for (const check of checks) console.log(`${check.ok ? "OK " : "ERR"} ${check.name.padEnd(10)} :${check.port} ${check.status}`);
const failed = checks.filter((check) => !check.ok);
if (failed.length) { console.error(`${failed.length} 个服务健康检查失败`); process.exitCode = 1; } else console.log(`全部 ${checks.length} 个服务健康检查通过`);
