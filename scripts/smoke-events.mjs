import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

/**
 * 事件闭环冒烟：遥测越限与处方生成 → 本地消息表 → 共享事件日志 → 消息中心。
 *
 * 需要 PostgreSQL（事件日志与消息落库）以及已应用的 003 迁移。
 * 使用独立的端口与地块编码，脚本可重复执行并在结束时清理自建数据。
 */

const root = process.cwd();
const DB = process.env.DB_URL ?? "postgresql://agri:agri@127.0.0.1:5432/agri";
const TEL = 3604;
const DEC = 3606;
const MSG = 3612;
const PLOT = "P-SMOKE-EVENTS";
const DEVICE = `device-smoke-events-${Date.now()}`;

function say(msg) {
  writeSync(1, `[smoke:events] ${msg}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tel = spawn(process.execPath, [path.join(root, "apps/telemetry-service/dist/main.js")], {
  env: { ...process.env, DB_URL: DB, SERVICE_MODE: "http", PORT: String(TEL), TELEMETRY_PUBLISH_EVENTS: "true" },
  stdio: "inherit",
});
const dec = spawn(process.execPath, [path.join(root, "apps/decision-service/dist/main.js")], {
  env: { ...process.env, DB_URL: DB, SERVICE_MODE: "http", PORT: String(DEC) },
  stdio: "inherit",
});
const msg = spawn(process.execPath, [path.join(root, "apps/message-service/dist/main.js")], {
  env: { ...process.env, DB_URL: DB, SERVICE_MODE: "http", PORT: String(MSG), MESSAGE_POLL_INTERVAL_MS: "200" },
  stdio: "inherit",
});

async function waitHealth(port, name) {
  for (let i = 0; i < 100; i += 1) {
    for (const [label, child] of [["telemetry", tel], ["decision", dec], ["message", msg]]) {
      if (child.exitCode !== null) throw new Error(`${label} 进程已退出，退出码 ${child.exitCode}`);
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
  return response.json();
}

let client = null;
let ruleId = null;

/** 清理本次冒烟写入的业务数据，保证脚本可重复执行 */
async function cleanData() {
  if (!client) return;
  try {
    await client.query("DELETE FROM ops_messages WHERE plot_code = $1", [PLOT]);
    await client.query("DELETE FROM event_log WHERE payload_json->>'parcelId' = $1", [PLOT]);
    await client.query("DELETE FROM telemetry_alerts WHERE device_id = $1", [DEVICE]);
    await client.query("DELETE FROM telemetry_readings WHERE device_id = $1", [DEVICE]);
    await client.query("DELETE FROM telemetry_outbox WHERE payload_json->>'parcelId' = $1", [PLOT]);
    await client.query("DELETE FROM decision_outbox WHERE payload_json->>'parcelId' = $1", [PLOT]);
    await client.query("DELETE FROM decision_prescription_outcomes WHERE plot_code = $1", [PLOT]);
    await client.query("DELETE FROM decision_prescriptions WHERE plot_code = $1", [PLOT]);
    if (ruleId) await client.query("DELETE FROM decision_rules WHERE id = $1", [ruleId]);
  } catch (error) {
    say(`清理告警：${error.message}`);
  }
}

/** 轮询消息列表直到出现预期条数，避免依赖固定等待时长 */
async function waitMessages(predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    const page = await request(`http://127.0.0.1:${MSG}/api/v1/messages?plotCode=${encodeURIComponent(PLOT)}&size=50`);
    latest = page.data?.items ?? [];
    if (predicate(latest)) return latest;
    await delay(500);
  }
  throw new Error(`等待消息超时，当前消息：${JSON.stringify(latest)}`);
}

