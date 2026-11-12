import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { writeSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { getModbusProfile } from "../apps/iot-service/dist/device-binding.js";

/**
 * 现场硬件协议端到端冒烟：台账接入目录 → Modbus TCP 建档校验 → 现场网关把指令写到线圈
 * → 假从站的反馈与计量把指令推到 DONE → 回执落库并中继成事件。
 *
 * 覆盖 `#111`（Modbus 编解码与客户端）、`#112`（迁移 038 的协议/绑定列与 CHECK）、
 * `#113`（设备待执行队列）、`#114`（现场网关）、`#115`（配置弹窗所依据的接入目录）在真实进程、
 * 真实 TCP 与真实库上的组合。单元测试里网关用的是注入的假客户端，报文帧、socket、长连接与
 * 「主站问、从站答」的时序都验不到；这里用一个独立实现的假从站（不共用平台侧编解码）补上。
 *
 * 假从站只做协议应答，不做水力模拟：线圈合着期间每被问一次累计量就流 `FLOW_PER_READ_M3`，
 * 让一轮回执在两三次轮询内收口；回执里的用水量则直接与从站自己的读数差对齐，脚本不再算一遍。
 *
 * 需要 PostgreSQL 与迁移 031（回执列）、033（`control_outbox`）、038（协议与绑定列）。
 * 使用独立端口与地块/设备编号，结束时清理自建数据。
 */

const root = process.cwd();
const DB = process.env.DB_URL ?? "postgresql://agri:agri@127.0.0.1:5432/agri";
const CTRL = 3651;
const IOT = 3652;
const SLAVE_PORT = 3653;
const PLOT = "P-SMOKE-PROTOCOL";
const FIELD_DEVICE_NO = "DZ-SMOKE-PROTOCOL-PUMP";
const CALLBACK_DEVICE_NO = "DZ-SMOKE-PROTOCOL-CB";
const DEFAULTS_DEVICE_NO = "DZ-SMOKE-PROTOCOL-DEFAULTS";
/** 网关轮询间隔的下限就是 500ms，冒烟按最快节奏跑 */
const TICK_MS = 500;
/** 假从站每被读一次累计量流过的立方米数：现场一次轮询远不到，冒烟要的是闭环不是水力 */
const FLOW_PER_READ_M3 = 0.04;
/** 假从站的出厂累计读数（立方米）：网关若把读数当用量报，就会报出这个量级 */
const CUMULATIVE_START_M3 = 50;
/** 故意选小到「一次计量即达成」的计划参数，收口条件仍由控制侧现算，脚本不抄公式 */
const ZONE = { areaMu: 0.1, targetMm: 0.1 };
const FLOW_M3H = 100;
const MANUAL_HEADERS = { "x-user-id": "smoke-protocol", "x-confirm-action": "CONFIRM" };

function say(msg) {
  writeSync(1, `[smoke:device-protocol] ${msg}\n`);
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

async function request(url, method = "GET", body, headers = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const envelope = await response.json().catch(() => null);
  return { status: response.status, ...(envelope ?? {}) };
}

const iot = (p) => `http://127.0.0.1:${IOT}/api/v1${p}`;
const ctrl = (p) => `http://127.0.0.1:${CTRL}/api/v1${p}`;

/* ------------------------------------------------------------------ 假 Modbus 从站 */

/**
 * 独立实现的最小从站：只认 FC05 写线圈、FC02 读离散输入、FC03 读保持寄存器。
 *
 * 不复用 `apps/iot-service/dist/modbus-tcp.js` 的编解码——自己按 MBAP/PDU 布局组帧，
 * 才能发现平台侧组包与真设备的期望不一致；点位地址与字序则取自服务端剖面表，
 * 免得冒烟自己抄一份点位表和网关各说各话。
 */
function createFieldSlave(profileKey) {
  const profile = getModbusProfile(profileKey);
  const meter = profile.meter;
  assert(meter, `剖面 ${profileKey} 没有累计计量，假从站无法核对作业量`);
  const scale = meter.scale;
  // 一次计量对应的寄存器计数：由剖面的倍率现算，不在脚本里写死计数值
  const stepCounts = Math.round(FLOW_PER_READ_M3 / scale);
  const state = {
    writes: [],
    reads: [],
    requests: [],
    /** 启停线圈当前值；运行反馈跟着它走，等于「泵真的转了才给反馈」 */
    coilOn: false,
    faulted: false,
    counts: Math.round(CUMULATIVE_START_M3 / scale),
    connections: 0,
    unitIds: new Set(),
  };

  const sockets = new Set();
  const server = net.createServer((socket) => {
    state.connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        // MBAP：事务 2 + 协议 2 + 长度 2 + 单元 1，长度字段覆盖单元标识之后的全部字节
        if (buffer.length < 7) return;
        const length = buffer.readUInt16BE(4);
        if (buffer.length < 6 + length) return;
        const frame = buffer.subarray(0, 6 + length);
        buffer = buffer.subarray(6 + length);
        const transactionId = frame.readUInt16BE(0);
        const unitId = frame.readUInt8(6);
        const reply = respond(frame.subarray(7), unitId);
        if (reply) socket.write(encodeFrame(transactionId, unitId, reply));
      }
    });
    socket.on("error", () => undefined);
  });

  function encodeFrame(transactionId, unitId, pdu) {
    const frame = Buffer.alloc(7 + pdu.length);
    frame.writeUInt16BE(transactionId, 0);
    frame.writeUInt16BE(0, 2);
    frame.writeUInt16BE(pdu.length + 1, 4);
    frame.writeUInt8(unitId, 6);
    pdu.copy(frame, 7);
    return frame;
  }

  function exception(functionCode, exceptionCode) {
    const pdu = Buffer.alloc(2);
    pdu.writeUInt8(functionCode | 0x80, 0);
    pdu.writeUInt8(exceptionCode, 1);
    return pdu;
  }

  function respond(pdu, unitId) {
    const functionCode = pdu.readUInt8(0);
    state.requests.push(functionCode);
    state.unitIds.add(unitId);

    if (functionCode === 0x05) {
      const address = pdu.readUInt16BE(1);
      const value = pdu.readUInt16BE(3);
      if (value !== 0xff00 && value !== 0x0000) return exception(functionCode, 0x03);
      if (address !== profile.switchCoil) return exception(functionCode, 0x02);
      state.coilOn = value === 0xff00;
      state.writes.push({ address, on: state.coilOn });
      const echo = Buffer.alloc(5);
      echo.writeUInt8(functionCode, 0);
      echo.writeUInt16BE(address, 1);
      echo.writeUInt16BE(value, 3);
      return echo;
    }

    if (functionCode === 0x02) {
      const address = pdu.readUInt16BE(1);
      const quantity = pdu.readUInt16BE(3);
      const bits = Array.from({ length: quantity }, (_, index) => {
        const at = address + index;
        // 故障输入是端子信号，与线圈无关；运行反馈跟线圈走，等价于「设备真的动了」
        if (at === profile.faultInput) return state.faulted;
        if (at === profile.runFeedbackInput) return state.coilOn;
        return false;
      });
      const byteCount = Math.ceil(quantity / 8);
      const response = Buffer.alloc(2 + byteCount);
      response.writeUInt8(functionCode, 0);
      response.writeUInt8(byteCount, 1);
      bits.forEach((bit, index) => {
        if (!bit) return;
        const byte = 2 + Math.floor(index / 8);
        response.writeUInt8(response[byte] | (1 << (index % 8)), byte);
      });
      return response;
    }

    if (functionCode === 0x03) {
      const address = pdu.readUInt16BE(1);
      const quantity = pdu.readUInt16BE(3);
      if (address !== meter.register || quantity !== 2) return exception(functionCode, 0x02);
      const counts = state.counts;
      state.reads.push(counts);
      // 线圈合着才算在流水：关阀后复读拿到的就是本轮最终用量
      if (state.coilOn) state.counts += stepCounts;
      const high = Math.floor(counts / 0x10000);
      const low = counts % 0x10000;
      const words = meter.wordOrder === "HIGH_FIRST" ? [high, low] : [low, high];
      const response = Buffer.alloc(2 + words.length * 2);
      response.writeUInt8(functionCode, 0);
      response.writeUInt8(words.length * 2, 1);
      words.forEach((word, index) => response.writeUInt16BE(word, 2 + index * 2));
      return response;
    }

    return exception(functionCode, 0x01);
  }

  return {
    state,
    profile,
    stepCounts,
    scale,
    /** 本条指令之后新写入的线圈，用于核对「开一次就必须关一次」 */
    writesSince: (mark) => state.writes.slice(mark),
    mark: () => state.writes.length,
    listen: () => new Promise((resolve) => server.listen(SLAVE_PORT, "127.0.0.1", resolve)),
    /** 网关是长连接：先停止接听，再掐断在用的 socket，否则 close 回调永远不来，脚本收尾挂死 */
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}

