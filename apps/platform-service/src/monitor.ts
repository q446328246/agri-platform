import { EventTopic } from "@agri/contracts";
import type { EventTopicValue, MonitorAlertKind, ServiceDownPayload, ServiceRecoveredPayload } from "@agri/contracts";
import { ulid } from "@agri/shared";

import type { MonitorRepository, MonitorRule, ServiceStatus } from "./monitor.repository.js";

/**
 * 运维巡检引擎（F3）。
 *
 * 每轮对全部目标探测一次：服务探 /health，Postgres 探 SELECT 1，MinIO 探活接口。
 * 连续失败达到规则阈值触发告警（同目标同类型在报期间不重复触发），恢复时撤销
 * 告警并投递恢复事件；响应过慢按连续轮次单独判定。告警与恢复都经事件日志
 * 投递 platform.service.down / platform.service.recovered，由消息中心生成消息。
 */

export interface MonitorTarget {
  target: string;
  kind: "SERVICE" | "INFRA";
  label: string;
  /** 探测失败时抛错，成功即视为可用；耗时由引擎统一计量 */
  probe: () => Promise<void>;
}

/** 服务目标表：与网关路由和 scripts/service-registry.mjs 同一份端口口径 */
const SERVICE_TARGETS: Array<{ target: string; label: string; envVar: string; port: number }> = [
  { target: "auth", label: "认证服务", envVar: "AUTH_SERVICE_URL", port: 3001 },
  { target: "plot", label: "地块服务", envVar: "PLOT_SERVICE_URL", port: 3002 },
  { target: "iot", label: "设备接入服务", envVar: "IOT_SERVICE_URL", port: 3003 },
  { target: "telemetry", label: "遥测感知服务", envVar: "TELEMETRY_SERVICE_URL", port: 3004 },
  { target: "weather", label: "气象服务", envVar: "WEATHER_SERVICE_URL", port: 3005 },
  { target: "decision", label: "智能决策服务", envVar: "DECISION_SERVICE_URL", port: 3006 },
  { target: "operation", label: "农事作业服务", envVar: "OPERATION_SERVICE_URL", port: 3007 },
  { target: "control", label: "指令控制服务", envVar: "CONTROL_SERVICE_URL", port: 3008 },
  { target: "video", label: "视频 AI 服务", envVar: "VIDEO_SERVICE_URL", port: 3009 },
  { target: "finance", label: "核算服务", envVar: "FINANCE_SERVICE_URL", port: 3010 },
  { target: "trace", label: "溯源档案服务", envVar: "TRACE_SERVICE_URL", port: 3011 },
  { target: "message", label: "消息中心服务", envVar: "MESSAGE_SERVICE_URL", port: 3012 },
  { target: "file", label: "文件服务", envVar: "FILE_SERVICE_URL", port: 3013 },
  { target: "platform", label: "平台管理服务", envVar: "PLATFORM_SERVICE_URL", port: 3014 },
  { target: "gateway", label: "API 网关", envVar: "GATEWAY_SERVICE_URL", port: 8080 },
];

function httpProbe(url: string, timeoutMs: number): () => Promise<void> {
  return async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  };
}

export interface DefaultTargetsOptions {
  env?: NodeJS.ProcessEnv;
  /** Postgres 探测（SELECT 1），内存模式没有数据库连接时缺省，跳过该目标 */
  probeDb?: () => Promise<void>;
  probeTimeoutMs?: number;
}

