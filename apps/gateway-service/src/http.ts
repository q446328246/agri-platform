import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

export interface GatewayRoute { prefix: string; target: string }

function defaultRoutes(): GatewayRoute[] {
  return [
    { prefix: "/api/v1/auth", target: process.env.AUTH_SERVICE_URL ?? "http://127.0.0.1:3001" },
    { prefix: "/api/v1/plots", target: process.env.PLOT_SERVICE_URL ?? "http://127.0.0.1:3002" },
    { prefix: "/api/v1/platform", target: process.env.PLATFORM_SERVICE_URL ?? "http://127.0.0.1:3014" },
    { prefix: "/api/v1/devices", target: process.env.IOT_SERVICE_URL ?? "http://127.0.0.1:3003" },
    { prefix: "/api/v1/telemetry", target: process.env.TELEMETRY_SERVICE_URL ?? "http://127.0.0.1:3004" },
    { prefix: "/api/v1/weather", target: process.env.WEATHER_SERVICE_URL ?? "http://127.0.0.1:3005" },
    { prefix: "/api/v1/messages", target: process.env.MESSAGE_SERVICE_URL ?? "http://127.0.0.1:3012" },
    { prefix: "/api/v1/farm-tasks", target: process.env.OPERATION_SERVICE_URL ?? "http://127.0.0.1:3007" },
    { prefix: "/api/v1/operations", target: process.env.OPERATION_SERVICE_URL ?? "http://127.0.0.1:3007" },
    { prefix: "/api/v1/control", target: process.env.CONTROL_SERVICE_URL ?? "http://127.0.0.1:3008" },
    { prefix: "/api/v1/decision", target: process.env.DECISION_SERVICE_URL ?? "http://127.0.0.1:3006" },
    { prefix: "/api/v1/finance", target: process.env.FINANCE_SERVICE_URL ?? "http://127.0.0.1:3010" },
    { prefix: "/api/v1/trace", target: process.env.TRACE_SERVICE_URL ?? "http://127.0.0.1:3011" },
    { prefix: "/api/v1/files", target: process.env.FILE_SERVICE_URL ?? "http://127.0.0.1:3013" },
    { prefix: "/api/v1/video", target: process.env.VIDEO_SERVICE_URL ?? "http://127.0.0.1:3009" },
  ];
}

async function body(request: IncomingMessage): Promise<Buffer> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
export function createGatewayHttpServer(options: { routes?: GatewayRoute[] } = {}): Server { const activeRoutes = options.routes ?? defaultRoutes(); return createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/health") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ code: "OK", data: { status: "ok", service: "gateway" }, timestamp: Date.now() })); return; }
  // 最长前缀优先，避免 `/plots` 抢先匹配 `/plots/bounds` 这类更具体的路由
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const route = [...activeRoutes].sort((a, b) => b.prefix.length - a.prefix.length).find((item) => pathname === item.prefix || pathname.startsWith(`${item.prefix}/`));
  if (!route) { response.writeHead(404, { "content-type": "application/json" }); response.end(JSON.stringify({ code: "GATEWAY-404", message: "接口不存在", data: null, timestamp: Date.now() })); return; }
  try {
    const init: RequestInit = { method: request.method ?? "GET", headers: { "content-type": request.headers["content-type"]?.toString() || "application/json", "authorization": request.headers.authorization?.toString() || "", "x-request-id": request.headers["x-request-id"]?.toString() || "", "x-tenant-id": request.headers["x-tenant-id"]?.toString() || "", "x-user-id": request.headers["x-user-id"]?.toString() || "", "x-confirm-action": request.headers["x-confirm-action"]?.toString() || "" } };
    if (request.method !== "GET" && request.method !== "HEAD") init.body = await body(request);
    const upstream = await fetch(`${route.target}${url.pathname}${url.search}`, init);
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" }); response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) { response.writeHead(502, { "content-type": "application/json" }); response.end(JSON.stringify({ code: "GATEWAY-502", message: error instanceof Error ? error.message : "下游服务不可用", data: null, timestamp: Date.now() })); }
}); }