/* ------------------------------------------------------------------ 查询助手 */

let client = null;

async function waitRows(sql, params, predicate, label, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    latest = (await client.query(sql, params)).rows;
    if (predicate(latest)) return latest;
    await delay(400);
  }
  throw new Error(`等待${label}超时，当前数据：${JSON.stringify(latest)}`);
}

/** 按指令 id 轮询控制侧视图，直到状态进入预期（网关每轮推一步，不该靠固定等待） */
async function waitCommand(id, expected, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const page = await request(ctrl(`/control/commands?plotCode=${encodeURIComponent(PLOT)}&size=100`));
    latest = (page.data?.items ?? []).find((item) => item.id === id) ?? null;
    if (latest && expected.includes(latest.status)) return latest;
    await delay(400);
  }
  throw new Error(`等待指令进入 ${expected.join("/")} 超时，当前：${JSON.stringify(latest)}`);
}

async function command(id) {
  const page = await request(ctrl(`/control/commands?plotCode=${encodeURIComponent(PLOT)}&size=100`));
  return (page.data?.items ?? []).find((item) => item.id === id) ?? null;
}

const deviceNos = [FIELD_DEVICE_NO, CALLBACK_DEVICE_NO, DEFAULTS_DEVICE_NO];

async function cleanData() {
  if (!client) return;
  try {
    await client.query("DELETE FROM control_commands WHERE plot_code = $1", [PLOT]);
    await client.query("DELETE FROM control_outbox WHERE payload_json->>'parcelId' = $1", [PLOT]);
    await client.query("DELETE FROM event_log WHERE payload_json->>'parcelId' = $1", [PLOT]);
    for (const deviceNo of deviceNos) await client.query("DELETE FROM devices WHERE device_no = $1", [deviceNo]);
  } catch (error) {
    say(`清理告警：${error.message}`);
  }
}