/** 组装默认监控目标：15 个微服务 + Postgres（有连接时）+ MinIO */
export function buildDefaultTargets(options: DefaultTargetsOptions = {}): MonitorTarget[] {
  const env = options.env ?? process.env;
  const timeoutMs = options.probeTimeoutMs ?? Number(env.MONITOR_PROBE_TIMEOUT_MS ?? 3000);
  const targets: MonitorTarget[] = SERVICE_TARGETS.map((service) => ({
    target: service.target,
    kind: "SERVICE",
    label: service.label,
    probe: httpProbe(`${env[service.envVar] ?? `http://127.0.0.1:${service.port}`}/health`, timeoutMs),
  }));
  if (options.probeDb) {
    targets.push({ target: "postgres", kind: "INFRA", label: "PostgreSQL 数据库", probe: options.probeDb });
  }
  targets.push({
    target: "minio",
    kind: "INFRA",
    label: "MinIO 对象存储",
    probe: httpProbe(env.MINIO_HEALTH_URL ?? "http://127.0.0.1:9000/minio/health/live", timeoutMs),
  });
  return targets;
}

export interface MonitorEngineOptions {
  repository: MonitorRepository;
  targets: MonitorTarget[];
  /** 事件投递；内存模式缺省，只更新状态与告警台账不发消息 */
  publish?: (topic: EventTopicValue, payload: ServiceDownPayload | ServiceRecoveredPayload) => Promise<void>;
  /** 巡检周期（毫秒），缺省 30 秒 */
  intervalMs?: number;
  now?: () => Date;
  onError?: (error: Error) => void;
}

export interface MonitorEngine {
  /** 立即跑一轮巡检；上一轮未结束时复用同一轮，不叠加并发 */
  checkNow: () => Promise<void>;
  start: () => void;
  stop: () => void;
}

export function createMonitorEngine(options: MonitorEngineOptions): MonitorEngine {
  const { repository, targets } = options;
  const now = options.now ?? ((): Date => new Date());
  const onError = options.onError ?? ((): void => {});
  const slowStreaks = new Map<string, number>();
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const publish = async (topic: EventTopicValue, payload: ServiceDownPayload | ServiceRecoveredPayload): Promise<void> => {
    if (!options.publish) return;
    try {
      await options.publish(topic, payload);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const fire = async (
    target: MonitorTarget, kind: MonitorAlertKind, level: "WARNING" | "CRITICAL",
    message: string, firedAt: string, payload: ServiceDownPayload,
  ): Promise<void> => {
    const inserted = await repository.fireAlert({ id: ulid(), target: target.target, kind, level, status: "FIRING", message, firedAt });
    if (inserted) await publish(EventTopic.PlatformServiceDown, payload);
  };

  const checkTarget = async (target: MonitorTarget, prev: ServiceStatus | undefined, rules: MonitorRule[], nowIso: string): Promise<void> => {
    const ruleFor = (kind: MonitorAlertKind): MonitorRule | undefined => rules.find((rule) => rule.kind === kind && rule.enabled);
    const startedAt = Date.now();
    let latencyMs: number | undefined;
    let probeError: string | undefined;
    try {
      await target.probe();
      latencyMs = Date.now() - startedAt;
    } catch (error) {
      probeError = error instanceof Error ? error.message : String(error);
    }

    if (probeError === undefined) {
      // 恢复：撤销全部在报告警，DOWN 恢复附带异常持续时长
      if (prev?.status === "DOWN") {
        const resolved = await repository.resolveAlerts(target.target, nowIso);
        if (resolved.length > 0) {
          const downtimeMs = prev.lastDownAt ? Math.max(0, Date.parse(nowIso) - Date.parse(prev.lastDownAt)) : undefined;
          await publish(EventTopic.PlatformServiceRecovered, {
            target: target.target, targetKind: target.kind, label: target.label, occurredAt: nowIso,
            ...(downtimeMs === undefined ? {} : { downtimeMs }),
          });
        }
      }

      // 过慢判定只对服务生效；连续超阈值轮次达标触发 WARNING，回落后自动撤销
      const slowRule = ruleFor("SERVICE_SLOW");
      if (slowRule && target.kind === "SERVICE" && latencyMs !== undefined && latencyMs > slowRule.thresholdMs) {
        const streak = (slowStreaks.get(target.target) ?? 0) + 1;
        slowStreaks.set(target.target, streak);
        if (streak >= slowRule.consecutive) {
          const reason = `响应时长 ${latencyMs} 毫秒，超过阈值 ${slowRule.thresholdMs} 毫秒（连续 ${streak} 轮）`;
          await fire(target, "SERVICE_SLOW", "WARNING", reason, nowIso, {
            target: target.target, targetKind: target.kind, label: target.label, alertKind: "SERVICE_SLOW",
            reason, latencyMs, consecutiveFailures: streak, occurredAt: nowIso,
          });
        }
      } else {
        slowStreaks.delete(target.target);
        const resolvedSlow = await repository.resolveAlerts(target.target, nowIso, "SERVICE_SLOW");
        if (resolvedSlow.length > 0) {
          await publish(EventTopic.PlatformServiceRecovered, {
            target: target.target, targetKind: target.kind, label: target.label, occurredAt: nowIso,
          });
        }
      }

      await repository.upsertStatus({
        target: target.target, kind: target.kind, label: target.label, status: "UP",
        latencyMs: latencyMs ?? 0, consecutiveFailures: 0, lastCheckedAt: nowIso, lastUpAt: nowIso, updatedAt: nowIso,
        ...(prev?.lastDownAt ? { lastDownAt: prev.lastDownAt } : {}),
      });
      return;
    }

    slowStreaks.delete(target.target);
    const failures = (prev?.consecutiveFailures ?? 0) + 1;
    const lastDownAt = prev?.status === "DOWN" && prev.lastDownAt ? prev.lastDownAt : nowIso;
    const downKind: MonitorAlertKind = target.kind === "INFRA" ? "INFRA_DOWN" : "SERVICE_DOWN";
    const downRule = ruleFor(downKind);
    if (downRule && failures >= downRule.consecutive) {
      const reason = `${target.label}连续 ${failures} 轮探测失败：${probeError}`;
      await fire(target, downKind, "CRITICAL", reason, nowIso, {
        target: target.target, targetKind: target.kind, label: target.label, alertKind: downKind,
        reason: probeError, consecutiveFailures: failures, occurredAt: nowIso,
      });
    }
    await repository.upsertStatus({
      target: target.target, kind: target.kind, label: target.label, status: "DOWN",
      lastError: probeError, consecutiveFailures: failures, lastCheckedAt: nowIso, lastDownAt, updatedAt: nowIso,
      ...(prev?.lastUpAt ? { lastUpAt: prev.lastUpAt } : {}),
    });
  };

  const cycle = async (): Promise<void> => {
    const nowIso = now().toISOString();
    const rules = await repository.listRules();
    const previous = new Map((await repository.listStatus()).map((status) => [status.target, status]));
    for (const target of targets) {
      try {
        await checkTarget(target, previous.get(target.target), rules, nowIso);
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };

  const checkNow = (): Promise<void> => {
    if (running) return running;
    running = cycle().finally(() => { running = null; });
    return running;
  };

  return {
    checkNow,
    start: () => {
      if (timer) return;
      void checkNow().catch(onError);
      timer = setInterval(() => void checkNow().catch(onError), options.intervalMs ?? 30_000);
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}