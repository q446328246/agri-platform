import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { ApiResponse } from "@agri/contracts";
import { publishEvent, setDefaultPublisher } from "@agri/mq";
import type { EventPublisher } from "@agri/mq";
import { InMemoryEventPublisher, InMemoryOutboxStore, OutboxService } from "@agri/mq";
import type { OutboxStore } from "@agri/mq";
import { EventTopic } from "@agri/contracts";
import type { ThresholdBreachedPayload } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";

import { newReadingId } from "./reading.repository.js";
import { InMemoryAlertRepository, InMemoryReadingRepository } from "./reading.repository.js";
import type { AlertRepository, CreateReadingInput, HistoryQuery, Reading, ReadingPoint, ReadingRepository, TelemetryAlert } from "./reading.repository.js";

/** 遥测指标与阈值：越过阈值时生成告警并发布越限事件 */
const ALERT_RULES: Array<{ metric: string; level: string; message: string; test: (value: number) => boolean }> = [
  { metric: "soilMoisture", level: "WARNING", message: "土壤含水率低于灌溉阈值", test: (value) => value < 30 },
  { metric: "airTemperature", level: "WARNING", message: "空气温度超出适宜区间", test: (value) => value > 40 },
  { metric: "windSpeed", level: "WARNING", message: "风速超过作业安全阈值", test: (value) => value > 10 },
];

export interface TelemetryDependencies {
  readings?: ReadingRepository;
  alerts?: AlertRepository;
  outbox?: OutboxStore;
  publisher?: EventPublisher;
  tenantId?: string;
  /** 遥测越限事件可选发布；缺省不发布，保持仅落库 */
  publishEvents?: boolean;
}

function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void {
  const body: ApiResponse<T> = { code: status >= 400 ? `TELEMETRY-${status}` : "OK", message, data, traceId, timestamp: Date.now() };
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function trace(req: IncomingMessage): string {
  const value = req.headers["x-request-id"];
  return typeof value === "string" && value.length > 0 ? value : crypto.randomUUID();
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象");
  return value as Record<string, unknown>;
}

function historyQuery(params: URLSearchParams): HistoryQuery {
  const deviceId = params.get("deviceId") ?? undefined;
  const metric = params.get("metric") ?? undefined;
  const from = params.get("from") ?? undefined;
  const to = params.get("to") ?? undefined;
  return {
    ...(deviceId ? { deviceId } : {}),
    ...(metric ? { metric } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit: Number(params.get("size") ?? 200),
  };
}

export function createTelemetryHttpServer(dependencies?: TelemetryDependencies): Server {
  const readings = dependencies?.readings ?? new InMemoryReadingRepository();
  const alerts = dependencies?.alerts ?? new InMemoryAlertRepository();
  const tenantId = dependencies?.tenantId ?? "tenant-demo";
  const publisher = dependencies?.publisher ?? new InMemoryEventPublisher();
  setDefaultPublisher(publisher);
  const relay = new OutboxService(dependencies?.outbox ?? new InMemoryOutboxStore(), publisher, { tenantId, traceId: "telemetry-relay", producer: "telemetry" });
  relay.start();

  return createServer(async (req, res) => {
    const traceId = trace(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") { send(res, 200, { status: "ok", service: "telemetry" }, traceId); return; }
      // 设备直连上报不走用户身份，其余接口需要遥测读写权限
      const denied = authorizeRequest(req, { read: "telemetry:read", write: "telemetry:write", publicPaths: ["/api/v1/telemetry/report"] });
      if (denied) { send(res, denied.status, null, traceId, denied.message); return; }

      // 最新读数：按设备过滤，每个设备每个指标只取最近一次
      if (req.method === "GET" && url.pathname === "/api/v1/telemetry/latest") {
        const deviceId = url.searchParams.get("deviceId") ?? undefined;
        const rows = await readings.latest(deviceId);
        send(res, 200, rows, traceId);
        return;
      }

      // 历史读数：按设备、指标与时间窗查询原始序列
      if (req.method === "GET" && url.pathname === "/api/v1/telemetry/history") {
        const rows = await readings.history(historyQuery(url.searchParams));
        send(res, 200, rows, traceId);
        return;
      }

      // 历史曲线：按时间升序返回 (时间, 数值)，供趋势图直接绑定
      if (req.method === "GET" && url.pathname === "/api/v1/telemetry/history/series") {
        const points: ReadingPoint[] = await readings.historySeries(historyQuery(url.searchParams));
        send(res, 200, points, traceId);
        return;
      }

      // 待处理告警
      if (req.method === "GET" && url.pathname === "/api/v1/telemetry/alerts") {
        send(res, 200, await alerts.pending(), traceId);
        return;
      }

      const alertMatch = url.pathname.match(/^\/api\/v1\/telemetry\/alerts\/([^/]+)\/handle$/);
      if (alertMatch && req.method === "POST") {
        const id = alertMatch[1]; if (!id) { send(res, 400, null, traceId, "告警 ID 不能为空"); return; } const handled = await alerts.markHandled(decodeURIComponent(id));
        if (!handled) { send(res, 404, null, traceId, "告警不存在或已处理"); return; }
        send(res, 200, null, traceId);
        return;
      }

      // 上报读数：落库后按阈值生成告警，并在越限时写入本地消息表发布事件
      if (req.method === "POST" && url.pathname === "/api/v1/telemetry/report") {
        const body = await json(req);
        const input: CreateReadingInput = {
          deviceId: String(body.deviceId ?? ""),
          plotCode: String(body.plotCode ?? ""),
          metric: String(body.metric ?? ""),
          value: Number(body.value),
          unit: String(body.unit ?? ""),
          recordedAt: String(body.recordedAt ?? new Date().toISOString()),
        };
        if (!input.deviceId || !input.metric) { send(res, 400, null, traceId, "deviceId 与 metric 不能为空"); return; }
        const reading = await readings.create(undefined, input);
        const rule = ALERT_RULES.find((item) => item.metric === reading.metric && item.test(reading.value));
        let alert: TelemetryAlert | null = null;
        if (rule) {
          alert = {
            id: newReadingId(),
            deviceId: reading.deviceId,
            plotCode: reading.plotCode,
            level: rule.level,
            metric: reading.metric,
            message: rule.message,
            createdAt: reading.recordedAt,
            handled: false,
          };
          await alerts.create(undefined, alert);
          const payload: ThresholdBreachedPayload = {
            parcelId: reading.plotCode,
            metric: reading.metric,
            value: reading.value,
            threshold: reading.metric === "soilMoisture" ? 30 : reading.metric === "windSpeed" ? 10 : 40,
            direction: "below",
            occurredAt: reading.recordedAt,
          };
          if (dependencies?.publishEvents && dependencies?.outbox) {
            await relay.enqueue(undefined, EventTopic.TelemetryThresholdBreached, payload, { tenantId, traceId, producer: "telemetry" });
          } else if (dependencies?.publishEvents) {
            await publishEvent({ topic: EventTopic.TelemetryThresholdBreached, payload, tenantId, traceId, producer: "telemetry", key: reading.plotCode }, publisher);
          }
        }
        send(res, 201, { reading, alert }, traceId);
        return;
      }

      send(res, 404, null, traceId, "接口不存在");
    } catch (error) {
      send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败");
    }
  });
}

export type { Reading, TelemetryAlert, ReadingPoint };
