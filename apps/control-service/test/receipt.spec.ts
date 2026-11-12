import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";

import { PgClientAdapter } from "@agri/db";

import { createControlHttpServer } from "../src/http.js";
import { InMemoryControlCommandRepository, SqlControlCommandRepository, canTransition, pendingMinutesOf } from "../src/control.repository.js";
import type { ControlCommand } from "../src/control.repository.js";

/**
 * 控制指令回执状态机验证：跃迁表、版本乐观锁、设备通道的下发确认与执行回执、
 * 急停到位确认，以及超时未回执的在途口径。
 *
 * 迁移 031 的 SQL 侧只在 DB_URL 存在时跑，与其余服务的真实库冒烟同一约定。
 */

const servers: Server[] = [];

/** 测试用租户；接口侧不带可信身份头会落到进程默认租户，这里显式写死避免受环境影响 */
const TENANT = "tenant-demo";

async function start(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))),
  );
});

function command(overrides: Partial<ControlCommand> = {}): ControlCommand {
  return {
    id: "cmd-1",
    tenantId: TENANT,
    deviceId: "device-fert-001",
    plotCode: "P-1",
    operatorId: "user-admin",
    type: "IRRIGATION",
    parameters: { zones: [{ zoneCode: "ZONE-01", areaMu: 10, targetMm: 20 }] },
    status: "QUEUED",
    origin: "MANUAL",
    reason: "土壤含水率低于下限",
    version: 1,
    createdAt: "2026-11-12T00:00:00.000Z",
    ...overrides,
  };
}

async function postJson(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tenant-id": TENANT, ...headers },
    body: JSON.stringify(body),
  });
}

/** 列表查询同样带可信租户头，否则跨租户隔离的用例要依赖进程环境变量 */
function getJson(base: string, path: string, headers: Record<string, string> = { "x-tenant-id": TENANT }): Promise<Response> {
  return fetch(`${base}${path}`, { headers });
}

const CONFIRM = { "x-user-id": "user-admin", "x-confirm-action": "CONFIRM" };

async function dataOf(response: Response): Promise<any> {
  return (await response.json() as { data: any }).data;
}

describe("指令生命周期跃迁表", () => {
  it("只允许沿 入队→下发→接收→到位 推进，任一在途状态可失败收口", () => {
    expect(canTransition("QUEUED", "SENT")).toBe(true);
    expect(canTransition("SENT", "ACKED")).toBe(true);
    // 设备跳过「已接收」直接报完成是常见报文，不能因此卡住结单
    expect(canTransition("SENT", "DONE")).toBe(true);
    expect(canTransition("ACKED", "DONE")).toBe(true);
    for (const from of ["QUEUED", "SENT", "ACKED"] as const) expect(canTransition(from, "FAILED")).toBe(true);

    expect(canTransition("QUEUED", "ACKED")).toBe(false);
    expect(canTransition("QUEUED", "DONE")).toBe(false);
    expect(canTransition("ACKED", "SENT")).toBe(false);
    // 结单后不再翻案：DONE/FAILED 是终态
    expect(canTransition("DONE", "FAILED")).toBe(false);
    expect(canTransition("FAILED", "SENT")).toBe(false);
    // 同一状态不在跃迁表内，重复回执由接口层按幂等返回现有记录
    expect(canTransition("SENT", "SENT")).toBe(false);
  });
});

