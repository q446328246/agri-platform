import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";

import { EventTopic } from "@agri/contracts";

import { createTractorHttpServer } from "../src/http.js";
import { InMemoryTractorJobRepository } from "../src/job.repository.js";
import { InMemoryTractorSafetyEventRepository } from "../src/safety-event.repository.js";
import { createJobExecutor } from "../src/executor.js";
import type { ControlDispatchInput } from "../src/executor.js";
import { createTractorMonitor } from "../src/monitor.js";
import type { RtkSample } from "../src/monitor.js";
import { evaluatePrecheck, pointInRing, pointInsideWithBuffer } from "../src/safety.js";
import { buildJobStages } from "../src/plan.js";

const servers: Server[] = [];

async function start(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
  return `http://127.0.0.1:${address.port}`;
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))));
  vi.restoreAllMocks();
});

describe("安全验证算法（B2）", () => {
  it("五道预检门全部通过才放行，任一不过给出明确原因", () => {
    const ok = evaluatePrecheck({
      device: { type: "AUTO_TRACTOR", status: "ONLINE", plotCode: "P-1" },
      plot: { status: "ACTIVE", hasBoundary: true },
      deviceBoundToPlot: true,
      inTransitJob: false,
      rtkQuality: { hdop: 1.2, hasFix: true },
    });
    expect(ok.passed).toBe(true);
    expect(ok.gates).toHaveLength(5);

    const noRtk = evaluatePrecheck({
      device: { type: "AUTO_TRACTOR", status: "ONLINE" },
      plot: { status: "ACTIVE", hasBoundary: true },
      deviceBoundToPlot: true,
      inTransitJob: false,
      rtkQuality: null,
    });
    expect(noRtk.passed).toBe(false);
    expect(noRtk.gates.find((gate) => gate.gate === "rtk")?.message).toContain("无 RTK 定位数据");

    const offline = evaluatePrecheck({
      device: { type: "AUTO_TRACTOR", status: "OFFLINE" },
      plot: { status: "ACTIVE", hasBoundary: true },
      deviceBoundToPlot: true,
      inTransitJob: false,
      rtkQuality: { hdop: 1.0, hasFix: true },
    });
    expect(offline.passed).toBe(false);
    expect(offline.gates.find((gate) => gate.gate === "device")?.passed).toBe(false);

    const interlock = evaluatePrecheck({
      device: { type: "AUTO_TRACTOR", status: "ONLINE" },
      plot: { status: "ACTIVE", hasBoundary: true },
      deviceBoundToPlot: true,
      inTransitJob: true,
      rtkQuality: { hdop: 1.0, hasFix: true },
    });
    expect(interlock.gates.find((gate) => gate.gate === "interlock")?.passed).toBe(false);
  });

  it("射线法围栏判定与安全余量", () => {
    const square: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    expect(pointInRing(5, 5, square)).toBe(true);
    expect(pointInRing(15, 5, square)).toBe(false);
    // 边界点在环上按奇偶规则判定，余量为 0 时允许
    expect(pointInsideWithBuffer(5, 5, square, 0)).toBe(true);
    // 余量 2 米（约 0.000018 度）：贴近边界的点判出界，中心点不受影响
    expect(pointInsideWithBuffer(9.99999, 5, square, 2)).toBe(false);
    expect(pointInsideWithBuffer(5, 5, square, 2)).toBe(true);
  });
});

