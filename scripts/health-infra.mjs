import net from "node:net";

function tcpCheck(host, port) {
  return new Promise((resolve) => { const socket = net.createConnection({ host, port }); const done = (ok, message) => { socket.destroy(); resolve({ ok, message }); }; socket.once("connect", () => done(true, "TCP connected")); socket.once("error", (error) => done(false, error.message)); setTimeout(() => done(false, "timeout"), 3000).unref(); });
}
const postgres = await tcpCheck(process.env.DB_HOST ?? "127.0.0.1", Number(process.env.DB_PORT ?? 5432));
let minio = { ok: false, message: "not checked" };
try { const response = await fetch(`${process.env.FILE_S3_ENDPOINT ?? "http://127.0.0.1:9000"}/minio/health/live`); minio = { ok: response.ok, message: `HTTP ${response.status}` }; } catch (error) { minio = { ok: false, message: error instanceof Error ? error.message : String(error) }; }
console.log(`${postgres.ok ? "OK " : "ERR"} postgres ${postgres.message}`);
console.log(`${minio.ok ? "OK " : "ERR"} minio    ${minio.message}`);
if (!postgres.ok || !minio.ok) process.exitCode = 1;
