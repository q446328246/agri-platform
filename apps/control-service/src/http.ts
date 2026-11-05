import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { ApiResponse, PageResult } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";

import { InMemoryControlCommandRepository } from "./control.repository.js";
import type { ControlCommand, ControlCommandRepository, ControlCommandType, ControlOrigin } from "./control.repository.js";

/**
 * 控制指令 HTTP 接口。
 *
 * 人工指令必须同时带操作人身份与二次确认头，自动指令只由事件消费写入，
 * 因此这里不提供「无身份下发」的入口。
 */

const COMMAND_TYPES: ControlCommandType[] = ["SEEDING", "IRRIGATION", "WEEDING", "FERTILIZATION"];

function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void {
  const body: ApiResponse<T> = {
    code: status >= 400 ? `CONTROL-${status}` : "OK",
    message,
    data,
    traceId,
    timestamp: Date.now(),
  };
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function trace(req: IncomingMessage): string {
  return req.headers["x-request-id"]?.toString() || randomUUID();
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象");
  return value as Record<string, unknown>;
}

/** 解析分页与过滤条件，页码与条数在边界内被修正 */
function query(search: URLSearchParams): { plotCode?: string; origin?: ControlOrigin; page: number; size: number } {
  const page = Math.max(1, Number(search.get("page") || 1));
  const size = Math.min(200, Math.max(1, Number(search.get("size") || 20)));
  const plotCode = search.get("plotCode");
  const origin = search.get("origin");
  return {
    ...(plotCode ? { plotCode } : {}),
    ...(origin === "EVENT" || origin === "MANUAL" ? { origin } : {}),
    page,
    size,
  };
}

export function createControlHttpServer(
  repository: ControlCommandRepository = new InMemoryControlCommandRepository(),
): Server {
  return createServer(async (req, res) => {
    const traceId = trace(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        send(res, 200, { status: "ok", service: "control" }, traceId);
        return;
      }
      // 查指令需要设备查看权限，下发指令需要设备控制权限
      const denied = authorizeRequest(req, { read: "device:read", write: "device:control" });
      if (denied) { send(res, denied.status, null, traceId, denied.message); return; }

      if (req.method === "GET" && url.pathname === "/api/v1/control/commands") {
        const page: PageResult<ControlCommand> = await repository.page(query(url.searchParams));
        send(res, 200, page, traceId);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/control/commands") {
        const confirmed = req.headers["x-confirm-action"]?.toString() === "CONFIRM";
        const operatorId = req.headers["x-user-id"]?.toString();
        if (!operatorId || !confirmed) {
          send(res, 409, null, traceId, "控制指令需要操作人身份和二次确认");
          return;
        }
        const body = await json(req);
        const type = body.type as ControlCommandType;
        if (!COMMAND_TYPES.includes(type)) {
          send(res, 400, null, traceId, "控制指令类型非法");
          return;
        }
        const command: ControlCommand = {
          id: randomUUID(),
          deviceId: String(body.deviceId ?? ""),
          plotCode: typeof body.plotCode === "string" ? body.plotCode : "",
          operatorId,
          confirmedAt: new Date().toISOString(),
          type,
          parameters: body.parameters && typeof body.parameters === "object" ? (body.parameters as Record<string, unknown>) : {},
          status: "QUEUED",
          origin: "MANUAL",
          reason: typeof body.reason === "string" && body.reason !== "" ? body.reason : "人工确认执行",
          createdAt: new Date().toISOString(),
        };
        if (!command.deviceId) {
          send(res, 400, null, traceId, "控制指令需要设备标识");
          return;
        }
        await repository.create(command);
        send(res, 202, command, traceId);
        return;
      }

      send(res, 404, null, traceId, "接口不存在");
    } catch (error) {
      send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败");
    }
  });
}
