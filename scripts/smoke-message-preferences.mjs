import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

/**
 * 消息中心冒烟：订阅偏好过滤 + 来源主题去重 + 偏好接口校验。
 *
 * 需要 PostgreSQL（消息、偏好与事件日志均落库）以及已应用的 006 迁移。
 * 遥测服务按越限发布事件，消息服务消费后按偏好决定是否落库：
 * - 关闭订阅：事件照常消费但零消息；
 * - 最低级别 CRITICAL：普通越限被拦，风速越限仍通知；
 * - 同地块同指标同一小时：只保留一条告警。
 */

const root = process.cwd();
const DB = process.env.DB_URL ?? "postgresql://agri:agri@127.0.0.1:5432/agri";
const TEL = 3625;
const MSG = 3626;
const TENANT = process.env.TENANT_ID ?? "tenant-demo";
const THRESHOLD = "telemetry.threshold.breached";
const PLOT_OFF = "P-SMOKE-MSG-OFF";
const PLOT_GATE = "P-SMOKE-MSG-GATE";
const PLOT_DEDUPE = "P-SMOKE-MSG-DEDUPE";
const STAMP = Date.now();

function say(msg) {
  writeSync(1, `[smoke:messages] ${msg}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const children = [];
function start(name, entry, env) {
  const child = spawn(process.execPath, [path.join(root, entry)], {
    env: { ...process.env, DB_URL: DB, SERVICE_MODE: "http", ...env },
    stdio: "inherit",
  });
  child.label = name;
  children.push(child);
  return child;
}

start("telemetry", "apps/telemetry-service/dist/main.js", { PORT: String(TEL), TELEMETRY_PUBLISH_EVENTS: "true" });
start("message", "apps/message-service/dist/main.js", { PORT: String(MSG), MESSAGE_POLL_INTERVAL_MS: "200" });

async function waitHealth(port, name) {
  for (let i = 0; i < 100; i += 1) {
    for (const child of children) {
      if (child.exitCode !== null) throw new Error(`${child.label} 进程已退出，退出码 ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // 服务尚未监听，继续等待
    }
    await delay(300);
  }
  throw new Error(`${name} 健康检查超时`);
}

async function request(url, method = "GET", body) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function messagesOf(body) {
  return body.data?.items ?? [];
}

/** 轮询消息列表直到断言通过，避免依赖固定等待时长 */
async function waitMessages(plotCode, predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    const page = await request(`http://127.0.0.1:${MSG}/api/v1/messages?plotCode=${encodeURIComponent(plotCode)}&size=50`);
    latest = messagesOf(page.body);
    if (predicate(latest)) return latest;
    await delay(500);
  }
  throw new Error(`等待${label}超时，当前消息：${JSON.stringify(latest)}`);
}

async function listMessages(plotCode) {
  const page = await request(`http://127.0.0.1:${MSG}/api/v1/messages?plotCode=${encodeURIComponent(plotCode)}&size=50`);
  return messagesOf(page.body);
}

async function setPreference(topic, payload) {
  const result = await request(`http://127.0.0.1:${MSG}/api/v1/messages/preferences/${encodeURIComponent(topic)}`, "PUT", payload);
  assert(result.status === 200, `更新偏好失败：${JSON.stringify(result)}`);
  return result.body.data;
}

async function report(plotCode, metric, value, suffix, recordedAt) {
  const result = await request(`http://127.0.0.1:${TEL}/api/v1/telemetry/report`, "POST", {
    deviceId: `device-smoke-msg-${suffix}-${STAMP}`,
    plotCode,
    metric,
    value,
    unit: metric === "windSpeed" ? "m/s" : "%",
    recordedAt: recordedAt ?? new Date().toISOString(),
  });
  assert(result.body.code === "OK", `上报读数失败：${JSON.stringify(result.body)}`);
}

let client = null;

/** 清理本次冒烟写入的数据，保证脚本可重复执行 */
async function cleanData() {
  if (!client) return;
  try {
    await client.query("DELETE FROM ops_messages WHERE plot_code = ANY($1)", [[PLOT_OFF, PLOT_GATE, PLOT_DEDUPE]]);
    await client.query("DELETE FROM ops_message_preferences WHERE tenant_id = $1", [TENANT]);
    await client.query("DELETE FROM event_log WHERE payload_json->>'parcelId' = ANY($1)", [[PLOT_OFF, PLOT_GATE, PLOT_DEDUPE]]);
    await client.query("DELETE FROM telemetry_outbox WHERE payload_json->>'parcelId' = ANY($1)", [[PLOT_OFF, PLOT_GATE, PLOT_DEDUPE]]);
    await client.query("DELETE FROM telemetry_alerts WHERE plot_code = ANY($1)", [[PLOT_OFF, PLOT_GATE, PLOT_DEDUPE]]);
    await client.query("DELETE FROM telemetry_readings WHERE plot_code = ANY($1)", [[PLOT_OFF, PLOT_GATE, PLOT_DEDUPE]]);
  } catch (error) {
    say(`清理告警：${error.message}`);
  }
}