describe("作业计划算法（B2）", () => {
  it("生成换具→作业→返航三步，作业步带面积与时长包络", () => {
    const stages = buildJobStages("SEEDING", { areaMu: 12, durationMin: 30 });
    expect(stages.map((stage) => stage.stage)).toEqual(["TOOL_SWITCH", "OPERATION", "RETURN_HOME"]);
    expect(stages[0]).toMatchObject({ commandType: "TOOL_SWITCH", parameters: { toolCode: "SEEDER" } });
    expect(stages[1]).toMatchObject({ commandType: "SEEDING", parameters: { areaMu: 12, durationMin: 30 }, timeoutMs: 30 * 60_000 + 60_000 });
    expect(stages[2]).toMatchObject({ commandType: "RETURN_HOME" });
  });

  it("缺面积或缺时长拒绝排程，不猜包络", () => {
    expect(() => buildJobStages("TILLAGE", { durationMin: 10 })).toThrow(/areaMu/);
    expect(() => buildJobStages("WEEDING", { areaMu: 5 })).toThrow(/durationMin/);
  });
});

describe("作业执行器（B2）", () => {
  function setup() {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatched: ControlDispatchInput[] = [];
    const dispatch = vi.fn(async (input: ControlDispatchInput) => {
      dispatched.push(input);
      return { commandId: `cmd-${dispatched.length}` };
    });
    const waitCommand = vi.fn(async () => "DONE" as const);
    const publish = vi.fn(async () => {});
    const executor = createJobExecutor({ jobs, safetyEvents, dispatch, waitCommand, publish });
    return { jobs, safetyEvents, dispatched, dispatch, waitCommand, publish, executor };
  }

  it("逐分步下发，全部收口后作业完成", async () => {
    const { jobs, executor, dispatched } = setup();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "测试",
    });
    for (const stage of buildJobStages("SEEDING", { areaMu: 10, durationMin: 20 })) {
      await jobs.addStage(undefined, { jobId: job.id, stage: stage.stage, commandType: stage.commandType, timeoutMs: stage.timeoutMs });
    }
    await executor.run(job);

    const finished = await jobs.findJob(job.id);
    expect(finished?.status).toBe("COMPLETED");
    expect(dispatched.map((input) => input.type)).toEqual(["TOOL_SWITCH", "SEEDING", "RETURN_HOME"]);
    // 作业步参数带包络，联动步不带
    expect(dispatched[1]!.parameters).toMatchObject({ areaMu: 10, durationMin: 20 });
    expect(dispatched[0]!.parameters).toEqual({});
  });

  it("下发被拒即收口作业为失败，不继续下一步", async () => {
    const { jobs, executor, dispatch } = setup();
    dispatch.mockResolvedValueOnce(null);
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "TILLAGE",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "",
    });
    await jobs.addStage(undefined, { jobId: job.id, stage: "TOOL_SWITCH", commandType: "TOOL_SWITCH", timeoutMs: 1000 });
    await executor.run(job);
    const finished = await jobs.findJob(job.id);
    expect(finished?.status).toBe("FAILED");
    expect(finished?.reason).toContain("下发被拒");
  });

  it("急停下发 ESTOP 并留安全事件", async () => {
    const { jobs, safetyEvents, executor, dispatched } = setup();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "WEEDING",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "",
    });
    await jobs.updateJob(undefined, job.id, { status: "RUNNING" });
    const stopped = await executor.stop(job.id, true);
    expect(stopped?.status).toBe("ESTOPPED");
    expect(dispatched[0]!.type).toBe("ESTOP");
    const events = await safetyEvents.list({});
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "ESTOP", level: "CRITICAL" });
  });
});

