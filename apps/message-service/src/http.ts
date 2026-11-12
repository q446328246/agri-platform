import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse, MessageLevel } from "@agri/contracts";
import { isMessageTemplateTopic, MESSAGE_TEMPLATES } from "@agri/contracts";
import { ulid } from "@agri/shared";
import { authorizeRequest } from "@agri/shared";

import { InMemoryMessageRepository } from "./message.repository.js";
import type { MessageQuery, MessageRepository, MessageType } from "./message.repository.js";
import { defaultPreference, InMemoryMessagePreferenceRepository, mergePreferences } from "./preference.repository.js";
import type { MessagePreferenceRepository } from "./preference.repository.js";

/**
 * 消息中心 HTTP 接口。
 *
 * 消息的来源有两类：业务页面直接创建，以及事件消费自动生成；两者共用
 * 同一个仓储，因此列表、未读数与已读标记对两类来源一致生效。
 */

const API_PREFIX = "/api/v1/messages";

export interface MessageDependencies {
  messages?: MessageRepository;
  /** 订阅偏好存储，缺省全部启用 */
  preferences?: MessagePreferenceRepository;
  /** 缺省租户，与平台其他服务保持一致 */
  tenantId?: string;
}

function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void {
  const body: ApiResponse<T> = { code: status >= 400 ? `MESSAGE-${status}` : "OK", message, data, traceId, timestamp: Date.now() };
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function trace(req: IncomingMessage): string {
  const value = req.headers["x-request-id"];
  return typeof value === "string" && value.length > 0 ? value : randomUUID();
}

function tenantOf(req: IncomingMessage, fallback: string): string {
  const value = req.headers["x-tenant-id"];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象");
  return value as Record<string, unknown>;
}

function toType(value: unknown): MessageType {
  return value === "ALERT" ? "ALERT" : "NOTICE";
}

function toLevel(value: unknown): MessageLevel {
  return value === "CRITICAL" ? "CRITICAL" : value === "WARNING" ? "WARNING" : "INFO";
}

/** 校验偏好级别，非法取值返回 undefined */
function parseLevel(value: unknown): MessageLevel | undefined {
  return value === "INFO" || value === "WARNING" || value === "CRITICAL" ? value : undefined;
}

function queryOf(params: URLSearchParams): MessageQuery {
  const query: MessageQuery = {
    page: Math.max(1, Number(params.get("page") ?? 1) || 1),
    size: Math.min(200, Math.max(1, Number(params.get("size") ?? 20) || 20)),
  };
  const type = params.get("type");
  if (type === "ALERT" || type === "NOTICE") query.type = type;
  const level = parseLevel(params.get("level"));
  if (level) query.level = level;
  const read = params.get("read");
  if (read === "true") query.read = true;
  if (read === "false") query.read = false;
  const plotCode = params.get("plotCode");
  if (plotCode) query.plotCode = plotCode;
  const keyword = params.get("keyword");
  if (keyword) query.keyword = keyword;
  const from = params.get("from");
  if (from) query.from = from;
  const to = params.get("to");
  // 纯日期（YYYY-MM-DD）扩展为当日 23:59:59.999，使「截止日」含当天全部消息
  if (to) query.to = /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to;
  return query;
}

export function createMessageHttpServer(dependencies?: MessageDependencies): Server {
  const messages = dependencies?.messages ?? new InMemoryMessageRepository();
  const preferences = dependencies?.preferences ?? new InMemoryMessagePreferenceRepository();
  const defaultTenant = dependencies?.tenantId ?? "tenant-demo";

  return createServer(async (req, res) => {
    const traceId = trace(req);
    const tenantId = tenantOf(req, defaultTenant);
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        send(res, 200, { status: "ok", service: "message" }, traceId);
        return;
      }
      const denied = authorizeRequest(req, { read: "message:read", write: "message:write" });
      if (denied) { send(res, denied.status, null, traceId, denied.message); return; }

      // 未读数：前端消息角标，不参与分页
      if (req.method === "GET" && url.pathname === `${API_PREFIX}/unread-count`) {
        send(res, 200, { unread: await messages.unreadCount(tenantId) }, traceId);
        return;
      }

      // 订阅偏好：合并模板目录与已保存配置，未配置的主题按全部启用返回
      if (req.method === "GET" && url.pathname === `${API_PREFIX}/preferences`) {
        const stored = await preferences.list(tenantId);
        send(res, 200, { items: mergePreferences(tenantId, stored) }, traceId);
        return;
      }

      const preferenceMatch = url.pathname.match(/^\/api\/v1\/messages\/preferences\/([^/]+)$/);
      const preferenceTopic = preferenceMatch?.[1] ? decodeURIComponent(preferenceMatch[1]) : undefined;
      if (preferenceTopic && req.method === "PUT") {
        if (!isMessageTemplateTopic(preferenceTopic)) {
          send(res, 404, null, traceId, "订阅主题不存在");
          return;
        }
        const body = await json(req);
        const requestedLevel = body.minLevel === undefined ? undefined : parseLevel(body.minLevel);
        if (body.minLevel !== undefined && !requestedLevel) {
          send(res, 400, null, traceId, "最低级别取值非法");
          return;
        }
        const current = (await preferences.find(tenantId, preferenceTopic)) ?? defaultPreference(tenantId, preferenceTopic);
        const saved = await preferences.upsert({
          tenantId,
          topic: preferenceTopic,
          enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
          minLevel: requestedLevel ?? current.minLevel,
          updatedAt: "",
        });
        send(res, 200, { ...saved, label: MESSAGE_TEMPLATES[preferenceTopic].label, type: MESSAGE_TEMPLATES[preferenceTopic].type }, traceId);
        return;
      }

      // 消息列表：按类型、已读状态、地块与关键词过滤
      if (req.method === "GET" && url.pathname === API_PREFIX) {
        const query = queryOf(url.searchParams);
        const scoped: MessageQuery = { ...query, tenantId };
        send(res, 200, await messages.page(scoped), traceId);
        return;
      }

      // 新建消息：页面手工通知，来源事件为空
      if (req.method === "POST" && url.pathname === API_PREFIX) {
        const body = await json(req);
        const title = String(body.title ?? "").trim();
        if (!title) {
          send(res, 400, null, traceId, "消息标题不能为空");
          return;
        }
        const created = await messages.create({
          id: ulid(),
          tenantId,
          type: toType(body.type),
          title,
          content: String(body.content ?? ""),
          level: toLevel(body.level),
          // 手工新建的通知一律按未读入库；已读只能通过 /read 明确标一次
          read: false,
          createdAt: String(body.createdAt ?? new Date().toISOString()),
          ...(typeof body.plotCode === "string" && body.plotCode.trim() ? { plotCode: body.plotCode.trim() } : {}),
        });
        if (!created) {
          send(res, 409, null, traceId, "消息已存在");
          return;
        }
        send(res, 201, created, traceId);
        return;
      }

      const readMatch = url.pathname.match(/^\/api\/v1\/messages\/([^/]+)\/read$/);
      const readId = readMatch?.[1] ? decodeURIComponent(readMatch[1]) : undefined;
      if (readId && req.method === "POST") {
        const message = await messages.markRead(readId, tenantId);
        if (!message) {
          send(res, 404, null, traceId, "消息不存在");
          return;
        }
        send(res, 200, message, traceId);
        return;
      }

      const detailMatch = url.pathname.match(/^\/api\/v1\/messages\/([^/]+)$/);
      const detailId = detailMatch?.[1] ? decodeURIComponent(detailMatch[1]) : undefined;
      if (detailId && req.method === "GET") {
        const message = await messages.findById(detailId, tenantId);
        if (!message) {
          send(res, 404, null, traceId, "消息不存在");
          return;
        }
        send(res, 200, message, traceId);
        return;
      }

      send(res, 404, null, traceId, "接口不存在");
    } catch (error) {
      send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败");
    }
  });
}