try {
  await waitHealth(TEL, "telemetry");
  await waitHealth(MSG, "message");
  say("services healthy");

  client = new Client({ connectionString: DB });
  await client.connect();
  await cleanData();

  // 1. 偏好目录：未配置时按模板登记的两个主题返回默认值
  const initial = await request(`http://127.0.0.1:${MSG}/api/v1/messages/preferences`);
  assert(initial.status === 200, `读取偏好失败：${JSON.stringify(initial)}`);
  const items = initial.body.data?.items ?? [];
  assert(items.length === 2, `偏好目录数量异常：${JSON.stringify(items)}`);
  const thresholdItem = items.find((item) => item.topic === THRESHOLD);
  assert(thresholdItem?.label === "遥测越限告警", `偏好展示名异常：${JSON.stringify(thresholdItem)}`);
  assert(thresholdItem?.type === "ALERT" && thresholdItem?.enabled === true && thresholdItem?.minLevel === "INFO", "偏好默认值异常");
  say("preference catalog OK");

  // 2. 接口校验：未登记主题 404，非法级别 400
  const unknown = await request(`http://127.0.0.1:${MSG}/api/v1/messages/preferences/unknown.topic`, "PUT", { enabled: false });
  assert(unknown.status === 404, `未登记主题未拒绝：${JSON.stringify(unknown)}`);
  const invalid = await request(`http://127.0.0.1:${MSG}/api/v1/messages/preferences/${encodeURIComponent(THRESHOLD)}`, "PUT", { minLevel: "DEBUG" });
  assert(invalid.status === 400, `非法级别未拒绝：${JSON.stringify(invalid)}`);
  say("preference validation OK");

  // 3. 关闭订阅：事件照常消费，但不写消息
  const disabled = await setPreference(THRESHOLD, { enabled: false });
  assert(disabled.enabled === false, "关闭订阅未生效");
  await report(PLOT_OFF, "soilMoisture", 18, "off");
  await delay(3000);
  assert((await listMessages(PLOT_OFF)).length === 0, "关闭订阅后仍生成了消息");
  say("disabled subscription suppressed");

  // 4. 最低级别门槛：WARNING 被拦，风速 CRITICAL 放行
  const gated = await setPreference(THRESHOLD, { enabled: true, minLevel: "CRITICAL" });
  assert(gated.enabled === true && gated.minLevel === "CRITICAL", "级别门槛未保存");
  await report(PLOT_GATE, "soilMoisture", 18, "gate-moisture");
  await delay(3000);
  assert((await listMessages(PLOT_GATE)).length === 0, "低于最低级别的告警未被过滤");

  await report(PLOT_GATE, "windSpeed", 12, "gate-wind");
  const alerts = await waitMessages(PLOT_GATE, (list) => list.length >= 1, "风速度告警");
  assert(alerts[0].level === "CRITICAL", `告警级别异常：${JSON.stringify(alerts[0])}`);
  assert(String(alerts[0].title).includes("风速"), `告警标题异常：${alerts[0].title}`);
  say("min level gate OK");

  // 5. 同小时去重：同地块同指标两条越限只落一条
  await setPreference(THRESHOLD, { enabled: true, minLevel: "INFO" });
  const hourStart = new Date();
  hourStart.setMinutes(5, 0, 0);
  const firstAt = hourStart.toISOString();
  const secondAt = new Date(hourStart.getTime() + 60_000).toISOString();
  await report(PLOT_DEDUPE, "soilMoisture", 18, "dedupe-1", firstAt);
  await report(PLOT_DEDUPE, "soilMoisture", 16, "dedupe-2", secondAt);
  const deduped = await waitMessages(PLOT_DEDUPE, (list) => list.length >= 1, "去重告警");
  assert(deduped.length === 1, `同一小时产生了多条告警：${JSON.stringify(deduped)}`);
  await delay(2000);
  assert((await listMessages(PLOT_DEDUPE)).length === 1, "重复事件绕过了去重键");
  say("hourly dedupe OK");

  // 6. 偏好持久化：重新读取仍为已保存配置
  const saved = await request(`http://127.0.0.1:${MSG}/api/v1/messages/preferences`);
  const savedThreshold = (saved.body.data?.items ?? []).find((item) => item.topic === THRESHOLD);
  assert(savedThreshold?.minLevel === "INFO" && savedThreshold?.enabled === true, `偏好未持久化：${JSON.stringify(savedThreshold)}`);
  say("preference persisted");
  say("SMOKE PASS");
} catch (error) {
  say(`SMOKE FAIL: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
} finally {
  await cleanData();
  if (client) {
    await client.end().catch(() => undefined);
    client = null;
  }
  for (const child of children) if (!child.killed) child.kill("SIGTERM");
  await delay(800);
}
