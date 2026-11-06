import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { ApiResponse, PageResult } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";

import { buildIrrigationPlan, validateCommandParameters } from "./command-spec.js";
import type { IrrigationPlanInput } from "./command-spec.js";
import { InMemoryControlCommandRepository } from "./control.repository.js";
import type { ControlCommand, ControlCommandRepository, ControlCommandStatus, ControlCommandType, ControlOrigin } from "./control.repository.js";

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

/** 把纯日期（YYYY-MM-DD）扩展为当日 23:59:59.999，使「截止日」含当天全部指令 */
function endOfDay(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
}

/** 解析分页与过滤条件，页码与条数在边界内被修正 */
function query(search: URLSearchParams): { plotCode?: string; origin?: ControlOrigin; type?: ControlCommandType; status?: ControlCommandStatus; deviceId?: string; from?: string; to?: string; page: number; size: number } {
  const page = Math.max(1, Number(search.get("page") || 1));
  const size = Math.min(200, Math.max(1, Number(search.get("size") || 20)));
  const plotCode = search.get("plotCode");
  const origin = search.get("origin");
  const type = search.get("type");
  const status = search.get("status");
  const deviceId = search.get("deviceId");
  const from = search.get("from");
  const to = search.get("to");
  return {
    ...(plotCode ? { plotCode } : {}),
    ...(origin === "EVENT" || origin === "MANUAL" ? { origin } : {}),
    ...(type && COMMAND_TYPES.includes(type as ControlCommandType) ? { type: type as ControlCommandType } : {}),
    ...(status === "QUEUED" || status === "SENT" || status === "FAILED" ? { status: status as ControlCommandStatus } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to: endOfDay(to) } : {}),
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
        const parameters = body.parameters && typeof body.parameters === "object" ? (body.parameters as Record<string, unknown>) : {};
        // 水肥类指令的参数会直接决定用水量与配比，下发前必须校验，避免脏参数进入执行队列
        const parameterErrors = validateCommandParameters(type, parameters);
        if (parameterErrors.length > 0) {
          send(res, 400, null, traceId, parameterErrors.join("；"));
          return;
        }
        const command: ControlCommand = {
          id: randomUUID(),
          deviceId: String(body.deviceId ?? ""),
          plotCode: typeof body.plotCode === "string" ? body.plotCode : "",
          operatorId,
          confirmedAt: new Date().toISOString(),
          type,
          parameters,
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

      // 方案预演：只算不执行，用于前端确认用水量与阀门时序，不写指令表
      if (req.method === "POST" && url.pathname === "/api/v1/control/irrigation-plans") {
        const confirmed = req.headers["x-confirm-action"]?.toString() === "CONFIRM";
        const operatorId = req.headers["x-user-id"]?.toString();
        if (!operatorId || !confirmed) {
          send(res, 409, null, traceId, "灌溉方案需要操作人身份和二次确认");
          return;
        }
        const body = await json(req);
        const zones = Array.isArray(body.zones) ? body.zones : undefined;
        if (!zones) {
          send(res, 400, null, traceId, "灌溉方案需要 zones 分区列表");
          return;
        }
        const input: IrrigationPlanInput = {
          ...(typeof body.plotCode === "string" ? { plotCode: body.plotCode } : {}),
          zones: zones as IrrigationPlanInput["zones"],
          ...(body.flowM3h !== undefined ? { flowM3h: Number(body.flowM3h) } : {}),
          ...(body.recipe && typeof body.recipe === "object" ? { recipe: body.recipe as NonNullable<IrrigationPlanInput["recipe"]> } : {}),
          ...(body.stir && typeof body.stir === "object" ? { stir: body.stir as NonNullable<IrrigationPlanInput["stir"]> } : {}),
        };
        send(res, 200, buildIrrigationPlan(input), traceId);
        return;
      }

      send(res, 404, null, traceId, "接口不存在");
    } catch (error) {
      send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败");
    }
  });
}
