import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

/**
 * 控制指令回执链路冒烟：下发确认 → 设备回执 → 结单事件 → 档案 / 消息 / 处方执行回流。
 *
 * 覆盖 `#94`（回执状态机）、`#96`/`#100`（灌溉与施肥结单事件及其口径）、`#101`（决策侧执行回流）
 * 在真实进程与真实库上的组合，这些是单元测试（内存实现 + 假客户端）验不到的部分：
 * 跃迁时间戳是否真的落库、`control_outbox` 是否真的被中继写进 `event_log`、三个消费方是否各自
 * 把同一条事件读成正确的账。
 *
 * 需要 PostgreSQL 与已应用的迁移 031（回执列）、033（`control_outbox`）、034（执行回流表）；
 * 未应用迁移时对应语句会直接报错，脚本以 FAIL 退出而不是跳过。
 *
 * **不验超时收口**（`ControlReceiptSweeper`）：它的候选查询是跨租户全表的
 * `status IN ('QUEUED','SENT','ACKED')`，为了在这轮里收口而把 `CONTROL_RECEIPT_TIMEOUT_MIN`
 * 调小，会连带把演示库里别人正在途的指令刷成 FAILED 并各推一条告警——冒烟脚本不该有这种副作用。
 * 该路径由 `apps/control-service/test/receipt-sweeper.spec.ts` 与 `sql-control-outbox.spec.ts` 覆盖。
 *
 * 使用独立端口与地块编码，脚本可重复执行并在结束时清理自建数据。
 */

const root = process.cwd();
const DB = process.env.DB_URL ?? "postgresql://agri:agri@127.0.0.1:5432/agri";
const DEC = 3641;
const CTRL = 3642;
const TRC = 3643;
const MSG = 3644;
const PLOT = "P-SMOKE-RECEIPT";
const DEVICE = "device-smoke-receipt";
/** 设备实测用水量：断言里出现的数字全部由它派生，不在多处各抄一遍 */
const REPORTED_WATER_M3 = 25.5;
/** 设备实测作业时长（分钟） */
const REPORTED_DURATION_MIN = 21;

function say(msg) {
  writeSync(1, `[smoke:command-receipt] ${msg}\n`);
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

// 决策侧既下发处方事件、又消费结单事件；控制侧负责回执与消息表；追溯与消息中心是下游
const dec = start("decision", "apps/decision-service/dist/main.js", { PORT: String(DEC), DECISION_POLL_INTERVAL_MS: "200" });
const ctrl = start("control", "apps/control-service/dist/main.js", {
  PORT: String(CTRL),
  CONTROL_POLL_INTERVAL_MS: "200",
  CONTROL_OUTBOX_RELAY_INTERVAL_MS: "300",
});
const trc = start("trace", "apps/trace-service/dist/main.js", { PORT: String(TRC), TRACE_POLL_INTERVAL_MS: "200" });
const msg = start("message", "apps/message-service/dist/main.js", { PORT: String(MSG), MESSAGE_POLL_INTERVAL_MS: "200" });

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

/** 返回 `{ status, code, data, message }`：断言既看 HTTP 码（400/409 拦截），也看业务信封 */
async function request(url, method = "GET", body, headers = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const envelope = await response.json().catch(() => null);
  return { status: response.status, ...(envelope ?? {}) };
}

/** 人工指令必须带操作人身份与二次确认，守卫关闭时这两项依然必需 */
const MANUAL_HEADERS = { "x-user-id": "smoke-receipt", "x-confirm-action": "CONFIRM" };

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

/** 轮询库内查询结果，用于「事件是否已被中继投递」这类没有接口可查的事实 */
async function waitRows(sql, params, predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    latest = (await client.query(sql, params)).rows;
    if (predicate(latest)) return latest;
    await delay(400);
  }
  throw new Error(`等待${label}超时，当前数据：${JSON.stringify(latest)}`);
}

const ruleIds = [];