try {
  await waitHealth(TEL, "telemetry");
  say("telemetry healthy");
  await waitHealth(DEC, "decision");
  say("decision healthy");
  await waitHealth(MSG, "message");
  say("message healthy");

  client = new Client({ connectionString: DB });
  await client.connect();
  await cleanData();

  // 冒烟专用规则：优先级高于默认规则，效果回流写回时只影响本规则
  const created = await request(`http://127.0.0.1:${DEC}/api/v1/decision/rules`, "POST", {
    name: "冒烟事件闭环规则",
    type: "IRRIGATION",
    priority: 1,
    condition: { soilMoistureBelow: 30, rainProbabilityBelow: 60 },
    action: { type: "IRRIGATION", amount: 18, unit: "mm", reason: "冒烟验证" },
  });
  assert(created.code === "OK" && created.data?.id, `新建规则失败：${JSON.stringify(created)}`);
  ruleId = created.data.id;
  say(`rule created ${ruleId}`);

  // 1. 遥测越限：低含水率触发告警事件
  const reported = await request(`http://127.0.0.1:${TEL}/api/v1/telemetry/report`, "POST", {
    deviceId: DEVICE,
    plotCode: PLOT,
    metric: "soilMoisture",
    value: 18,
    unit: "%",
    recordedAt: new Date().toISOString(),
  });
  assert(reported.code === "OK", `上报读数失败：${JSON.stringify(reported)}`);
  say("threshold reading reported");

  // 2. 处方生成：命中冒烟规则并发布处方事件
  const prescription = await request(`http://127.0.0.1:${DEC}/api/v1/decision/prescriptions`, "POST", {
    plotCode: PLOT,
    plotName: "冒烟地块",
    soilMoisture: 20,
    rainProbability: 10,
    growthStage: "冒烟校验",
  });
  assert(prescription.data?.status === "RECOMMENDED", `处方未命中规则：${JSON.stringify(prescription)}`);
  assert(prescription.data.matchedRules?.[0]?.id === ruleId, "处方命中的规则不是冒烟规则");
  say(`prescription issued ${prescription.data.id}`);

  // 3. 消息中心消费两个事件
  const messages = await waitMessages((items) => items.length >= 2);
  const alert = messages.find((item) => item.type === "ALERT");
  const notice = messages.find((item) => item.type === "NOTICE");
  assert(alert, "未生成越限告警消息");
  assert(notice, "未生成处方通知消息");
  assert(alert.title.includes("土壤含水率越限"), `告警标题异常：${alert.title}`);
  assert(notice.title.includes("灌溉处方已生成"), `通知标题异常：${notice.title}`);
  say("event-driven messages OK");

  // 4. 效果回流：复测含水率未回升，给出提高阈值的建议
  const evaluation = await request(`http://127.0.0.1:${DEC}/api/v1/decision/prescriptions/${prescription.data.id}/outcome`, "POST", {
    soilMoistureAfter: 21,
    note: "冒烟复测",
  });
  assert(evaluation.code === "OK", `效果评估失败：${JSON.stringify(evaluation)}`);
  assert(evaluation.data.outcome.effective === false, "未达目标应判为效果不足");
  assert(evaluation.data.outcome.suggestion?.suggestedThreshold === 35, `阈值建议异常：${JSON.stringify(evaluation.data.outcome)}`);
  say("outcome evaluated, suggestion 30 -> 35");

  // 5. 建议写回规则：规则热更新后阈值提升
  const applied = await request(`http://127.0.0.1:${DEC}/api/v1/decision/prescriptions/${prescription.data.id}/outcome`, "POST", {
    soilMoistureAfter: 21,
    applySuggestion: true,
  });
  assert(applied.data.outcome.applied === true, `建议未写回规则：${JSON.stringify(applied.data)}`);
  const rule = await request(`http://127.0.0.1:${DEC}/api/v1/decision/rules/${ruleId}`);
  assert(Number(rule.data?.condition?.soilMoistureBelow) === 35, `规则阈值未更新：${JSON.stringify(rule.data)}`);
  say("rule threshold tuned 30 -> 35");

  // 6. 重复读取不重复生成消息：消费位点已提交
  const again = await request(`http://127.0.0.1:${MSG}/api/v1/messages?plotCode=${encodeURIComponent(PLOT)}&size=50`);
  assert((again.data?.items ?? []).length === messages.length, "重复轮询产生了多余消息");
  say("idempotent consumption OK");
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
  for (const child of [msg, dec, tel]) if (!child.killed) child.kill("SIGTERM");
  await delay(800);
}