describe("指令仓储跃迁", () => {
  it("推进版本、按状态写回时间并保存结果快照；陈旧版本与非法跃迁不写入", async () => {
    const repository = new InMemoryControlCommandRepository([command()]);

    const sent = await repository.transition(TENANT, { id: "cmd-1", status: "SENT", at: "2026-11-12T00:01:00.000Z", version: 1 });
    expect(sent).toMatchObject({ status: "SENT", version: 2, sentAt: "2026-11-12T00:01:00.000Z" });
    expect(sent?.ackedAt).toBeUndefined();
    expect(sent?.finishedAt).toBeUndefined();

    // 网关与人工同时回填：拿着已消费的版本再推一次不生效
    expect(await repository.transition(TENANT, { id: "cmd-1", status: "ACKED", at: "2026-11-12T00:02:00.000Z", version: 1 })).toBeNull();

    const done = await repository.transition(TENANT, {
      id: "cmd-1",
      status: "DONE",
      at: "2026-11-12T00:05:00.000Z",
      version: 2,
      message: "灌完 18 方",
      result: { waterVolumeM3: 18 },
    });
    expect(done).toMatchObject({ status: "DONE", version: 3, finishedAt: "2026-11-12T00:05:00.000Z", receiptMessage: "灌完 18 方" });
    expect(done?.result).toEqual({ waterVolumeM3: 18 });
    expect((await repository.find(TENANT, "cmd-1"))?.status).toBe("DONE");
    // 终态之后的任何跃迁都被拒
    expect(await repository.transition(TENANT, { id: "cmd-1", status: "FAILED", at: "2026-11-12T00:06:00.000Z", version: 3 })).toBeNull();
  });

  it("在途时长从最后一次状态推进时间起算，终态不参与超时", () => {
    const now = Date.parse("2026-11-12T01:00:00.000Z");
    expect(pendingMinutesOf(command({ createdAt: "2026-11-12T00:40:00.000Z" }), now)).toBe(20);
    expect(
      pendingMinutesOf(command({ status: "SENT", sentAt: "2026-11-12T00:55:00.000Z", createdAt: "2026-11-12T00:00:00.000Z" }), now),
    ).toBe(5);
    expect(
      pendingMinutesOf(command({ status: "ACKED", sentAt: "2026-11-12T00:01:00.000Z", ackedAt: "2026-11-12T00:59:00.000Z" }), now),
    ).toBe(1);
    expect(pendingMinutesOf(command({ status: "DONE", finishedAt: "2026-11-12T00:30:00.000Z" }), now)).toBeUndefined();
  });

  it("跨租户的指令 id 一律当作不存在：查不到、跃不动、列表也不串", async () => {
    const repository = new InMemoryControlCommandRepository([command(), command({ id: "cmd-2", tenantId: "tenant-other" })]);

    expect(await repository.find(TENANT, "cmd-2")).toBeNull();
    expect(await repository.find("tenant-other", "cmd-1")).toBeNull();
    expect(await repository.transition(TENANT, { id: "cmd-2", status: "SENT", at: "2026-11-12T00:01:00.000Z", version: 1 })).toBeNull();
    expect((await repository.page(TENANT, { page: 1, size: 20 })).items.map((item) => item.id)).toEqual(["cmd-1"]);
    expect((await repository.page("tenant-other", { page: 1, size: 20 })).items.map((item) => item.id)).toEqual(["cmd-2"]);
  });
});

