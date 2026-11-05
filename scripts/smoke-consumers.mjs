import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

/**
 * 事件消费方冒烟：遥测越限与处方事件 → 共享事件日志 → 控制指令与生产档案。
 *
 * 需要 PostgreSQL（事件日志、控制指令与追溯档案均落库）以及已应用的 005 迁移。
 * 使用独立端口与地块编码，脚本可重复执行并在结束时清理自建数据。
 */

const root = process.cwd();
const DB = process.env.DB_URL ?? "postgresql://agri:agri@127.0.0.1:5432/agri";
const TEL = 3621;
const DEC = 3622;
const CTRL = 3623;
const TRC = 3624;
const PLOT = "P-SMOKE-CONSUMERS";
const DEVICE = `device-smoke-consumers-${Date.now()}`;

function say(msg) {
  writeSync(1, `[smoke:consumers] ${msg}\n`);
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

const tel = start("telemetry", "apps/telemetry-service/dist/main.js", { PORT: String(TEL), TELEMETRY_PUBLISH_EVENTS: "true" });
const dec = start("decision", "apps/decision-service/dist/main.js", { PORT: String(DEC) });
const ctrl = start("control", "apps/control-service/dist/main.js", { PORT: String(CTRL), CONTROL_POLL_INTERVAL_MS: "200" });
const trc = start("trace", "apps/trace-service/dist/main.js", { PORT: String(TRC), TRACE_POLL_INTERVAL_MS: "200" });

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
  return response.json();
}

/** 轮询直到列表满足断言，避免依赖固定等待时长 */
async function waitList(url, predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    const page = await request(url);
    latest = page.data?.items ?? [];
    if (predicate(latest)) return latest;
    await delay(500);
  }
  throw new Error(`等待${label}超时，当前数据：${JSON.stringify(latest)}`);
}

let client = null;
let ruleId = null;

/** 清理本次冒烟写入的业务数据，保证脚本可重复执行 */
async function cleanData() {
  if (!client) return;
  try {
    await client.query("DELETE FROM control_commands WHERE plot_code = $1", [PLOT]);
    await client.query("DELETE FROM trace_records WHERE plot_code = $1", [PLOT]);
    await client.query("DELETE FROM event_log WHERE payload_json->>'parcelId' = $1", [PLOT]);
    await client.query("DELETE FROM telemetry_alerts WHERE device_id = $1", [DEVICE]);
    await client.query("DELETE FROM telemetry_readings WHERE device_id = $1", [DEVICE]);
    await client.query("DELETE FROM telemetry_outbox WHERE payload_json->>'parcelId' = $1", [PLOT]);
    await client.query("DELETE FROM decision_outbox WHERE payload_json->>'parcelId' = $1", [PLOT]);
    await client.query("DELETE FROM decision_prescriptions WHERE plot_code = $1", [PLOT]);
    if (ruleId) await client.query("DELETE FROM decision_rules WHERE id = $1", [ruleId]);
  } catch (error) {
    say(`清理告警：${error.message}`);
  }
}

try {
  await waitHealth(TEL, "telemetry");
  say("telemetry healthy");
  await waitHealth(DEC, "decision");
  say("decision healthy");
  await waitHealth(CTRL, "control");
  say("control healthy");
  await waitHealth(TRC, "trace");
  say("trace healthy");

  client = new Client({ connectionString: DB });
  await client.connect();
  await cleanData();

  // 冒烟专用规则：优先级高于默认规则，命中后给出灌溉处方
  const created = await request(`http://127.0.0.1:${DEC}/api/v1/decision/rules`, "POST", {
    name: "冒烟事件消费规则",
    type: "IRRIGATION",
    priority: 1,
    condition: { soilMoistureBelow: 30, rainProbabilityBelow: 60 },
    action: { type: "IRRIGATION", amount: 18, unit: "mm", reason: "冒烟验证" },
  });
  assert(created.code === "OK" && created.data?.id, `新建规则失败：${JSON.stringify(created)}`);
  ruleId = created.data.id;
  say(`rule created ${ruleId}`);

  // 1. 遥测越限：低含水率触发越限事件
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
  say(`prescription issued ${prescription.data.id}`);

  // 3. 控制侧消费：越限与处方各生成一条自动水肥指令
  const commands = await waitList(
    `http://127.0.0.1:${CTRL}/api/v1/control/commands?plotCode=${encodeURIComponent(PLOT)}&origin=EVENT&size=50`,
    (items) => items.some((item) => item.parameters?.source === "threshold") && items.some((item) => item.parameters?.source === "prescription"),
    "自动控制指令",
  );
  const thresholdCommand = commands.find((item) => item.parameters?.source === "threshold");
  const prescriptionCommand = commands.find((item) => item.parameters?.source === "prescription");
  assert(thresholdCommand.type === "IRRIGATION", `越限指令类型异常：${JSON.stringify(thresholdCommand)}`);
  assert(prescriptionCommand.type === "IRRIGATION", `处方指令类型异常：${JSON.stringify(prescriptionCommand)}`);
  assert(thresholdCommand.status === "QUEUED" && thresholdCommand.operatorId === "system:event", "自动指令未进入队列或执行人异常");
  assert(thresholdCommand.sourceEventId, "自动指令未记录来源事件");
  say("threshold + prescription commands queued");

  // 4. 追溯侧消费：处方事件写入生产档案
  const records = await waitList(
    `http://127.0.0.1:${TRC}/api/v1/trace/records?plotCode=${encodeURIComponent(PLOT)}&size=50`,
    (items) => items.some((item) => item.event === "PRESCRIPTION_ISSUED"),
    "处方追溯档案",
  );
  const record = records.find((item) => item.event === "PRESCRIPTION_ISSUED");
  assert(record.plotCode === PLOT, `档案地块异常：${JSON.stringify(record)}`);
  assert(record.detail.includes("灌溉处方"), `档案详情异常：${record.detail}`);
  const onlyPrescriptions = await request(`http://127.0.0.1:${TRC}/api/v1/trace/records?plotCode=${encodeURIComponent(PLOT)}&event=PRESCRIPTION_ISSUED&size=50`);
  assert((onlyPrescriptions.data?.items ?? []).every((item) => item.event === "PRESCRIPTION_ISSUED"), "档案事件筛选未生效");
  say("prescription archived to trace record");

  // 5. 重复轮询不重复下发：消费位点已提交
  await delay(1500);
  const again = await request(`http://127.0.0.1:${CTRL}/api/v1/control/commands?plotCode=${encodeURIComponent(PLOT)}&origin=EVENT&size=50`);
  assert((again.data?.items ?? []).length === commands.length, "重复轮询产生了多余控制指令");
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
  for (const child of children) if (!child.killed) child.kill("SIGTERM");
  await delay(800);
}
