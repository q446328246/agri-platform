import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { ApiResponse, PageResult } from "@agri/contracts";
import type { PrismaClientLike, Tx } from "@agri/db";
import type { OutboxService } from "@agri/mq";
import { authorizeRequest } from "@agri/shared";

import { buildFinishedEvent } from "./command-finished.js";
import { buildIrrigationPlan, validateCommandParameters } from "./command-spec.js";
import type { IrrigationPlanInput } from "./command-spec.js";
import { CONTROL_STATUSES, canTransition, pendingMinutesOf } from "./control.repository.js";
import { InMemoryControlCommandRepository } from "./control.repository.js";
import type { ControlCommand, ControlCommandRepository, ControlCommandStatus, ControlCommandType, ControlOrigin } from "./control.repository.js";

/**
 * 控制指令 HTTP 接口。
 *
 * 人工指令必须同时带操作人身份与二次确认头，自动指令只由事件消费写入，
 * 因此这里不提供「无身份下发」的入口。
 *
 * 指令的生命周期靠 `/api/v1/control/device/*` 这条设备通道推进：网关领取即
 * QUEUED→SENT，设备回执再推 ACKED/DONE/FAILED。该通道与遥测、视频 AI 回调共用
 * `DEVICE_CALLBACK_TOKEN`（x-device-token），现场没有设备网络时也允许持
 * device:control 的用户人工回填，避免指令永远停在「已入队」。两个通道的归属都由
 * `tenantOf` 现取，不信任请求体自报的租户。
 *
 * 装配了本地消息表（`outbox` + `withTransaction`）时，灌溉指令的 DONE 回执会在同一事务
 * 里追加一条 `control.irrigation.finished` 待投递事件；没有消息表就没有事件，
 * 状态照常结单——内存模式的事件出不了本进程，不值得为它假装一条闭环。
 */

const COMMAND_TYPES: ControlCommandType[] = ["SEEDING", "IRRIGATION", "WEEDING", "FERTILIZATION", "ESTOP"];

/** 回执可上报的目标状态；SENT 由 dispatch 负责，不算回执 */
const RECEIPT_STATUSES: ControlCommandStatus[] = ["ACKED", "DONE", "FAILED"];

/** 超时未回执的默认阈值（分钟），可用 CONTROL_RECEIPT_TIMEOUT_MIN 调整 */
export const DEFAULT_RECEIPT_TIMEOUT_MIN = 15;

/** 未配置 TENANT_ID 且请求没有可信租户头时的归属租户，与全仓演示租户同字面量 */
export const DEFAULT_TENANT = "tenant-demo";

/**
 * 超时阈值（分钟）：调用方给的覆盖值优先，其次环境变量，最后默认值。
 * 列表标记与定时收口共用这一个函数，避免「页面标红」和「后台改状态」两套口径。
 */
export function resolveReceiptTimeoutMin(override?: number): number {
  return Math.max(1, Number(override ?? process.env.CONTROL_RECEIPT_TIMEOUT_MIN ?? DEFAULT_RECEIPT_TIMEOUT_MIN) || DEFAULT_RECEIPT_TIMEOUT_MIN);
}

/** 列表与回执响应附带的在途信息 */
type CommandView = ControlCommand & { pendingMin?: number; overdue: boolean };

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

/**
 * 指令台账按租户隔离。
 * 租户只认网关透传的可信身份头（客户端自报的 x-tenant-id 已在网关丢弃），请求体里的
 * tenantId 一律忽略；设备回调没有会话身份，落到进程配置的 TENANT_ID——一套部署对一个现场。
 */
function tenantOf(req: IncomingMessage): string {
  return req.headers["x-tenant-id"]?.toString().trim() || process.env.TENANT_ID?.trim() || DEFAULT_TENANT;
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

/** 取必填文本字段；抛错由外层统一回 400 */
function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} 不能为空`);
  return value.trim();
}

/** 回执时间：缺省取当前时间，给了就必须可解析 */
function receiptAt(value: unknown): string {
  if (value === undefined || value === null || value === "") return new Date().toISOString();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("at 需为 ISO 时间字符串");
  return new Date(value).toISOString();
}

function receiptText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${field} 需为文本`);
  return value.trim();
}

function receiptResult(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("result 需为 JSON 对象");
  return value as Record<string, unknown>;
}