describe("作业期安全监测（B2）", () => {
  function setup(rtk: RtkSample | null) {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatched: ControlDispatchInput[] = [];
    const dispatch = vi.fn(async (input: ControlDispatchInput) => {
      dispatched.push(input);
      return { commandId: `cmd-${dispatched.length}` };
    });
    const monitor = createTractorMonitor({
      jobs,
      safetyEvents,
      fetchRtk: async () => rtk,
      insideGeofence: async () => true,
      dispatch,
      intervalMs: 10_000,
      commLossSeconds: 30,
      rtkHdopMax: 2,
      now: () => new Date("2026-11-20T00:00:00.000Z"),
    });
    return { jobs, safetyEvents, dispatched, dispatch, monitor };
  }

  async function runningJob(jobs: InMemoryTractorJobRepository): Promise<string> {
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "",
    });
    await jobs.updateJob(undefined, job.id, { status: "RUNNING" });
    return job.id;
  }

  it("越界首次暂停、持续越界升级急停", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatched: ControlDispatchInput[] = [];
    const dispatch = vi.fn(async (input: ControlDispatchInput) => {
      dispatched.push(input);
      return { commandId: `cmd-${dispatched.length}` };
    });
    const monitor = createTractorMonitor({
      jobs,
      safetyEvents,
      fetchRtk: async () => ({ lng: 107.5, lat: 30.9, recordedAt: "2026-11-20T00:00:00.000Z" }),
      insideGeofence: async () => false,
      dispatch,
      intervalMs: 10_000,
      now: () => new Date("2026-11-20T00:00:00.000Z"),
    });
    const jobId = await runningJob(jobs);

    await monitor.tick();
    expect(dispatched[0]!.type).toBe("PAUSE");
    expect((await jobs.findJob(jobId))?.status).toBe("PAUSED");
    expect((await safetyEvents.list({ jobId }))[0]?.kind).toBe("GEOFENCE_BREACH");

    await monitor.tick();
    expect(dispatched[1]!.type).toBe("ESTOP");
    expect((await jobs.findJob(jobId))?.status).toBe("ESTOPPED");
    const events = await safetyEvents.list({ jobId });
    expect(events.find((event) => event.kind === "GEOFENCE_BREACH" && event.level === "CRITICAL")).toBeTruthy();
  });

  it("通信失联直接急停收口", async () => {
    const { jobs, safetyEvents, dispatched, monitor } = setup(null);
    const jobId = await runningJob(jobs);
    await monitor.tick();
    expect(dispatched[0]!.type).toBe("ESTOP");
    expect((await jobs.findJob(jobId))?.status).toBe("ESTOPPED");
    expect((await safetyEvents.list({ jobId }))[0]).toMatchObject({ kind: "COMM_LOSS", level: "CRITICAL" });
  });

  it("RTK 质量劣化暂停作业", async () => {
    const { jobs, safetyEvents, dispatched, monitor } = setup({ lng: 107.5, lat: 30.9, hdop: 3.5, recordedAt: "2026-11-20T00:00:00.000Z" });
    const jobId = await runningJob(jobs);
    await monitor.tick();
    expect(dispatched[0]!.type).toBe("PAUSE");
    expect((await jobs.findJob(jobId))?.status).toBe("PAUSED");
    expect((await safetyEvents.list({ jobId }))[0]).toMatchObject({ kind: "RTK_QUALITY" });
  });
});