describe("设备通道：下发确认与执行回执", () => {
  it("走完整链路到执行到位，非法跃迁 409、重复下发幂等、结单后不再改", async () => {
    const base = await start(createControlHttpServer(new InMemoryControlCommandRepository(), { receiptTimeoutMin: 15 }));

    const created = await dataOf(
      await postJson(base, "/api/v1/control/commands", { deviceId: "device-fert-001", plotCode: "P-1", type: "IRRIGATION", parameters: {} }, CONFIRM),
    );
    expect(created).toMatchObject({ status: "QUEUED", version: 1, overdue: false });
    expect(created.pendingMin).toBe(0);

    // 还没下发就报执行到位
    const early = await postJson(base, "/api/v1/control/device/receipt", { commandId: created.id, status: "DONE" });
    expect(early.status).toBe(409);
    expect((await early.json() as { message: string }).message).toContain("QUEUED");

    const dispatched = await dataOf(await postJson(base, "/api/v1/control/device/dispatch", { commandId: created.id }));
    expect(dispatched).toMatchObject({ status: "SENT", version: 2 });
    expect(dispatched.sentAt).toBeTruthy();

    // 网关重试领取：幂等返回当前记录，版本不再推高
    const retried = await dataOf(await postJson(base, "/api/v1/control/device/dispatch", { commandId: created.id }));
    expect(retried).toMatchObject({ status: "SENT", version: 2 });

    const acked = await dataOf(await postJson(base, "/api/v1/control/device/receipt", { commandId: created.id, status: "ACKED", message: "设备已接收" }));
    expect(acked).toMatchObject({ status: "ACKED", version: 3, receiptMessage: "设备已接收" });
    expect(acked.ackedAt).toBeTruthy();

    const done = await dataOf(
      await postJson(base, "/api/v1/control/device/receipt", { commandId: created.id, status: "DONE", message: "按方案灌完", result: { waterVolumeM3: 18 } }),
    );
    expect(done).toMatchObject({ status: "DONE", version: 4, receiptMessage: "按方案灌完" });
    expect(done.result).toEqual({ waterVolumeM3: 18 });
    expect(done.pendingMin).toBeUndefined();
    expect(done.overdue).toBe(false);

    const closed = await postJson(base, "/api/v1/control/device/receipt", { commandId: created.id, status: "FAILED", message: "补报故障" });
    expect(closed.status).toBe(409);

    const list = await dataOf(await getJson(base, "/api/v1/control/commands"));
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ id: created.id, status: "DONE", version: 4 });
  });

  it("指令归属只认可信租户头，请求体自报的 tenantId 不生效", async () => {
    const base = await start(createControlHttpServer());

    const created = await dataOf(
      await postJson(
        base,
        "/api/v1/control/commands",
        { deviceId: "device-fert-001", type: "IRRIGATION", parameters: {}, tenantId: "tenant-intruder" },
        { ...CONFIRM, "x-tenant-id": "tenant-a" },
      ),
    );
    expect(created.tenantId).toBe("tenant-a");

    // 换租户查列表与下发都当作不存在
    expect((await dataOf(await getJson(base, "/api/v1/control/commands", { "x-tenant-id": "tenant-b" }))).total).toBe(0);
    expect((await dataOf(await getJson(base, "/api/v1/control/commands", { "x-tenant-id": "tenant-a" }))).total).toBe(1);
    expect((await postJson(base, "/api/v1/control/device/dispatch", { commandId: created.id }, { "x-tenant-id": "tenant-b" })).status).toBe(404);
    expect((await postJson(base, "/api/v1/control/device/dispatch", { commandId: created.id }, { "x-tenant-id": "tenant-a" })).status).toBe(200);
  });

  it("报文校验：未知指令 404，SENT 不是回执状态，FAILED 必须带原因，at 必须可解析", async () => {
    const base = await start(createControlHttpServer());

    const missing = await postJson(base, "/api/v1/control/device/dispatch", { commandId: "cmd-none" });
    expect(missing.status).toBe(404);
    expect((await missing.json() as { message: string }).message).toContain("不存在");

    const created = await dataOf(
      await postJson(base, "/api/v1/control/commands", { deviceId: "device-fert-001", type: "IRRIGATION", parameters: {} }, CONFIRM),
    );

    // SENT 由 dispatch 负责，回执接口不接受，避免两条通道互相覆盖
    const wrongStatus = await postJson(base, "/api/v1/control/device/receipt", { commandId: created.id, status: "SENT" });
    expect(wrongStatus.status).toBe(400);
    expect((await wrongStatus.json() as { message: string }).message).toContain("dispatch");

    const noReason = await postJson(base, "/api/v1/control/device/receipt", { commandId: created.id, status: "FAILED" });
    expect(noReason.status).toBe(400);
    expect((await noReason.json() as { message: string }).message).toContain("失败原因");

    // 以下三条都在 probe ACKED 回执，先把指令推到 SENT：QUEUED → ACKED 本就非法，
    // 否则「报文不合法」会被状态机的 409 盖掉
    expect((await postJson(base, "/api/v1/control/device/dispatch", { commandId: created.id })).status).toBe(200);

    const badTime = await postJson(base, "/api/v1/control/device/receipt", { commandId: created.id, status: "ACKED", at: "昨天下午" });
    expect(badTime.status).toBe(400);
    expect((await badTime.json() as { message: string }).message).toContain("at");

    const badResult = await postJson(base, "/api/v1/control/device/receipt", { commandId: created.id, status: "ACKED", result: [1, 2] });
    expect(badResult.status).toBe(400);

    expect((await dataOf(await postJson(base, "/api/v1/control/device/receipt", { commandId: created.id, status: "ACKED" }))).status).toBe("ACKED");
  });

  it("回执时刻不许倒流：早于上一次状态推进一律 400，指令留在原状态", async () => {
    const base = await start(createControlHttpServer());
    const created = await dataOf(
      await postJson(base, "/api/v1/control/commands", { deviceId: "device-fert-009", type: "IRRIGATION", parameters: {} }, CONFIRM),
    );
    // 下发时刻固定为 08:00，后续回执时刻都相对它构造，两套仓储走同一条入口校验
    expect(
      (await postJson(base, "/api/v1/control/device/dispatch", { commandId: created.id, at: "2026-11-12T08:00:00.000Z" })).status,
    ).toBe(200);

    const earlyAck = await postJson(base, "/api/v1/control/device/receipt", { commandId: created.id, status: "ACKED", at: "2026-11-12T07:59:00.000Z", message: "补报接收" });
    expect(earlyAck.status).toBe(400);
    expect((await earlyAck.json() as { message: string }).message).toContain("早于下发时刻");

    // 倒流的接收回执被拒后指令仍停在 SENT，不能被写成半截生命周期
    const listed = await dataOf(await getJson(base, "/api/v1/control/commands?deviceId=device-fert-009"));
    expect(listed.items.find((item: { id: string }) => item.id === created.id)).toMatchObject({ status: "SENT", sentAt: "2026-11-12T08:00:00.000Z" });

    const earlyDone = await postJson(base, "/api/v1/control/device/receipt", { commandId: created.id, status: "FAILED", at: "2026-11-12T07:30:00.000Z", message: "补报故障" });
    expect(earlyDone.status).toBe(400);
    expect((await earlyDone.json() as { message: string }).message).toContain("早于上一次状态推进");

    expect((await dataOf(await postJson(base, "/api/v1/control/device/receipt", { commandId: created.id, status: "ACKED", at: "2026-11-12T08:01:00.000Z", message: "设备已接收" }))).status).toBe("ACKED");
    const done = await dataOf(
      await postJson(base, "/api/v1/control/device/receipt", { commandId: created.id, status: "DONE", at: "2026-11-12T08:05:00.000Z", message: "按方案灌完", result: { waterVolumeM3: 12 } }),
    );
    expect(done).toMatchObject({ status: "DONE", ackedAt: "2026-11-12T08:01:00.000Z", finishedAt: "2026-11-12T08:05:00.000Z" });
  });

  it("急停指令的执行到位必须带到位确认，勾上确认后才结单", async () => {
    const base = await start(createControlHttpServer());
    const created = await dataOf(
      await postJson(base, "/api/v1/control/commands", { deviceId: "device-fert-001", type: "ESTOP", reason: "人员进入作业区" }, CONFIRM),
    );
    expect(created.type).toBe("ESTOP");
    await postJson(base, "/api/v1/control/device/dispatch", { commandId: created.id });

    const unconfirmed = await postJson(base, "/api/v1/control/device/receipt", { commandId: created.id, status: "DONE", message: "已停" });
    expect(unconfirmed.status).toBe(400);
    expect((await unconfirmed.json() as { message: string }).message).toContain("到位确认");

    const confirmed = await dataOf(
      await postJson(base, "/api/v1/control/device/receipt", { commandId: created.id, status: "DONE", message: "主机停机到位", result: { confirmed: true } }),
    );
    expect(confirmed).toMatchObject({ status: "DONE", receiptMessage: "主机停机到位" });
    expect(confirmed.result).toEqual({ confirmed: true });

    // 失败收口不需要到位确认：停不下来也要能如实记一笔
    const stop = await dataOf(
      await postJson(base, "/api/v1/control/commands", { deviceId: "device-fert-002", type: "ESTOP", reason: "巡检急停演练" }, CONFIRM),
    );
    const failed = await dataOf(
      await postJson(base, "/api/v1/control/device/receipt", { commandId: stop.id, status: "FAILED", message: "设备离线，急停未送达" }),
    );
    expect(failed).toMatchObject({ status: "FAILED", receiptMessage: "设备离线，急停未送达" });
    expect(failed.finishedAt).toBeTruthy();
  });

  it("超时未回执单独可筛，列表带在途分钟数", async () => {
    const now = Date.now();
    const minutesAgo = (minutes: number) => new Date(now - minutes * 60000).toISOString();
    const repository = new InMemoryControlCommandRepository([
      command({ id: "cmd-old", createdAt: minutesAgo(40) }),
      command({ id: "cmd-fresh", createdAt: minutesAgo(2) }),
      command({ id: "cmd-sent", status: "SENT", sentAt: minutesAgo(30), createdAt: minutesAgo(90) }),
      command({ id: "cmd-done", status: "DONE", createdAt: minutesAgo(90), finishedAt: minutesAgo(80) }),
    ]);
    const base = await start(createControlHttpServer(repository, { receiptTimeoutMin: 15 }));

    const list = await dataOf(await getJson(base, "/api/v1/control/commands?size=50"));
    const byId = new Map(list.items.map((item: any) => [item.id, item]));
    expect(byId.get("cmd-old").overdue).toBe(true);
    expect(byId.get("cmd-old").pendingMin).toBeGreaterThanOrEqual(39);
    expect(byId.get("cmd-fresh").overdue).toBe(false);
    // 已下发的指令从下发时刻起算，不被更早的入队时间误判
    expect(byId.get("cmd-sent").pendingMin).toBeLessThan(31);
    expect(byId.get("cmd-sent").overdue).toBe(true);
    expect(byId.get("cmd-done").pendingMin).toBeUndefined();
    expect(byId.get("cmd-done").overdue).toBe(false);

    const overdue = await dataOf(await getJson(base, "/api/v1/control/commands?overdue=true&size=50"));
    expect(overdue.items.map((item: any) => item.id).sort()).toEqual(["cmd-old", "cmd-sent"]);

    const pending = await dataOf(await getJson(base, "/api/v1/control/commands?pending=true&size=50"));
    expect(pending.total).toBe(3);
  });
});