/** 给指令附加在途信息：终态没有 pendingMin，超阈值即标记 overdue */
function toView(command: ControlCommand, timeoutMin: number, nowMs: number): CommandView {
  const waited = pendingMinutesOf(command, nowMs);
  return { ...command, ...(waited === undefined ? {} : { pendingMin: waited }), overdue: waited !== undefined && waited >= timeoutMin };
}

/** 解析分页与过滤条件，页码与条数在边界内被修正 */
function query(search: URLSearchParams, timeoutMin: number): {
  plotCode?: string;
  origin?: ControlOrigin;
  type?: ControlCommandType;
  status?: ControlCommandStatus;
  deviceId?: string;
  from?: string;
  to?: string;
  pending?: boolean;
  pendingOverMin?: number;
  page: number;
  size: number;
} {
  const page = Math.max(1, Number(search.get("page") || 1));
  const size = Math.min(200, Math.max(1, Number(search.get("size") || 20)));
  const plotCode = search.get("plotCode");
  const origin = search.get("origin");
  const type = search.get("type");
  const status = search.get("status");
  const deviceId = search.get("deviceId");
  const from = search.get("from");
  const to = search.get("to");
  const pending = search.get("pending") === "true";
  const overdue = search.get("overdue") === "true";
  return {
    ...(plotCode ? { plotCode } : {}),
    ...(origin === "EVENT" || origin === "MANUAL" ? { origin } : {}),
    ...(type && COMMAND_TYPES.includes(type as ControlCommandType) ? { type: type as ControlCommandType } : {}),
    ...(status && (CONTROL_STATUSES as readonly string[]).includes(status) ? { status: status as ControlCommandStatus } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to: endOfDay(to) } : {}),
    ...(pending || overdue ? { pending: true } : {}),
    ...(overdue ? { pendingOverMin: timeoutMin } : {}),
    page,
    size,
  };
}

/** HTTP 装配参数：`outbox` 与 `withTransaction` 必须成对给出 */
export interface ControlHttpOptions {
  receiptTimeoutMin?: number;
  /** 本地消息表；配置后灌溉结单同事务推一条完成事件 */
  outbox?: OutboxService;
  /** 事务句柄；配了消息表就必须给，否则状态改了事件却没落库 */
  withTransaction?: PrismaClientLike["$transaction"];
}