/** 清理本次冒烟写入的业务数据，保证脚本可重复执行 */
async function cleanData() {
  if (!client) return;
  try {
    await client.query("DELETE FROM control_commands WHERE plot_code = $1", [PLOT]);
    await client.query("DELETE FROM trace_records WHERE plot_code = $1", [PLOT]);
    await client.query("DELETE FROM ops_messages WHERE plot_code = $1", [PLOT]);
    await client.query("DELETE FROM decision_prescription_executions WHERE plot_code = $1", [PLOT]);
    await client.query("DELETE FROM decision_prescriptions WHERE plot_code = $1", [PLOT]);
    await client.query("DELETE FROM event_log WHERE payload_json->>'parcelId' = $1", [PLOT]);
    await client.query("DELETE FROM control_outbox WHERE payload_json->>'parcelId' = $1", [PLOT]);
    await client.query("DELETE FROM decision_outbox WHERE payload_json->>'parcelId' = $1", [PLOT]);
    for (const ruleId of ruleIds) await client.query("DELETE FROM decision_rules WHERE id = $1", [ruleId]);
  } catch (error) {
    say(`清理告警：${error.message}`);
  }
}

/** 取一条指令的当前视图（列表接口带 pendingMin/overdue，跃迁后必取最新 version） */
async function command(id) {
  const list = await request(`http://127.0.0.1:${CTRL}/api/v1/control/commands?plotCode=${encodeURIComponent(PLOT)}&size=100`);
  return (list.data?.items ?? []).find((item) => item.id === id);
}

/** 断言某条指令的结单事件只有一条待投递记录，并返回它的载荷 */
async function finishedEvent(commandId, topic) {
  const traceId = `control-finished:${commandId}`;
  const rows = await waitRows(
    "SELECT topic, payload_json, published_at FROM control_outbox WHERE trace_id = $1",
    [traceId],
    (result) => result.length === 1 && result[0].published_at !== null,
    `${topic} 事件中继`,
  );
  assert(rows[0].topic === topic, `${commandId} 的消息表主题异常：${rows[0].topic}`);
  const published = await waitRows(
    "SELECT seq, topic, payload_json FROM event_log WHERE trace_id = $1",
    [traceId],
    (result) => result.length >= 1,
    `${topic} 进入共享事件日志`,
  );
  assert(published.length === 1, `${topic} 事件重复投递：${published.length} 条`);
  assert(published[0].topic === topic, `事件日志主题异常：${published[0].topic}`);
  return rows[0].payload_json;
}

/** 按指令取生产档案（追溯码由指令 id 派生，不手抄） */
async function traceRecord(event, commandId, prefix) {
  const records = await waitList(
    `http://127.0.0.1:${TRC}/api/v1/trace/records?plotCode=${encodeURIComponent(PLOT)}&event=${event}&size=50`,
    (items) => items.some((item) => item.traceCode === `${prefix}-${commandId}`),
    `${event} 档案`,
  );
  return { all: records.filter((item) => item.traceCode === `${prefix}-${commandId}`), record: records.find((item) => item.traceCode === `${prefix}-${commandId}`) };
}

/** 消息中心按本地块取通知（地块与去重键都按指令收敛，不必再按关键词二次筛选） */
async function notices(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    const page = await request(`http://127.0.0.1:${MSG}/api/v1/messages?type=NOTICE&plotCode=${encodeURIComponent(PLOT)}&size=50`);
    latest = page.data?.items ?? [];
    if (latest.length > 0) return latest;
    await delay(500);
  }
  throw new Error(`等待本地块 NOTICE 超时`);
}

/** 取内容里带指定片段的那条通知，断言时用整条文案说话 */
async function noticeIncluding(...fragments) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const items = (await notices()).filter((item) => fragments.every((fragment) => item.content.includes(fragment)));
    if (items.length > 0) return items;
    await delay(500);
  }
  const contents = (await notices()).map((item) => item.content);
  throw new Error(`未找到包含 ${JSON.stringify(fragments)} 的通知，当前消息中心本地块文案：${JSON.stringify(contents)}`);
}