describe("拖拉机作业 HTTP 接口（B2）", () => {
  const savedAuthGuard: string | undefined = process.env.AUTH_GUARD_MODE;

  beforeEach(() => {
    process.env.AUTH_GUARD_MODE = "enforce";
  });

  afterEach(() => {
    if (savedAuthGuard === undefined) delete process.env.AUTH_GUARD_MODE;
    else process.env.AUTH_GUARD_MODE = savedAuthGuard;
  });

  it("预检不过拒绝排程并留安全事件，通过则排程成功", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const precheck = vi.fn(async () => ({
      passed: false,
      tenantId: "tenant-demo",
      gates: [{ gate: "rtk", passed: false, message: "无 RTK 定位数据，拒绝精准作业" }],
    }));
    const base = await start(createTractorHttpServer({ jobs, safetyEvents, precheck }));
    const headers = { "x-user-id": "user-1", "x-permissions": "tractor:write" };

    const denied = await post(base, "/api/v1/tractor/jobs", {
      plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING", parameters: { areaMu: 10, durationMin: 20 },
    }, headers);
    expect(denied.status).toBe(409);
    expect((await denied.json() as { message: string }).message).toContain("安全预检未通过");
    expect(await safetyEvents.list({})).toHaveLength(1);

    const passed = { passed: true, tenantId: "tenant-demo", gates: [] };
    precheck.mockResolvedValueOnce(passed);
    const ok = await post(base, "/api/v1/tractor/jobs", {
      plotCode: "P-1", deviceId: "tractor-001", operationType: "TILLAGE", parameters: { areaMu: 10, durationMin: 20 },
    }, headers);
    expect(ok.status).toBe(201);
    const job = (await ok.json() as { data: { status: string; currentStage: number } }).data;
    expect(job).toMatchObject({ status: "PLANNED", currentStage: 0 });
    // 分步计划随作业落库
    const stages = await jobs.listStages((await jobs.listJobs({}))[0]!.id);
    expect(stages.map((stage) => stage.stage)).toEqual(["TOOL_SWITCH", "OPERATION", "RETURN_HOME"]);
  });

  it("非法作业类型返回 400，缺参返回 400，权限按 tractor:read/write 放行", async () => {
    const base = await start(createTractorHttpServer());
    const writeHeaders = { "x-user-id": "user-1", "x-permissions": "tractor:write" };
    const readHeaders = { "x-user-id": "user-1", "x-permissions": "tractor:read" };

    const badType = await post(base, "/api/v1/tractor/jobs", { plotCode: "P-1", deviceId: "d", operationType: "HARVEST", parameters: { areaMu: 1, durationMin: 1 } }, writeHeaders);
    expect(badType.status).toBe(400);

    const badParams = await post(base, "/api/v1/tractor/jobs", { plotCode: "P-1", deviceId: "d", operationType: "SEEDING", parameters: { areaMu: 1 } }, writeHeaders);
    expect(badParams.status).toBe(400);

    const anonymous = await fetch(`${base}/api/v1/tractor/jobs`);
    expect(anonymous.status).toBe(401);
    const readOk = await fetch(`${base}/api/v1/tractor/jobs`, { headers: readHeaders });
    expect(readOk.status).toBe(200);
    const writeDenied = await post(base, "/api/v1/tractor/jobs", { plotCode: "P-1", deviceId: "d", operationType: "SEEDING", parameters: { areaMu: 1, durationMin: 1 } }, readHeaders);
    expect(writeDenied.status).toBe(403);
  });

  it("安全事件列表按类型筛选，非法类型 400", async () => {
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    await safetyEvents.create(undefined, { tenantId: "t", plotCode: "P-1", deviceId: "d", kind: "ESTOP", level: "CRITICAL", message: "急停" });
    const base = await start(createTractorHttpServer({ safetyEvents }));
    const headers = { "x-user-id": "user-1", "x-permissions": "tractor:read" };

    const filtered = await fetch(`${base}/api/v1/tractor/safety-events?kind=ESTOP`, { headers });
    expect(filtered.status).toBe(200);
    expect((await filtered.json() as { data: { total: number } }).data.total).toBe(1);

    const bad = await fetch(`${base}/api/v1/tractor/safety-events?kind=unknown`, { headers });
    expect(bad.status).toBe(400);
  });
});

describe("拖拉机安全事件消息模板（B2）", () => {
  it("事件主题在契约中登记且模板可渲染", async () => {
    const { buildMessageDraft } = await import("@agri/contracts");
    const draft = buildMessageDraft(EventTopic.TractorSafetyEvent, {
      parcelId: "P-1", deviceId: "tractor-001", kind: "GEOFENCE_BREACH", level: "CRITICAL",
      message: "作业位置越过地块边界", lng: 107.5, lat: 30.9, occurredAt: "2026-11-20T08:00:00.000Z",
    }, { eventId: "evt-1", occurredAt: "2026-11-20T08:00:00.000Z" });
    expect(draft).toMatchObject({ type: "ALERT", level: "CRITICAL", plotCode: "P-1" });
    expect(draft?.title).toBe("拖拉机安全告警：P-1 电子围栏越界");
  });
});
