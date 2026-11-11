import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { serializePermissions } from "@agri/contracts";

import type { GatewayAuthorizer } from "./authz.js";

/**
 * 网关 HTTP 入口。
 *
 * 路由按最长前缀匹配转发；开启鉴权后先解析 token 与权限，再把可信身份头下发给下游。
 * 客户端自带的 `x-user-id` / `x-tenant-id` / `x-permissions` 一律丢弃，避免越权。
 */

export interface GatewayRoute { prefix: string; target: string }

export interface GatewayOptions {
  routes?: GatewayRoute[];
  /** 缺省不鉴权，仅用于单元测试；main.ts 在启用鉴权时注入 */
  authorizer?: GatewayAuthorizer;
}

function defaultRoutes(): GatewayRoute[] {
  return [
    { prefix: "/api/v1/auth", target: process.env.AUTH_SERVICE_URL ?? "http://127.0.0.1:3001" },
    { prefix: "/api/v1/plots", target: process.env.PLOT_SERVICE_URL ?? "http://127.0.0.1:3002" },
    // 片区台账与地块同源，都落在 plot-service
    { prefix: "/api/v1/zones", target: process.env.PLOT_SERVICE_URL ?? "http://127.0.0.1:3002" },
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

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function reply(response: ServerResponse, status: number, code: string, message: string): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ code, message, data: null, timestamp: Date.now() }));
}

export function createGatewayHttpServer(options: GatewayOptions = {}): Server {
  const activeRoutes = options.routes ?? defaultRoutes();
  const authorizer = options.authorizer;
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "OK", data: { status: "ok", service: "gateway" }, timestamp: Date.now() }));
      return;
    }

    const method = request.method ?? "GET";
    const authorization = request.headers.authorization?.toString();
    const deviceToken = request.headers["x-device-token"]?.toString();
    let session: { userId: string; tenantId: string; permissions: string[] } | null = null;
    if (authorizer) {
      const outcome = await authorizer.authorize({ method, pathname: url.pathname, authorization, deviceToken });
      if (!outcome.allowed) { reply(response, outcome.status, `GATEWAY-${outcome.status}`, outcome.message); return; }
      session = outcome.session;
    }

    // 最长前缀优先，避免 `/plots` 抢先匹配 `/plots/bounds` 这类更具体的路由
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const route = [...activeRoutes].sort((a, b) => b.prefix.length - a.prefix.length).find((item) => pathname === item.prefix || pathname.startsWith(`${item.prefix}/`));
    if (!route) { reply(response, 404, "GATEWAY-404", "接口不存在"); return; }
    try {
      const headers: Record<string, string> = {
        "content-type": request.headers["content-type"]?.toString() || "application/json",
        "authorization": authorization || "",
        "x-request-id": request.headers["x-request-id"]?.toString() || "",
        "x-confirm-action": request.headers["x-confirm-action"]?.toString() || "",
        // 回调凭证原样下发，由下游服务按同一密钥二次校验；网关已拒绝无效凭证
        "x-device-token": deviceToken || "",
        // 身份头只接受网关解析结果；未鉴权（测试模式）时才透传客户端提供的租户
        "x-tenant-id": session ? session.tenantId : request.headers["x-tenant-id"]?.toString() || "",
        "x-user-id": session ? session.userId : request.headers["x-user-id"]?.toString() || "",
      };
      if (session) headers["x-permissions"] = serializePermissions(session.permissions);
      const init: RequestInit = { method, headers };
      if (method !== "GET" && method !== "HEAD") init.body = await body(request);
      const upstream = await fetch(`${route.target}${url.pathname}${url.search}`, init);
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      reply(response, 502, "GATEWAY-502", error instanceof Error ? error.message : "下游服务不可用");
    }
  });
}