try {
  await waitHealth(DEC, "decision");
  say("decision healthy");
  await waitHealth(CTRL, "control");
  say("control healthy");
  await waitHealth(TRC, "trace");
  say("trace healthy");
  await waitHealth(MSG, "message");
  say("message healthy");

  client = new Client({ connectionString: DB });
  await client.connect();
  await cleanData();

  // 两条规则同命中一张处方：灌溉走「设备实测」正路，施肥留作「参数推不出用量」的诚实口径
  for (const rule of [
    { name: "冒烟回执灌溉规则", type: "IRRIGATION", priority: 1, condition: { soilMoistureBelow: 30, rainProbabilityBelow: 60 }, action: { type: "IRRIGATION", amount: 18, unit: "mm", reason: "回执冒烟" } },
    { name: "冒烟回执施肥规则", type: "FERTILIZATION", priority: 2, condition: { soilMoistureBelow: 30 }, action: { type: "FERTILIZATION", amount: 3.5, unit: "kg/mu", reason: "回执冒烟" } },
  ]) {
    const created = await request(`http://127.0.0.1:${DEC}/api/v1/decision/rules`, "POST", rule);
    assert(created.status === 201 || created.status === 200, `新建规则失败 ${created.status}：${JSON.stringify(created)}`);
    assert(created.data?.id, `规则未返回 id：${JSON.stringify(created)}`);
    ruleIds.push(created.data.id);
  }
  say(`rules created ${ruleIds.join(", ")}`);

  // ---------- ① 处方下发 → 控制侧自动生成一灌一肥两条指令 ----------
  const prescriptionResponse = await request(`http://127.0.0.1:${DEC}/api/v1/decision/prescriptions`, "POST", {
    plotCode: PLOT,
    plotName: "回执冒烟地块",
    soilMoisture: 20,
    rainProbability: 10,
    growthStage: "回执冒烟",
  });
  assert(prescriptionResponse.status === 201, `处方接口异常：${prescriptionResponse.status}`);
  const prescriptionId = prescriptionResponse.data?.id;
  assert(prescriptionId, `处方未返回标识：${JSON.stringify(prescriptionResponse)}`);
  say(`prescription issued ${prescriptionId}`);

  const queued = await waitList(
    `http://127.0.0.1:${CTRL}/api/v1/control/commands?plotCode=${encodeURIComponent(PLOT)}&origin=EVENT&size=50`,
    (items) => items.some((item) => item.type === "IRRIGATION") && items.some((item) => item.type === "FERTILIZATION"),
    "处方自动下发的水肥指令",
  );
  const irrigation = queued.find((item) => item.type === "IRRIGATION");
  const autoFertilization = queued.find((item) => item.type === "FERTILIZATION");
  for (const [label, item] of [["灌溉", irrigation], ["施肥", autoFertilization]]) {
    assert(item.status === "QUEUED", `${label}指令未停在入队态：${JSON.stringify(item)}`);
    assert(item.parameters?.source === "prescription", `${label}指令来源异常：${JSON.stringify(item.parameters)}`);
    assert(item.parameters?.prescriptionId === prescriptionId, `${label}指令未带上来源处方：${JSON.stringify(item.parameters)}`);
    assert(!item.sentAt && !item.ackedAt && !item.finishedAt, `${label}指令在途时间字段应为空：${JSON.stringify(item)}`);
  }
  say("prescription commands queued with prescriptionId");

  // ---------- ② 设备领取：QUEUED → SENT，重复领取幂等 ----------
  const dispatched = await request(`http://127.0.0.1:${CTRL}/api/v1/control/device/dispatch`, "POST", { commandId: irrigation.id, message: "网关已领取" });
  assert(dispatched.status === 200, `下发确认接口异常：${dispatched.status} ${JSON.stringify(dispatched)}`);
  assert(dispatched.data.status === "SENT", `下发后状态异常：${dispatched.data.status}`);
  assert(dispatched.data.version === irrigation.version + 1, `下发未推进乐观锁：${irrigation.version} → ${dispatched.data.version}`);
  assert(Boolean(dispatched.data.sentAt), "下发未记录 sentAt");
  const redispatch = await request(`http://127.0.0.1:${CTRL}/api/v1/control/device/dispatch`, "POST", { commandId: irrigation.id });
  assert(redispatch.status === 200 && redispatch.data.version === dispatched.data.version, `重复下发未幂等返回：${JSON.stringify(redispatch)}`);
  say("dispatch OK + idempotent retry");

  // 想用回执接口报 SENT 属于用错通道，服务端应明确指路
  const wrongChannel = await request(`http://127.0.0.1:${CTRL}/api/v1/control/device/receipt`, "POST", { commandId: irrigation.id, status: "SENT" });
  assert(wrongChannel.status === 400, `回执接口接受了 SENT（应 400）：${wrongChannel.status}`);
  say("receipt(SENT) rejected with 400");

  // ---------- ③ 设备接收 → 结单（实测用水与时长）----------
  const acked = await request(`http://127.0.0.1:${CTRL}/api/v1/control/device/receipt`, "POST", { commandId: irrigation.id, status: "ACKED", message: "水肥机已接收" });
  assert(acked.status === 200 && acked.data.status === "ACKED", `接收回执异常：${JSON.stringify(acked)}`);
  assert(Boolean(acked.data.ackedAt) && acked.data.ackedAt >= acked.data.sentAt, `ackedAt 缺失或早于 sentAt：${JSON.stringify(acked.data)}`);
  const irrigDone = await request(`http://127.0.0.1:${CTRL}/api/v1/control/device/receipt`, "POST", {
    commandId: irrigation.id,
    status: "DONE",
    message: "灌溉完成",
    result: { waterVolumeM3: REPORTED_WATER_M3, durationMin: REPORTED_DURATION_MIN },
  });
  assert(irrigDone.status === 200 && irrigDone.data.status === "DONE", `结单回执异常：${JSON.stringify(irrigDone)}`);
  assert(Boolean(irrigDone.data.finishedAt) && irrigDone.data.finishedAt >= irrigDone.data.ackedAt, `finishedAt 缺失或早于 ackedAt：${JSON.stringify(irrigDone.data)}`);
  // 终态不可再改：迟到的 ACKED 应拿 409，而不是把 DONE 拖回去
  const lateReceipt = await request(`http://127.0.0.1:${CTRL}/api/v1/control/device/receipt`, "POST", { commandId: irrigation.id, status: "ACKED" });
  assert(lateReceipt.status === 409, `终态指令接受了迟到回执：${lateReceipt.status} ${JSON.stringify(lateReceipt)}`);
  say("ACKED → DONE OK, 时间列落库, 迟到回执 409");

  // ---------- ④ 结单事件：消息表 → 事件日志，重复 DONE 不翻倍 ----------
  const irrigPayload = await finishedEvent(irrigation.id, "control.irrigation.finished");
  assert(irrigPayload.commandId === irrigation.id, `事件缺指令标识：${JSON.stringify(irrigPayload)}`);
  assert(irrigPayload.prescriptionId === prescriptionId, "处方下发的指令结单后丢了来源处方");
  assert(irrigPayload.waterVolume === REPORTED_WATER_M3 && irrigPayload.waterVolumeSource === "DEVICE", `用水量或来源异常：${JSON.stringify(irrigPayload)}`);
  assert(irrigPayload.durationSource === "DEVICE" && irrigPayload.durationMin === REPORTED_DURATION_MIN, `作业时长或来源异常：${JSON.stringify(irrigPayload)}`);
  const repeatDone = await request(`http://127.0.0.1:${CTRL}/api/v1/control/device/receipt`, "POST", {
    commandId: irrigation.id,
    status: "DONE",
    result: { waterVolumeM3: REPORTED_WATER_M3, durationMin: REPORTED_DURATION_MIN },
  });
  assert(repeatDone.status === 200 && repeatDone.data.version === irrigDone.data.version, `重复 DONE 改动了记录：${JSON.stringify(repeatDone)}`);
  await delay(1500);
  const outboxCount = (await client.query("SELECT count(*)::int AS n FROM control_outbox WHERE trace_id = $1", [`control-finished:${irrigation.id}`])).rows[0].n;
  assert(outboxCount === 1, `重复 DONE 产生了第二条结单事件：${outboxCount} 条`);
  say("irrigation finished event published once (DEVICE sources)");

  // ---------- ⑤ 下游三本账：档案、消息、处方执行回流 ----------
  const irrigArchive = await traceRecord("IRRIGATION_FINISHED", irrigation.id, "TR-IRR");
  assert(irrigArchive.all.length === 1, `灌溉档案重复：${irrigArchive.all.length} 条`);
  assert(irrigArchive.record.detail.includes(`用水 ${REPORTED_WATER_M3} 立方米（设备实测）`), `灌溉档案未采信设备实测：${irrigArchive.record.detail}`);
  const irrigNotices = await noticeIncluding("的灌溉指令");
  assert(irrigNotices.length === 1, `同一指令的灌溉通知刷屏：${JSON.stringify(irrigNotices.map((item) => item.content))}`);
  assert(irrigNotices[0].content.includes(`用水 ${REPORTED_WATER_M3} 立方米（设备实测）`), `灌溉通知未采信设备实测：${irrigNotices[0].content}`);

  const executions = await waitList(
    `http://127.0.0.1:${DEC}/api/v1/decision/executions?prescriptionId=${encodeURIComponent(prescriptionId)}&size=50`,
    (items) => items.some((item) => item.commandId === irrigation.id),
    "处方执行回流记录",
  );
  const irrigExecution = executions.find((item) => item.commandId === irrigation.id);
  assert(irrigExecution.planType === "irrigation", `回流记成别的作业类型：${JSON.stringify(irrigExecution)}`);
  assert(Number(irrigExecution.waterVolume) === REPORTED_WATER_M3 && irrigExecution.waterVolumeSource === "DEVICE", `回流用水量或来源异常：${JSON.stringify(irrigExecution)}`);
  assert(irrigExecution.plotCode === PLOT, `回流地块与处方不一致：${irrigExecution.plotCode}`);
  say("irrigation closed across archive / message / prescription execution");

  // ---------- ⑥ 施肥（处方下发）：参数推不出用量时如实说「未上报」 ----------
  // 处方下发的施肥指令只有明细（亩均用量），没有分区也没有配比，结单事件不该编一个千克数出来
  await request(`http://127.0.0.1:${CTRL}/api/v1/control/device/dispatch`, "POST", { commandId: autoFertilization.id });
  const fertAcked = await request(`http://127.0.0.1:${CTRL}/api/v1/control/device/receipt`, "POST", { commandId: autoFertilization.id, status: "ACKED" });
  assert(fertAcked.status === 200, `施肥接收回执异常：${JSON.stringify(fertAcked)}`);
  const autoFertClosed = await request(`http://127.0.0.1:${CTRL}/api/v1/control/device/receipt`, "POST", { commandId: autoFertilization.id, status: "DONE", message: "施肥完成" });
  assert(autoFertClosed.status === 200 && autoFertClosed.data.status === "DONE", `施肥结单异常：${JSON.stringify(autoFertClosed)}`);
  const autoFertPayload = await finishedEvent(autoFertilization.id, "control.fertilization.finished");
  assert(autoFertPayload.fertilizerKg === undefined, `设备未上报、参数也推不出总量，事件却编出了投肥量：${JSON.stringify(autoFertPayload)}`);
  assert(autoFertPayload.durationSource === "RUNTIME", `没有设备实测时长时应按状态推进时间推算：${JSON.stringify(autoFertPayload)}`);
  const autoFertArchive = await traceRecord("FERTILIZATION_FINISHED", autoFertilization.id, "TR-FERT");
  assert(autoFertArchive.all.length === 1, `施肥档案重复：${autoFertArchive.all.length} 条`);
  assert(autoFertArchive.record.detail.includes("施肥量未上报"), `施肥档案未如实标注用量缺失：${autoFertArchive.record.detail}`);
  const autoFertNotices = await noticeIncluding("施肥量未上报");
  assert(autoFertNotices.length === 1, `施肥量缺失的通知重复或串了别的指令：${JSON.stringify(autoFertNotices.map((item) => item.content))}`);
  assert(autoFertNotices[0].content.includes("的施肥指令"), `未上报口径出现在非施肥通知里：${autoFertNotices[0].content}`);
  const autoFertExecution = (await request(`http://127.0.0.1:${DEC}/api/v1/decision/executions?prescriptionId=${encodeURIComponent(prescriptionId)}&size=50`))
    .data?.items?.find((item) => item.commandId === autoFertilization.id);
  assert(autoFertExecution, `处方下发的施肥指令结单后没有执行回流：${autoFertilization.id}`);
  assert(autoFertExecution.fertilizerKg === null, `回流量编造了投肥量：${JSON.stringify(autoFertExecution)}`);
  assert(autoFertExecution.durationSource === "RUNTIME", `回流时长来源应为 RUNTIME：${JSON.stringify(autoFertExecution)}`);
  say("fertilization closed with 施肥量未上报 (no fabricated amount)");

  // ---------- ⑦ 人工施肥指令：方案推算有值，但不进处方账 ----------
  const manualZones = [{ zoneCode: "A", areaMu: 30, targetMm: 20 }];
  const manualCreated = await request(
    `http://127.0.0.1:${CTRL}/api/v1/control/commands`,
    "POST",
    {
      deviceId: DEVICE,
      plotCode: PLOT,
      type: "FERTILIZATION",
      reason: "回执冒烟：人工下发",
      parameters: { zones: manualZones, recipe: { nitrogen: 3.2, phosphorus: 1.0, potassium: 1.1 } },
    },
    MANUAL_HEADERS,
  );
  assert(manualCreated.status === 202, `人工指令下发异常：${manualCreated.status} ${JSON.stringify(manualCreated)}`);
  assert(manualCreated.data.origin === "MANUAL" && manualCreated.data.status === "QUEUED", `人工指令初始状态异常：${JSON.stringify(manualCreated.data)}`);
  // 没有身份或没有二次确认都不该建指令
  const noConfirm = await request(`http://127.0.0.1:${CTRL}/api/v1/control/commands`, "POST", { deviceId: DEVICE, plotCode: PLOT, type: "FERTILIZATION", parameters: {} });
  assert(noConfirm.status === 409, `缺二次确认仍下发了指令：${noConfirm.status}`);
  const manualId = manualCreated.data.id;
  await request(`http://127.0.0.1:${CTRL}/api/v1/control/device/dispatch`, "POST", { commandId: manualId });
  const manualClosed = await request(`http://127.0.0.1:${CTRL}/api/v1/control/device/receipt`, "POST", { commandId: manualId, status: "DONE", message: "施肥完成" });
  assert(manualClosed.status === 200, `人工施肥结单异常：${JSON.stringify(manualClosed)}`);
  const manualPayload = await finishedEvent(manualId, "control.fertilization.finished");
  // 千克数由服务端按分区面积与配比现算，脚本只取它算出的那个值往下游核对，不再抄一遍公式
  const plannedKg = manualPayload.fertilizerKg;
  assert(typeof plannedKg === "number" && plannedKg > 0, `带配方与面积的施肥指令应能现算投肥量：${JSON.stringify(manualPayload)}`);
  assert(manualPayload.fertilizerSource === "PLAN", `方案推算的用量必须标 PLAN：${JSON.stringify(manualPayload)}`);
  assert(manualPayload.prescriptionId === undefined, "人工指令被伪造成某张处方的执行");
  const manualArchive = await traceRecord("FERTILIZATION_FINISHED", manualId, "TR-FERT");
  assert(manualArchive.all.length === 1, `人工施肥档案重复：${manualArchive.all.length} 条`);
  assert(manualArchive.record.detail.includes(`施氮磷钾合计 ${plannedKg} 千克（按配方与面积推算）`), `施肥档案未核对到事件现算的投肥量：${manualArchive.record.detail}`);
  const manualNotices = await noticeIncluding(`施氮磷钾合计 ${plannedKg} 千克（按配方与面积推算）`);
  assert(manualNotices.length === 1, `人工施肥通知未带上方案推算口径：${JSON.stringify(manualNotices.map((item) => item.content))}`);
  const manualExecution = (await request(`http://127.0.0.1:${DEC}/api/v1/decision/executions?plotCode=${encodeURIComponent(PLOT)}&size=50`))
    .data?.items?.find((item) => item.commandId === manualId);
  assert(!manualExecution, `人工指令没有处方标识，不该进处方执行回流：${JSON.stringify(manualExecution)}`);
  say(`manual fertilization closed with PLAN source ${plannedKg}kg and skipped prescription ledger`);

  // ---------- ⑧ 急停：没有到位确认不给结单，也不发结单事件 ----------
  const estopCreated = await request(
    `http://127.0.0.1:${CTRL}/api/v1/control/commands`,
    "POST",
    { deviceId: DEVICE, plotCode: PLOT, type: "ESTOP", reason: "回执冒烟：急停" },
    MANUAL_HEADERS,
  );
  assert(estopCreated.status === 202, `急停指令下发异常：${estopCreated.status} ${JSON.stringify(estopCreated)}`);
  const estopId = estopCreated.data.id;
  await request(`http://127.0.0.1:${CTRL}/api/v1/control/device/dispatch`, "POST", { commandId: estopId });
  const estopUnconfirmed = await request(`http://127.0.0.1:${CTRL}/api/v1/control/device/receipt`, "POST", { commandId: estopId, status: "DONE" });
  assert(estopUnconfirmed.status === 400, `急停未确认到位仍结单：${estopUnconfirmed.status}`);
  const estopConfirmed = await request(`http://127.0.0.1:${CTRL}/api/v1/control/device/receipt`, "POST", { commandId: estopId, status: "DONE", result: { confirmed: true } });
  assert(estopConfirmed.status === 200 && estopConfirmed.data.status === "DONE", `急停到位结单异常：${JSON.stringify(estopConfirmed)}`);
  await delay(1200);
  const estopOutbox = (await client.query("SELECT count(*)::int AS n FROM control_outbox WHERE payload_json->>'commandId' = $1", [estopId])).rows[0].n;
  assert(estopOutbox === 0, `急停没有可核对的作业量，不该发结单事件：${estopOutbox} 条`);
  const estopCommand = await command(estopId);
  assert(estopCommand.overdue === false, `终态指令仍被标记超时：${JSON.stringify(estopCommand)}`);
  assert(estopCommand.pendingMin === undefined, "终态指令不该带 pendingMin");
  say("ESTOP requires confirmation and emits no finished event");

  // ---------- ⑨ 台账口径：在途筛选只捞自己的 ----------
  const pendingPage = await request(`http://127.0.0.1:${CTRL}/api/v1/control/commands?plotCode=${encodeURIComponent(PLOT)}&pending=true&size=50`);
  const pendingItems = pendingPage.data?.items ?? [];
  assert(pendingItems.every((item) => ["QUEUED", "SENT", "ACKED"].includes(item.status)), `pending=true 混进终态：${JSON.stringify(pendingItems.map((item) => [item.id, item.status]))}`);
  assert(pendingItems.length === 0, `本地块指令全部收口后仍有余留：${JSON.stringify(pendingItems.map((item) => [item.id, item.status]))}`);
  const ledger = await client.query(
    "SELECT status, count(*)::int AS n FROM control_commands WHERE plot_code = $1 GROUP BY status ORDER BY status",
    [PLOT],
  );
  say(`ledger ${ledger.rows.map((row) => `${row.status}=${row.n}`).join(" ")}`);
  assert(ledger.rows.every((row) => row.status === "DONE"), `台账里出现非 DONE 状态：${JSON.stringify(ledger.rows)}`);

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
