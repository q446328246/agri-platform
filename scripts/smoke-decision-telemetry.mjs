import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

const root = process.cwd();
const DB = process.env.DB_URL ?? "postgresql://agri:agri@127.0.0.1:5432/agri";
const TEL = 3404;
const DEC = 3406;
const PLOT = "P-511723-00001-00001";

function say(msg) { writeSync(1, `[smoke] ${msg}\n`); }

const tel = spawn(process.execPath, [path.join(root, "apps/telemetry-service/dist/main.js")],
  { env: { ...process.env, DB_URL: DB, SERVICE_MODE: "http", PORT: String(TEL) }, stdio: "inherit" });
const dec = spawn(process.execPath, [path.join(root, "apps/decision-service/dist/main.js")],
  { env: { ...process.env, DB_URL: DB, SERVICE_MODE: "http", PORT: String(DEC) }, stdio: "inherit" });

async function waitHealth(port, name) {
  for (let i = 0; i < 80; i++) {
    if (tel.exitCode !== null) throw new Error(`${name}: tel exited ${tel.exitCode}`);
    if (dec.exitCode !== null) throw new Error(`${name}: dec exited ${dec.exitCode}`);
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return; } catch {}
    await delay(300);
  }
  throw new Error(`${name} health timeout`);
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function post(url, body) { return (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json(); }
async function getJson(url) { return (await fetch(url)).json(); }

let ruleId = null;
let client = null;
let device = "";

/** 清理本次冒烟写入的规则、处方与读数，保证脚本可重复执行 */
async function cleanData() {
  if (!client) return;
  try {
    if (device) {
      // 按冒烟设备前缀清理，含历史遗留的 device-smoke-* 数据
      await client.query("DELETE FROM telemetry_alerts WHERE device_id LIKE 'device-smoke-%'");
      await client.query("DELETE FROM telemetry_readings WHERE device_id LIKE 'device-smoke-%'");
    }
    await client.query("DELETE FROM decision_prescriptions WHERE plot_code = $1 AND inputs_json::text LIKE '%冒烟%'", [PLOT]);
    // 冒烟用进程内发布器，处方事件落表后无外部投递方，测试结束一并清理
    await client.query("DELETE FROM decision_outbox WHERE payload_json->>'parcelId' = $1", [PLOT]);
    if (ruleId) await client.query("DELETE FROM decision_rules WHERE id = $1", [ruleId]);
  } catch (e) { say(`cleanup warn: ${e.message}`); }
}
try {
  device = `device-smoke-${Date.now()}`;
  await waitHealth(TEL, "tel");
  say("tel healthy");
  await waitHealth(DEC, "dec");
  say("dec healthy");

  client = new Client({ connectionString: DB });
  await client.connect();
  await cleanData();

  for (const [i, v] of [[0, 18], [1, 21], [2, 25]]) {
    const r = await post(`http://127.0.0.1:${TEL}/api/v1/telemetry/report`,
      { deviceId: device, plotCode: PLOT, metric: "soilMoisture", value: v, unit: "%", recordedAt: new Date(Date.now() - (300 - i * 100) * 1000).toISOString() });
    assert(r.code === "OK", `上报失败: ${JSON.stringify(r)}`);
  }
  say("3 readings reported");

  const series = await getJson(`http://127.0.0.1:${TEL}/api/v1/telemetry/history/series?deviceId=${device}&metric=soilMoisture`);
  assert(Array.isArray(series.data) && series.data.length === 3, `历史曲线异常: ${JSON.stringify(series.data)}`);
  assert(series.data[0].value === 18 && series.data[2].value === 25, "未按时间升序");
  say("history series OK");

  const latest = await getJson(`http://127.0.0.1:${TEL}/api/v1/telemetry/latest?deviceId=${device}`);
  assert(latest.data.some((r) => r.metric === "soilMoisture" && r.value === 25), "最新读数缺失");
  say("latest OK");

  // 低值上报触发阈值告警，验证告警链路与处理接口
  await post(`http://127.0.0.1:${TEL}/api/v1/telemetry/report`,
    { deviceId: device, plotCode: PLOT, metric: "soilMoisture", value: 12, unit: "%", recordedAt: new Date().toISOString() });
  const alerts = await getJson(`http://127.0.0.1:${TEL}/api/v1/telemetry/alerts`);
  const mine = (alerts.data ?? []).filter((a) => a.deviceId === device);
  assert(mine.length > 0, "低值上报未生成告警");
  const handled = await post(`http://127.0.0.1:${TEL}/api/v1/telemetry/alerts/${encodeURIComponent(mine[0].id)}/handle`, {});
  assert(handled.code === "OK", `告警处理失败: ${JSON.stringify(handled)}`);
  const rest = await getJson(`http://127.0.0.1:${TEL}/api/v1/telemetry/alerts`);
  assert(!(rest.data ?? []).some((a) => a.id === mine[0].id), "告警处理后仍在待处理列表");
  say("threshold alert + handle OK");

  const ruleRes = await post(`http://127.0.0.1:${DEC}/api/v1/decision/rules`,
    { name: "冒烟灌溉规则", type: "IRRIGATION", condition: { soilMoistureBelow: 30 }, action: { type: "IRRIGATION", amount: 20, unit: "mm", reason: "冒烟验证" } });
  const rule = ruleRes.data;
  assert(ruleRes.code === "OK" && rule?.id, `新建规则失败: ${JSON.stringify(ruleRes)}`);
  ruleId = rule.id;
  say(`rule created ${rule.id}`);

  const upd = await (await fetch(`http://127.0.0.1:${DEC}/api/v1/decision/rules/${rule.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ condition: { soilMoistureBelow: 40 } }) })).json();
  assert(upd.code === "OK" && Number(upd.data?.condition?.soilMoistureBelow) === 40, `热更新失败: ${JSON.stringify(upd)}`);
  say("rule hot-updated 30->40");

  const noHit = await post(`http://127.0.0.1:${DEC}/api/v1/decision/prescriptions`, { plotCode: PLOT, soilMoisture: 45, rainProbability: 0, growthStage: "冒烟校验" });
  assert(!noHit.data?.matchedRules?.some((m) => m.id === rule.id), `value=45 不应命中: ${JSON.stringify(noHit.data)}`);
  say("value=45 no match OK");

  const rx = await post(`http://127.0.0.1:${DEC}/api/v1/decision/prescriptions`, { plotCode: PLOT, soilMoisture: 35, rainProbability: 0, growthStage: "冒烟校验" });
  assert(rx.data?.status === "RECOMMENDED", `value=35 应命中: ${JSON.stringify(rx.data)}`);
  assert(rx.data.matchedRules?.some((m) => m.id === rule.id), "处方未命中热更新后规则");
  say("value=35 matched hot-updated rule");

  const list = await getJson(`http://127.0.0.1:${DEC}/api/v1/decision/prescriptions?plotCode=${PLOT}&size=50`);
  const items = list.data.items ?? list.data;
  assert(items.some((item) => item.id === rx.data.id), "处方留痕未查到");
  say(`prescription trace OK: ${items.length} records`);
  say("SMOKE PASS");
} catch (error) {
  say(`SMOKE FAIL: ${error && error.stack ? error.stack : error}`);
} finally {
  await cleanData();
  if (client) { await client.end().catch(() => undefined); client = null; }
  tel.kill("SIGTERM");
  dec.kill("SIGTERM");
  await delay(800);
}