/** 下发一条人工指令并返回它的当前视图 */
async function sendCommand(body) {
  const created = await request(ctrl("/control/commands"), "POST", { plotCode: PLOT, ...body }, MANUAL_HEADERS);
  assert(created.status === 202, `指令下发异常：${created.status} ${JSON.stringify(created)}`);
  return created.data;
}

/* ------------------------------------------------------------------ 主流程 */

let slave = null;

try {
  // ---------- ⓪ 起服务：接入目录、建档校验与网关都由这两个进程回答，目录必须先能问出来 ----------
  start("control", "apps/control-service/dist/main.js", {
    PORT: String(CTRL),
    CONTROL_POLL_INTERVAL_MS: "500",
    CONTROL_OUTBOX_RELAY_INTERVAL_MS: "500",
  });
  start("iot", "apps/iot-service/dist/main.js", {
    PORT: String(IOT),
    FIELD_GATEWAY_ENABLED: "1",
    FIELD_GATEWAY_INTERVAL_MS: String(TICK_MS),
    CONTROL_SERVICE_URL: `http://127.0.0.1:${CTRL}`,
  });
  await waitHealth(CTRL, "control");
  await waitHealth(IOT, "iot");
  say("control + iot (field gateway) healthy");

  client = new Client({ connectionString: DB });
  await client.connect();
  await cleanData();

  // ---------- ① 接入目录：表单与建档校验共用的那份协议/剖面/缺省值 ----------
  const catalogueResponse = await request(iot("/devices/field-access"));
  assert(catalogueResponse.status === 200, `现场接入目录接口异常：${catalogueResponse.status}`);
  const catalogue = catalogueResponse.data;
  assert(Array.isArray(catalogue?.protocols) && catalogue.protocols.length >= 2, `目录未给出接入协议：${JSON.stringify(catalogue?.protocols)}`);
  const fieldProtocol = catalogue.protocols.find((item) => item.requiresBinding);
  const callbackProtocol = catalogue.protocols.find((item) => !item.requiresBinding);
  assert(fieldProtocol && callbackProtocol, `目录里既没有需要绑定的协议也没有回调式协议：${JSON.stringify(catalogue.protocols)}`);
  assert(catalogue.defaultProtocol === callbackProtocol.value, `缺省协议应是回调式（存量台账不受本功能影响），实际 ${catalogue.defaultProtocol}`);
  // 选一个能配在灌溉泵站上的计量剖面：假从站与真网关都用同一份点位定义
  const metered = catalogue.profiles.filter((item) => item.applicableTypes.includes("IRRIGATION_PUMP") && item.meter?.unit === "m³");
  assert(metered.length >= 1, `目录里没有可配在灌溉泵站的立方米计量剖面：${JSON.stringify(catalogue.profiles.map((item) => item.key))}`);
  const fieldProfile = metered[0];
  const mismatched = catalogue.profiles.find((item) => !item.applicableTypes.includes("IRRIGATION_PUMP"));
  say(`catalogue protocols=${catalogue.protocols.map((item) => item.value).join("/")} profile=${fieldProfile.key} defaults=${JSON.stringify(catalogue.defaults)}`);

  slave = createFieldSlave(fieldProfile.key);
  await slave.listen();
  say(`fake modbus slave listening on 127.0.0.1:${SLAVE_PORT} (switch ${hex(slave.profile.switchCoil)}, meter ${hex(slave.profile.meter.register)})`);

  // ---------- ② 建档校验：现场协议不给绑定就建不了档，剖面与类型不匹配也拒 ----------
  const noBinding = await request(iot("/devices"), "POST", {
    deviceNo: "DZ-SMOKE-PROTOCOL-BAD",
    name: "冒烟缺绑定",
    type: "IRRIGATION_PUMP",
    protocol: fieldProtocol.value,
  });
  assert(noBinding.status === 400, `${fieldProtocol.value} 设备缺绑定仍建档成功：${noBinding.status} ${JSON.stringify(noBinding)}`);
  assert(noBinding.message.includes("绑定"), `缺绑定报错未说明要什么：${noBinding.message}`);

  const blankHost = await request(iot("/devices"), "POST", {
    deviceNo: "DZ-SMOKE-PROTOCOL-BAD",
    name: "冒烟空地址",
    type: "IRRIGATION_PUMP",
    protocol: fieldProtocol.value,
    binding: { host: " ", profile: fieldProfile.key },
  });
  assert(blankHost.status === 400, `空白接入地址仍建档成功：${blankHost.status}`);

  if (mismatched) {
    const wrongProfile = await request(iot("/devices"), "POST", {
      deviceNo: "DZ-SMOKE-PROTOCOL-BAD",
      name: "冒烟错剖面",
      type: "IRRIGATION_PUMP",
      protocol: fieldProtocol.value,
      binding: { host: "127.0.0.1", profile: mismatched.key },
    });
    assert(wrongProfile.status === 400, `剖面 ${mismatched.key} 与泵站类型不匹配仍建档成功：${wrongProfile.status}`);
    assert(wrongProfile.message.includes("不匹配"), `剖面不匹配的报错未说清：${wrongProfile.message}`);
  } else {
    say("目录里所有剖面都适用于泵站，跳过剖面不匹配用例");
  }

  // ---------- ③ 只给地址与剖面：端口、单元标识、超时都按目录缺省补齐 ----------
  const defaultsDevice = await request(iot("/devices"), "POST", {
    deviceNo: DEFAULTS_DEVICE_NO,
    name: "冒烟缺省值设备",
    type: "IRRIGATION_PUMP",
    protocol: fieldProtocol.value,
    binding: { host: "127.0.0.1", profile: fieldProfile.key },
  });
  assert(defaultsDevice.status === 201, `只给地址与剖面建档失败 ${defaultsDevice.status}：${JSON.stringify(defaultsDevice)}`);
  const defaulted = defaultsDevice.data;
  assert(defaulted.binding.port === catalogue.defaults.port, `缺省端口未按目录补齐：${defaulted.binding.port} vs ${catalogue.defaults.port}`);
  assert(defaulted.binding.unitId === catalogue.defaults.unitId, `缺省单元标识未按目录补齐：${defaulted.binding.unitId}`);
  assert(defaulted.binding.timeoutMs === catalogue.defaults.timeoutMs, `缺省超时未按目录补齐：${defaulted.binding.timeoutMs}`);
  say(`binding defaults from catalogue ${JSON.stringify(defaulted.binding)}`);

  // 协议与绑定同生同灭：改回回调式必须清掉绑定，改成现场协议必须配套给绑定
  const toCallback = await request(iot(`/devices/${defaulted.id}`), "PUT", { protocol: callbackProtocol.value });
  assert(toCallback.status === 200, `改回回调式失败 ${toCallback.status}：${JSON.stringify(toCallback)}`);
  assert(toCallback.data.binding === undefined, `改回回调式仍留着绑定：${JSON.stringify(toCallback.data)}`);
  const callbackWithBinding = await request(iot(`/devices/${defaulted.id}`), "PUT", { protocol: callbackProtocol.value, binding: { host: "127.0.0.1", profile: fieldProfile.key } });
  assert(callbackWithBinding.status === 400, `回调式设备仍接受现场绑定：${callbackWithBinding.status}`);
  const backToField = await request(iot(`/devices/${defaulted.id}`), "PUT", { protocol: fieldProtocol.value });
  assert(backToField.status === 400, `改成 ${fieldProtocol.value} 未给绑定仍放行：${backToField.status}`);
  say("protocol/binding 同生同灭：改回调清绑定、改现场必给绑定");

  // ---------- ④ 现场设备建档 + 网关把灌溉指令推到 DONE ----------
  const created = await request(iot("/devices"), "POST", {
    deviceNo: FIELD_DEVICE_NO,
    name: "冒烟现场泵站",
    type: "IRRIGATION_PUMP",
    protocol: fieldProtocol.value,
    binding: { host: "127.0.0.1", port: SLAVE_PORT, profile: fieldProfile.key },
  });
  assert(created.status === 201, `现场设备建档失败 ${created.status}：${JSON.stringify(created)}`);
  const device = created.data;
  assert(device.binding.host === "127.0.0.1" && device.binding.port === SLAVE_PORT, `台账未记住接入地址：${JSON.stringify(device.binding)}`);

  // 收口条件由控制侧按分区参数现算，脚本只核对它够小、能在一次计量内达成
  const planResponse = await request(ctrl("/control/irrigation-plans"), "POST", { zones: [ZONE], flowM3h: FLOW_M3H }, MANUAL_HEADERS);
  assert(planResponse.status === 200 || planResponse.status === 201, `方案预演异常：${planResponse.status} ${JSON.stringify(planResponse)}`);
  const targetVolume = planResponse.data.totalWaterVolume;
  assert(targetVolume > 0 && targetVolume < FLOW_PER_READ_M3, `计划用水量 ${targetVolume} 不在一次计量 ${FLOW_PER_READ_M3} 之内，收口会拖轮次`);

  const writesBeforeIrrigation = slave.mark();
  const irrigation = await sendCommand({ deviceId: device.id, type: "IRRIGATION", reason: "现场协议冒烟：灌溉", parameters: { zones: [ZONE], flowM3h: FLOW_M3H } });
  assert(irrigation.parameters?.plan?.totalWaterVolume === targetVolume, `入队未带上现算的执行包络：${JSON.stringify(irrigation.parameters?.plan)}`);
  const done = await waitCommand(irrigation.id, ["DONE", "FAILED"]);
  assert(done.status === "DONE", `灌溉指令未正常结单：${done.status} ${done.receiptMessage ?? ""}`);
  const irrigationWrites = slave.writesSince(writesBeforeIrrigation);
  assert(slave.state.unitIds.has(device.binding.unitId), `从站没收到单元标识 ${device.binding.unitId} 的报文：${JSON.stringify([...slave.state.unitIds])}`);
  assert(
    JSON.stringify(irrigationWrites) === JSON.stringify([{ address: slave.profile.switchCoil, on: true }, { address: slave.profile.switchCoil, on: false }]),
    `线圈写入次数或顺序异常（应开一次、关一次）：${JSON.stringify(irrigationWrites)}`,
  );
  say("gateway drove QUEUED → SENT → ACKED → DONE over real Modbus TCP");

  // 用量口径：报的是作业期间的增量，而且必须等于从站寄存器自己记下的读数差
  const result = done.result;
  assert(result && typeof result.waterVolumeM3 === "number" && result.waterVolumeM3 > 0, `结单未上报实测用水量：${JSON.stringify(result)}`);
  const readings = slave.state.reads;
  assert(readings.length >= 2, `网关至少该读一次基线、一次收口，实际 ${readings.length} 次`);
  // 假从站每被读一次就流 FLOW_PER_READ_M3，读数差就是这轮真实流过的水——拿它对齐回执，脚本不另算一份
  const meteredM3 = (Math.max(...readings) - Math.min(...readings)) * slave.scale;
  assert(result.waterVolumeM3 === Number(meteredM3.toFixed(3)), `回执用水量与从站读数差不符：${result.waterVolumeM3} vs 表计增量 ${meteredM3}`);
  assert(result.waterVolumeM3 >= targetVolume, `计划水量未达成就结单：实测 ${result.waterVolumeM3} < 计划 ${targetVolume}`);
  assert(result.waterVolumeM3 < CUMULATIVE_START_M3, `上报的像是从站累计读数而不是本轮增量：${result.waterVolumeM3}`);

  const receiptColumns = (await waitRows(
    "SELECT sent_at, acked_at, finished_at, result_json, receipt_message FROM control_commands WHERE id = $1",
    [irrigation.id],
    (rows) => rows.length === 1 && rows[0].finished_at !== null,
    "灌溉指令的回执时间列",
  ))[0];
  assert(receiptColumns.sent_at && receiptColumns.acked_at && receiptColumns.finished_at, `在途时间列未落库：${JSON.stringify(receiptColumns)}`);
  assert(Number(receiptColumns.result_json.waterVolumeM3) === result.waterVolumeM3, `接口视图与库内结果快照不一致：${JSON.stringify(receiptColumns.result_json)}`);

  const finishedRow = (await waitRows(
    "SELECT topic, payload_json FROM control_outbox WHERE trace_id = $1",
    [`control-finished:${irrigation.id}`],
    (rows) => rows.length === 1,
    "结单事件中继",
  ))[0];
  assert(finishedRow.topic === "control.irrigation.finished", `结单事件主题异常：${finishedRow.topic}`);
  assert(finishedRow.payload_json.waterVolumeSource === "DEVICE", `网关实测的用水量必须标 DEVICE：${JSON.stringify(finishedRow.payload_json)}`);
  assert(Number(finishedRow.payload_json.waterVolume) === result.waterVolumeM3, `事件用水量与回执不一致：${JSON.stringify(finishedRow.payload_json)}`);
  await waitRows("SELECT seq FROM event_log WHERE trace_id = $1", [`control-finished:${irrigation.id}`], (rows) => rows.length === 1, "结单事件进入共享事件日志");
  say(`irrigation closed with 实测 ${result.waterVolumeM3} m³（增量，非累计读数）并中继成事件`);

  // ---------- ⑤ 算不出收口条件：不领取、不碰硬件，直接失败 ----------
  const writesBeforeBlind = slave.mark();
  const blind = await sendCommand({ deviceId: device.id, type: "SEEDING", reason: "现场协议冒烟：无包络", parameters: {} });
  const blindDone = await waitCommand(blind.id, ["FAILED"]);
  assert(blindDone.receiptMessage?.includes("作业时长") === true, `无包络指令的失败原因未说清：${blindDone.receiptMessage}`);
  assert(slave.writesSince(writesBeforeBlind).length === 0, `算不出开多久的指令仍然动了硬件：${JSON.stringify(slave.writesSince(writesBeforeBlind))}`);
  say("command without envelope failed before touching hardware");

  // ---------- ⑥ 急停：写停线圈，运行反馈消失才结单 ----------
  const writesBeforeEstop = slave.mark();
  const estop = await sendCommand({ deviceId: device.id, type: "ESTOP", reason: "现场协议冒烟：急停" });
  const estopDone = await waitCommand(estop.id, ["DONE", "FAILED"]);
  assert(estopDone.status === "DONE", `急停未靠运行反馈结单：${estopDone.status} ${estopDone.receiptMessage ?? ""}`);
  assert(slave.state.coilOn === false, "急停后从站线圈仍停在合位");
  const estopWrites = slave.writesSince(writesBeforeEstop);
  assert(estopWrites.every((write) => write.on === false), `急停不该合上任何线圈：${JSON.stringify(estopWrites)}`);
  await delay(1200);
  const estopEvents = (await client.query("SELECT count(*)::int AS n FROM control_outbox WHERE payload_json->>'commandId' = $1", [estop.id])).rows[0].n;
  assert(estopEvents === 0, `急停没有可核对的作业量，不该发结单事件：${estopEvents} 条`);
  say("ESTOP closed on feedback disappearance, no finished event");

  // ---------- ⑦ 故障输入：接单即失败，且把线圈收回位 ----------
  slave.state.faulted = true;
  const writesBeforeFault = slave.mark();
  const faulted = await sendCommand({ deviceId: device.id, type: "IRRIGATION", reason: "现场协议冒烟：故障", parameters: { zones: [ZONE], flowM3h: FLOW_M3H } });
  const faultedDone = await waitCommand(faulted.id, ["FAILED"]);
  const faultWrites = slave.writesSince(writesBeforeFault);
  assert(faultedDone.receiptMessage?.includes("故障") === true, `失败原因未提到故障输入：${faultedDone.receiptMessage}`);
  assert(faultWrites.at(-1)?.on === false, `故障后未把线圈收回位，现场会留一个挂在打开位的阀门：${JSON.stringify(faultWrites)}`);
  slave.state.faulted = false;
  say("fault input → FAILED with coil backed off");

  // ---------- ⑧ 回调式设备不归网关管 ----------
  const callbackDevice = await request(iot("/devices"), "POST", {
    deviceNo: CALLBACK_DEVICE_NO,
    name: "冒烟回调设备",
    type: "IRRIGATION_PUMP",
    protocol: callbackProtocol.value,
  });
  assert(callbackDevice.status === 201, `回调式设备建档失败 ${callbackDevice.status}：${JSON.stringify(callbackDevice)}`);
  assert(callbackDevice.data.binding === undefined, `回调式设备不该带绑定：${JSON.stringify(callbackDevice.data)}`);
  const writesBeforeCallback = slave.mark();
  const callbackCommand = await sendCommand({ deviceId: callbackDevice.data.id, type: "SEEDING", reason: "现场协议冒烟：回调设备", parameters: {} });
  await delay(TICK_MS * 4);
  const stillQueued = await command(callbackCommand.id);
  assert(stillQueued?.status === "QUEUED", `网关去领了回调式设备的指令：${JSON.stringify(stillQueued)}`);
  assert(slave.writesSince(writesBeforeCallback).length === 0, "回调式设备的指令动了现场硬件");
  say("callback-protocol device left alone by the field gateway");

  const ledger = await client.query(
    "SELECT status, count(*)::int AS n FROM control_commands WHERE plot_code = $1 GROUP BY status ORDER BY status",
    [PLOT],
  );
  say(`ledger ${ledger.rows.map((row) => `${row.status}=${row.n}`).join(" ")}`);
  // 除回调设备那条本来就该躺在队列里等它自己认领的指令，其余都必须由这条链路收口
  const inFlight = await client.query("SELECT id, device_id, type FROM control_commands WHERE plot_code = $1 AND status NOT IN ('DONE', 'FAILED')", [PLOT]);
  assert(
    inFlight.rows.length === 1 && inFlight.rows[0].device_id === callbackDevice.data.id,
    `除回调设备的队列指令外还有指令没收口：${JSON.stringify(inFlight.rows)}`,
  );

  say("SMOKE PASS");
} catch (error) {
  say(`SMOKE FAIL: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
} finally {
  await cleanData();
  // 先收服务进程：网关只要还在轮询就会不断重连从站，后面关端口只会留一串拒绝
  for (const child of children) child.kill();
  await delay(800);
  if (slave) {
    await slave.close().catch(() => undefined);
    slave = null;
  }
  if (client) {
    await client.end().catch(() => undefined);
    client = null;
  }
}

function hex(value) {
  return `0x${value.toString(16).toUpperCase().padStart(4, "0")}`;
}