describe("设备通道：待执行指令轮询", () => {
  /** 队列现场：同设备三条在途（含已下发未结单）+ 一条已结单 + 别家设备与别家租户各一条 */
  function queueRepository(): InMemoryControlCommandRepository {
    // 时间一律相对当前时刻取：写死某个瞬间会让 pendingMin/overdue 随真实时钟翻脸
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
    return new InMemoryControlCommandRepository([
      command({ id: "cmd-sent", status: "SENT", version: 2, createdAt: minutesAgo(45), sentAt: minutesAgo(30) }),
      command({ id: "cmd-queued-1", createdAt: minutesAgo(2) }),
      command({ id: "cmd-queued-2", createdAt: minutesAgo(1) }),
      command({ id: "cmd-done", status: "DONE", createdAt: minutesAgo(90), finishedAt: minutesAgo(80) }),
      command({ id: "cmd-other-device", deviceId: "device-fert-002", createdAt: minutesAgo(3) }),
      command({ id: "cmd-other-tenant", tenantId: "tenant-other", createdAt: minutesAgo(4) }),
    ]);
  }

  it("只回本设备的在途指令，且按下发先后正序", async () => {
    const base = await start(createControlHttpServer(queueRepository(), { receiptTimeoutMin: 15 }));

    const queued = await dataOf(await getJson(base, "/api/v1/control/device/pending?deviceId=device-fert-001"));
    // 已下发未结单的 SENT 也要回来：网关崩在两轮之间时，靠这条把写了一半的活做完
    expect(queued).toMatchObject({ total: 3, page: 1, size: 50, pages: 1 });
    expect(queued.items.map((item: any) => item.id)).toEqual(["cmd-sent", "cmd-queued-1", "cmd-queued-2"]);
    expect(queued.items[0]).toMatchObject({ status: "SENT", version: 2, deviceId: "device-fert-001", plotCode: "P-1", overdue: true });
    expect(queued.items[0].pendingMin).toBeGreaterThanOrEqual(29);
    expect(queued.items[1]).toMatchObject({ status: "QUEUED", version: 1, overdue: false });
    // 参数原样带回：网关按剖面执行要知道分区与时长，不能只给一个 id
    expect(queued.items[1].parameters).toEqual({ zones: [{ zoneCode: "ZONE-01", areaMu: 10, targetMm: 20 }] });
  });

  it("缺设备标识直接拒绝，翻页不重不漏，别家租户轮不到一条", async () => {
    const base = await start(createControlHttpServer(queueRepository()));

    const noDevice = await getJson(base, "/api/v1/control/device/pending");
    expect(noDevice.status).toBe(400);
    expect((await noDevice.json() as { message: string }).message).toContain("deviceId");

    const first = await dataOf(await getJson(base, "/api/v1/control/device/pending?deviceId=device-fert-001&size=2"));
    expect(first).toMatchObject({ total: 3, size: 2, pages: 2 });
    expect(first.items.map((item: any) => item.id)).toEqual(["cmd-sent", "cmd-queued-1"]);
    const second = await dataOf(await getJson(base, "/api/v1/control/device/pending?deviceId=device-fert-001&size=2&page=2"));
    expect(second.items.map((item: any) => item.id)).toEqual(["cmd-queued-2"]);

    // 换租户轮同一台设备编号：只看到自己那条，演示租户的在途指令一条也不串过来
    const other = await dataOf(await getJson(base, "/api/v1/control/device/pending?deviceId=device-fert-001", { "x-tenant-id": "tenant-other" }));
    expect(other).toMatchObject({ total: 1, pages: 1 });
    expect(other.items.map((item: any) => item.id)).toEqual(["cmd-other-tenant"]);
    expect((await dataOf(await getJson(base, "/api/v1/control/device/pending?deviceId=device-fert-002", { "x-tenant-id": "tenant-other" }))).total).toBe(0);
  });

  it("网关只用设备通道就能把指令从队列做到结单", async () => {
    const base = await start(createControlHttpServer(new InMemoryControlCommandRepository(), { receiptTimeoutMin: 15 }));
    const created = await dataOf(
      await postJson(base, "/api/v1/control/commands", { deviceId: "device-fert-007", type: "IRRIGATION", parameters: { minutes: 10 } }, CONFIRM),
    );

    const before = await dataOf(await getJson(base, "/api/v1/control/device/pending?deviceId=device-fert-007"));
    expect(before.items.map((item: any) => item.id)).toEqual([created.id]);
    expect(before.items[0]).toMatchObject({ status: "QUEUED", version: 1, parameters: { minutes: 10 } });

    // 领取只需队列里给的 id，状态推进由仓储的版本乐观锁兜住并发回填
    const claimed = await dataOf(
      await postJson(base, "/api/v1/control/device/dispatch", { commandId: created.id }),
    );
    expect(claimed).toMatchObject({ status: "SENT", version: 2 });

    const inFlight = await dataOf(await getJson(base, "/api/v1/control/device/pending?deviceId=device-fert-007"));
    expect(inFlight.items[0]).toMatchObject({ id: created.id, status: "SENT", version: 2 });

    expect((await postJson(base, "/api/v1/control/device/receipt", { commandId: created.id, status: "ACKED" })).status).toBe(200);
    expect((await postJson(base, "/api/v1/control/device/receipt", { commandId: created.id, status: "DONE", result: { waterVolumeM3: 6 } })).status).toBe(200);

    const after = await dataOf(await getJson(base, "/api/v1/control/device/pending?deviceId=device-fert-007"));
    expect(after).toMatchObject({ items: [], total: 0, pages: 0 });
  });
});