export function createControlHttpServer(
  repository: ControlCommandRepository = new InMemoryControlCommandRepository(),
  options: ControlHttpOptions = {},
): Server {
  if (options.outbox && !options.withTransaction) {
    throw new Error("灌溉完成事件要落消息表时必须配置事务句柄，避免状态与事件分家");
  }
  const timeoutMin = resolveReceiptTimeoutMin(options.receiptTimeoutMin);
  const outbox = options.outbox;
  const withTransaction = options.withTransaction;
  return createServer(async (req, res) => {
    const traceId = trace(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        send(res, 200, { status: "ok", service: "control" }, traceId);
        return;
      }
      // 查指令需要设备查看权限，下发指令需要设备控制权限；设备通道另认 x-device-token
      const denied = authorizeRequest(req, {
        read: "device:read",
        write: "device:control",
        callbackPaths: ["/api/v1/control/device"],
      });
      if (denied) { send(res, denied.status, null, traceId, denied.message); return; }

      if (req.method === "GET" && url.pathname === "/api/v1/control/commands") {
        const nowMs = Date.now();
        const page: PageResult<ControlCommand> = await repository.page(tenantOf(req), query(url.searchParams, timeoutMin));
        send(res, 200, { ...page, items: page.items.map((item) => toView(item, timeoutMin, nowMs)) }, traceId);
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
          // 归属只由可信身份头决定，请求体自报的 tenantId 不参与
          tenantId: tenantOf(req),
          deviceId: String(body.deviceId ?? ""),
          plotCode: typeof body.plotCode === "string" ? body.plotCode : "",
          operatorId,
          confirmedAt: new Date().toISOString(),
          type,
          parameters,
          status: "QUEUED",
          origin: "MANUAL",
          reason: typeof body.reason === "string" && body.reason !== "" ? body.reason : "人工确认执行",
          version: 1,
          createdAt: new Date().toISOString(),
        };
        if (!command.deviceId) {
          send(res, 400, null, traceId, "控制指令需要设备标识");
          return;
        }
        await repository.create(command);
        send(res, 202, toView(command, timeoutMin, Date.now()), traceId);
        return;
      }

      // 设备通道 ①：网关领取指令，把入队推进为已下发。已推进过的指令按幂等返回，
      // 免得网关重试时拿到 409 再猜自己有没有领到过。
      if (req.method === "POST" && url.pathname === "/api/v1/control/device/dispatch") {
        const body = await json(req);
        const tenantId = tenantOf(req);
        const target = await repository.find(tenantId, requiredText(body.commandId, "commandId"));
        if (!target) { send(res, 404, null, traceId, "指令不存在"); return; }
        if (target.status === "FAILED") { send(res, 409, null, traceId, "指令已标记失败，不能再次下发"); return; }
        if (target.status !== "QUEUED") { send(res, 200, toView(target, timeoutMin, Date.now()), traceId); return; }
        const message = receiptText(body.message, "message");
        const updated = await repository.transition(tenantId, {
          id: target.id,
          status: "SENT",
          at: receiptAt(body.at),
          version: target.version,
          ...(message === undefined ? {} : { message }),
        });
        if (!updated) { send(res, 409, null, traceId, "指令状态已被其它回执推进，请刷新后重试"); return; }
        send(res, 200, toView(updated, timeoutMin, Date.now()), traceId);
        return;
      }

      // 设备通道 ②：执行回执。SENT/ACKED → ACKED/DONE，任一在途状态都可被 FAILED 收口；
      // 急停指令的 DONE 必须带 result.confirmed=true，否则视为「没确认到位」不予结单。
      if (req.method === "POST" && url.pathname === "/api/v1/control/device/receipt") {
        const body = await json(req);
        const tenantId = tenantOf(req);
        const status = requiredText(body.status, "status") as ControlCommandStatus;
        if (!RECEIPT_STATUSES.includes(status)) {
          send(res, 400, null, traceId, `status 需为 ${RECEIPT_STATUSES.join("/")} 之一，下发确认请用 /device/dispatch`);
          return;
        }
        const message = receiptText(body.message, "message");
        const result = receiptResult(body.result);
        // 报文本身先验完再查状态机：`at` 不合法属于请求体错误，不该因为指令恰好在别的状态被报成 409
        const at = receiptAt(body.at);
        if (status === "FAILED" && message === undefined) throw new Error("FAILED 回执必须说明失败原因（message）");
        const target = await repository.find(tenantId, requiredText(body.commandId, "commandId"));
        if (!target) { send(res, 404, null, traceId, "指令不存在"); return; }
        // 急停的 DONE 必须有到位确认，否则等于「没人确认设备真的停了」就结单
        if (target.type === "ESTOP" && status === "DONE" && result?.confirmed !== true) {
          send(res, 400, null, traceId, "急停指令的执行完成回执必须带到位确认（result.confirmed=true）");
          return;
        }
        if (target.status === status) { send(res, 200, toView(target, timeoutMin, Date.now()), traceId); return; }
        if (!canTransition(target.status, status)) {
          send(res, 409, null, traceId, `指令当前状态为 ${target.status}，不接受 ${status} 回执`);
          return;
        }
        const transition = {
          id: target.id,
          status,
          at,
          version: target.version,
          ...(message === undefined ? {} : { message }),
          ...(result === undefined ? {} : { result }),
        };
        // 水肥类指令结单回流一条完成事件：灌溉记用水量，施肥记配方总投肥量，
        // 口径分主题——把施肥的肥料量算进灌溉用水会虚报，两类各说各的账。
        const finished = status === "DONE" ? buildFinishedEvent(target, at, result) : undefined;
        const apply = async (tx?: Tx): Promise<ControlCommand | null> => {
          // 先跃迁再入队：跃迁被版本拦住时不留一条没人结单的事件
          const updated = await repository.transition(tenantId, transition, tx);
          if (!updated) return null;
          if (finished && outbox) {
            await outbox.enqueue(tx, finished.topic, finished.payload, {
              tenantId,
              traceId: `control-finished:${target.id}`,
              producer: "control",
            });
          }
          return updated;
        };
        const updated = withTransaction ? await withTransaction(apply) : await apply(undefined);
        if (!updated) { send(res, 409, null, traceId, "指令状态已被其它回执推进，请刷新后重试"); return; }
        send(res, 200, toView(updated, timeoutMin, Date.now()), traceId);
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