const databaseUrl = process.env.DB_URL;

describe.runIf(databaseUrl)("SqlControlCommandRepository 回执列（真实库）", () => {
  it("回执时间、版本与结果落库，陈旧版本与非法回退不生效", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const repository = new SqlControlCommandRepository(client);
    const id = `cmd-receipt-smoke-${Date.now()}`;
    try {
      await repository.create(command({ id, createdAt: new Date().toISOString() }));

      // 下发/回执时刻由当前时钟派生：写死某个瞬间会让「刚回执」在时钟越过该瞬间后变成
      // 「陈旧在途」，pendingOverMin 的断言就跟着翻脸。
      const sentAt = new Date(Date.now() - 4 * 60_000).toISOString();
      const ackedAt = new Date(Date.now() - 2 * 60_000).toISOString();

      const sent = await repository.transition(TENANT, { id, status: "SENT", at: sentAt, version: 1 });
      expect(sent).toMatchObject({ id, status: "SENT", version: 2, tenantId: TENANT });
      expect(sent?.sentAt).toBe(sentAt);

      expect(await repository.transition(TENANT, { id, status: "ACKED", at: ackedAt, version: 1 })).toBeNull();
      // 换租户拿同一个 id 跃迁：库里有记录也不许推进别人的指令
      expect(await repository.transition("tenant-other", { id, status: "ACKED", at: ackedAt, version: 2 })).toBeNull();
      expect(await repository.transition(TENANT, { id, status: "QUEUED", at: ackedAt, version: 2 })).toBeNull();

      const acked = await repository.transition(TENANT, {
        id,
        status: "ACKED",
        at: ackedAt,
        version: 2,
        message: "设备已接收",
        result: { rssi: 9 },
      });
      expect(acked).toMatchObject({ status: "ACKED", version: 3, receiptMessage: "设备已接收" });
      expect(acked?.result).toEqual({ rssi: 9 });

      const found = await repository.find(TENANT, id);
      expect(found?.version).toBe(3);
      expect(found?.ackedAt).toBe(ackedAt);
      expect(await repository.find("tenant-other", id)).toBeNull();
      expect((await repository.page(TENANT, { page: 1, size: 200, pending: true })).items.map((item) => item.id)).toContain(id);
      expect((await repository.page("tenant-other", { page: 1, size: 200, pending: true })).items.map((item) => item.id)).not.toContain(id);
      // 在途才 2 分钟：阈值 60 分钟不该捞出来，阈值 1 分钟必须捞出来，两个方向都要堵
      expect((await repository.page(TENANT, { page: 1, size: 200, pending: true, pendingOverMin: 60 })).items.map((item) => item.id)).not.toContain(id);
      expect((await repository.page(TENANT, { page: 1, size: 200, pending: true, pendingOverMin: 1 })).items.map((item) => item.id)).toContain(id);
    } finally {
      await client.$executeRawUnsafe("DELETE FROM control_commands WHERE id = $1", id);
      await client.$disconnect();
    }
  });

  it("设备队列正序取最早下发的指令，正序翻页与倒序翻页互为镜像", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const repository = new SqlControlCommandRepository(client);
    const suffix = Date.now();
    const deviceId = `device-queue-smoke-${suffix}`;
    // 三条在途指令：插入顺序刻意与创建时间相反，靠插入顺序排序的实现会在这里露馅
    const newest = `cmd-queue-c-${suffix}`;
    const middle = `cmd-queue-b-${suffix}`;
    const oldest = `cmd-queue-a-${suffix}`;
    const queue = [
      { id: newest, createdAt: new Date(Date.now() - 1000).toISOString() },
      { id: middle, createdAt: new Date(Date.now() - 2000).toISOString() },
      { id: oldest, createdAt: new Date(Date.now() - 3000).toISOString() },
    ];
    try {
      for (const item of queue) await repository.create(command({ id: item.id, deviceId, createdAt: item.createdAt }));

      const asc = await repository.page(TENANT, { deviceId, pending: true, ascending: true, page: 1, size: 3 });
      expect(asc.items.map((item) => item.id)).toEqual([oldest, middle, newest]);
      expect(asc.total).toBe(3);
      // 倒序仍是列表页的口径，两者互为镜像
      const desc = await repository.page(TENANT, { deviceId, pending: true, page: 1, size: 3 });
      expect(desc.items.map((item) => item.id)).toEqual([newest, middle, oldest]);
      // 正序第二页拿到最后下发的那条：网关一次只领得动一条时也不会跳过最早的
      expect((await repository.page(TENANT, { deviceId, pending: true, ascending: true, page: 2, size: 2 })).items.map((item) => item.id)).toEqual([newest]);

      // 结单后退出队列
      expect(await repository.transition(TENANT, { id: oldest, status: "SENT", at: new Date().toISOString(), version: 1 })).toMatchObject({ status: "SENT" });
      expect((await repository.page(TENANT, { deviceId, pending: true, ascending: true, page: 1, size: 3 })).items.map((item) => item.id)).toEqual([oldest, middle, newest]);
    } finally {
      await client.$executeRawUnsafe("DELETE FROM control_commands WHERE device_id = $1", deviceId);
      await client.$disconnect();
    }
  });
});
