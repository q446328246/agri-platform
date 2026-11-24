import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";

import { EventTopic } from "@agri/contracts";
import type { PrismaClientLike, Tx } from "@agri/db";

import { createTractorHttpServer } from "../src/http.js";
import { InMemoryTractorJobRepository, SqlTractorJobRepository } from "../src/job.repository.js";
import { InMemoryTractorSafetyEventRepository, SqlTractorSafetyEventRepository } from "../src/safety-event.repository.js";
import { createJobActionLock, createJobExecutor, recoverUnfinishedJobs, recoveryCommand } from "../src/executor.js";
import type { ControlDispatchInput, JobExecutorDeps } from "../src/executor.js";
import { createTractorMonitor } from "../src/monitor.js";
import type { RtkSample } from "../src/monitor.js";
import { buildValidRtkSample, evaluatePrecheck, pathInsidePolygon, pathInsideRing, pointInPolygon, pointInRing, pointInsidePolygonWithBuffer, pointInsideWithBuffer, polygonRingsOf } from "../src/safety.js";
import { buildJobStages } from "../src/plan.js";
import { InMemoryTrajectoryRepository, SqlTrajectoryRepository } from "../src/trajectory.repository.js";
import type { TrajectoryPoint } from "../src/trajectory.repository.js";
import { createTrajectoryPlanner, distanceToPolylineM, trajectoryFromCoverage, trajectoryFromPoints } from "../src/trajectory.js";

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
  const validRtk = (recordedAt = new Date().toISOString()) => ({ lng: 107, lat: 30, hdop: 1.2, hasFix: true, recordedAt });

  it("五道预检门全部通过才放行，任一不过给出明确原因", () => {
    const ok = evaluatePrecheck({
      device: { type: "AUTO_TRACTOR", status: "ONLINE", plotCode: "P-1" },
      plot: { status: "ACTIVE", hasBoundary: true, boundaryValid: true },
      deviceBoundToPlot: true,
      inTransitJob: false,
      rtkQuality: validRtk(),
      positionInside: true,
    });
    expect(ok.passed).toBe(true);
    expect(ok.gates).toHaveLength(5);

    const noRtk = evaluatePrecheck({
      device: { type: "AUTO_TRACTOR", status: "ONLINE" },
      plot: { status: "ACTIVE", hasBoundary: true, boundaryValid: true },
      deviceBoundToPlot: true,
      inTransitJob: false,
      rtkQuality: null,
      positionInside: false,
    });
    expect(noRtk.passed).toBe(false);
    expect(noRtk.gates.find((gate) => gate.gate === "rtk")?.message).toContain("无 RTK 定位数据");

    const offline = evaluatePrecheck({
      device: { type: "AUTO_TRACTOR", status: "OFFLINE" },
      plot: { status: "ACTIVE", hasBoundary: true, boundaryValid: true },
      deviceBoundToPlot: true,
      inTransitJob: false,
      rtkQuality: validRtk(),
      positionInside: true,
    });
    expect(offline.passed).toBe(false);
    expect(offline.gates.find((gate) => gate.gate === "device")?.passed).toBe(false);

    const interlock = evaluatePrecheck({
      device: { type: "AUTO_TRACTOR", status: "ONLINE" },
      plot: { status: "ACTIVE", hasBoundary: true, boundaryValid: true },
      deviceBoundToPlot: true,
      inTransitJob: true,
      rtkQuality: validRtk(),
      positionInside: true,
    });
    expect(interlock.gates.find((gate) => gate.gate === "interlock")?.passed).toBe(false);
  });

  it("RTK 采样过期或当前位置越界时拒绝预检", () => {
    const nowMs = Date.parse("2026-11-24T00:00:00.000Z");
    const base = {
      device: { type: "AUTO_TRACTOR", status: "ONLINE", plotCode: "P-1" },
      plot: { status: "ACTIVE", hasBoundary: true, boundaryValid: true },
      deviceBoundToPlot: true,
      inTransitJob: false,
      positionInside: true,
    };
    const stale = evaluatePrecheck({
      ...base,
      rtkQuality: { ...validRtk(), recordedAt: "2026-11-23T23:59:00.000Z" },
    }, { nowMs });
    expect(stale.passed).toBe(false);
    expect(stale.gates.find((gate) => gate.gate === "rtk")?.message).toContain("过期");

    const outside = evaluatePrecheck({ ...base, rtkQuality: validRtk("2026-11-24T00:00:00.000Z"), positionInside: false }, { nowMs });
    expect(outside.passed).toBe(false);
    expect(outside.gates.find((gate) => gate.gate === "rtk")?.message).toContain("安全边界外");
  });

  it("返航恢复允许已离开地块，但仍校验 RTK、设备、绑定与互锁", () => {
    const nowMs = Date.parse("2026-11-24T00:00:00.000Z");
    const base = {
      device: { type: "AUTO_TRACTOR", status: "ONLINE", plotCode: "P-1" },
      plot: { status: "ACTIVE", hasBoundary: true, boundaryValid: true },
      deviceBoundToPlot: true,
      inTransitJob: false,
      positionInside: false,
      requirePositionInside: false,
    };
    const rtkQuality = { lng: 107, lat: 30, hdop: 1.2, hasFix: true, recordedAt: "2026-11-24T00:00:00.000Z" };
    expect(evaluatePrecheck({ ...base, rtkQuality }, { nowMs }).passed).toBe(true);
    expect(evaluatePrecheck({ ...base, rtkQuality: null }, { nowMs }).passed).toBe(false);
    expect(evaluatePrecheck({ ...base, rtkQuality, device: { type: "AUTO_TRACTOR", status: "OFFLINE" } }, { nowMs }).passed).toBe(false);
    expect(evaluatePrecheck({ ...base, rtkQuality, inTransitJob: true }, { nowMs }).passed).toBe(false);
    expect(evaluatePrecheck({ ...base, rtkQuality, deviceBoundToPlot: false }, { nowMs }).passed).toBe(false);
    expect(evaluatePrecheck({ ...base, rtkQuality, requirePositionInside: true }, { nowMs }).passed).toBe(false);
  });

  it("RTK 指标同刻且 fix 有效才拼成定位，0 或错位采样均拒绝", () => {
    const at = "2026-11-20T00:00:00.000Z";
    const metrics = {
      lng: { value: 107.5, recordedAt: at },
      lat: { value: 30.9, recordedAt: at },
      hdop: { value: 1.2, recordedAt: at },
      fix: { value: 1, recordedAt: at },
    };
    expect(buildValidRtkSample(metrics)).toMatchObject({ lng: 107.5, lat: 30.9, hasFix: true });
    expect(buildValidRtkSample({ ...metrics, fix: { value: 0, recordedAt: at } })).toMatchObject({ hasFix: false });
    expect(buildValidRtkSample({ ...metrics, fix: { value: 1, recordedAt: "2026-11-20T00:00:01.000Z" } })).toBeNull();
    expect(buildValidRtkSample({ ...metrics, hdop: null })).toBeNull();
    expect(buildValidRtkSample({ ...metrics, lat: { value: Number.NaN, recordedAt: at } })).toBeNull();
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

  it("围栏余量按纬度换算经度米数，高纬度近边界点不得放行", () => {
    const square: Array<[number, number]> = [[100, 40], [101, 40], [101, 41], [100, 41], [100, 40]];
    const distanceFromEastEdgeM = 0.00004 * 111_320 * Math.cos((40.5 * Math.PI) / 180);
    expect(distanceFromEastEdgeM).toBeLessThan(5);
    expect(pointInsideWithBuffer(100.99996, 40.5, square, 5)).toBe(false);
    expect(pointInsideWithBuffer(100.9998, 40.5, square, 5)).toBe(true);
  });

  it("Polygon 内环视为禁入区，路径穿洞或贴近洞边均拒绝", () => {
    const rings: Array<Array<[number, number]>> = [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
    ];
    expect(pointInPolygon(2, 2, rings)).toBe(true);
    expect(pointInPolygon(5, 5, rings)).toBe(false);
    expect(pathInsidePolygon([[2, 5], [8, 5]], rings)).toBe(false);
    expect(pathInsidePolygon([[2, 2], [8, 8]], rings)).toBe(false);
    expect(pathInsidePolygon([[4, 2], [4, 4]], rings)).toBe(false);
    expect(pathInsidePolygon([[4, 4], [6, 4]], rings)).toBe(false);
    expect(pathInsidePolygon([[1, 1], [3, 3]], rings)).toBe(true);
    expect(pointInsidePolygonWithBuffer(5, 3.999991, rings, 2)).toBe(false);
  });

  it("覆盖轨迹允许端点落在外边界，但仍拒绝穿出边界", () => {
    const square: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    expect(pathInsidePolygon([[0, 5], [5, 5]], [square])).toBe(true);
    expect(pathInsidePolygon([[0, 5], [10, 5]], [square])).toBe(true);
    expect(pathInsidePolygon([[2, 5], [8, 5], [12, 5]], [square])).toBe(false);
  });

  it("Polygon 外环自交、孔洞越界或重叠均判为非法边界", () => {
    const crossed = { type: "Polygon" as const, coordinates: [[[0, 0], [10, 10], [0, 10], [10, 0], [0, 0]]] };
    expect(polygonRingsOf(crossed)).toBeNull();
    const outsideHole = { type: "Polygon" as const, coordinates: [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[8, 8], [12, 8], [12, 12], [8, 12], [8, 8]],
    ] };
    expect(polygonRingsOf(outsideHole)).toBeNull();
    const overlappingHoles = { type: "Polygon" as const, coordinates: [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[2, 2], [6, 2], [6, 6], [2, 6], [2, 2]],
      [[4, 4], [8, 4], [8, 8], [4, 8], [4, 4]],
    ] };
    expect(polygonRingsOf(overlappingHoles)).toBeNull();
  });

  it("手工轨迹校验覆盖整条线段，凹多边形内两点之间穿出也会拒绝", () => {
    const square: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    expect(pathInsideRing([[2, 2], [8, 8]], square)).toBe(true);
    expect(pathInsideRing([[2, 5], [12, 5]], square)).toBe(false);

    const concave: Array<[number, number]> = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]];
    expect(pathInsideRing([[2, 8], [8, 2]], concave)).toBe(false);

    const notched: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [6, 10], [6, 4], [4, 4], [4, 10], [0, 10], [0, 0]];
    expect(pathInsideRing([[4, 10], [6, 10]], notched)).toBe(false);
    expect(pathInsideRing([[2, 10], [4, 10]], notched)).toBe(true);
    expect(pathInsideRing([[4, 10], [4, 4], [6, 4]], notched)).toBe(true);
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

describe("仓储租户隔离与 CAS", () => {
  it("内存作业、分步、轨迹与安全事件查询更新均按租户隔离", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const trajectories = new InMemoryTrajectoryRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-a", plotCode: "P-1", deviceId: "d", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.createJob(undefined, {
      tenantId: "tenant-b", plotCode: "P-1", deviceId: "d", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-a", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await trajectories.create(undefined, {
      tenantId: "tenant-a", jobId: job.id, plotCode: "P-1", source: "MANUAL", path: [[107, 30], [107.1, 30]],
      totalDistanceM: 100, durationMin: 1, warnings: [],
    });
    await safetyEvents.create(undefined, { tenantId: "tenant-a", jobId: job.id, plotCode: "P-1", deviceId: "d", kind: "ESTOP", level: "CRITICAL", message: "急停" });
    await safetyEvents.create(undefined, { tenantId: "tenant-b", jobId: job.id, plotCode: "P-1", deviceId: "d", kind: "ESTOP", level: "CRITICAL", message: "其他租户" });

    expect(await jobs.listJobs({ tenantId: "tenant-a" })).toHaveLength(1);
    expect(await jobs.findJob("tenant-b", job.id)).toBeNull();
    expect(await jobs.listStages("tenant-b", job.id)).toEqual([]);
    expect(await jobs.updateJob("tenant-b", job.id, { status: "FAILED" })).toBeNull();
    expect(await jobs.updateStage("tenant-b", stage.id, { status: "DONE" })).toBeNull();
    expect(await jobs.updateJob("tenant-a", job.id, { status: "FAILED" }, { expectedStatus: "RUNNING" })).toBeNull();
    expect(await trajectories.findByJob("tenant-b", job.id)).toBeNull();
    expect(await trajectories.listByJob("tenant-b", job.id)).toEqual([]);
    await expect(trajectories.create(undefined, {
      tenantId: "tenant-a", jobId: job.id, plotCode: "P-1", source: "MANUAL", path: [[107, 30], [107.1, 30]],
      totalDistanceM: 100, durationMin: 1, warnings: [],
    })).rejects.toThrow("已存在轨迹");
    expect(await safetyEvents.list({ tenantId: "tenant-a", jobId: job.id })).toHaveLength(1);
    expect(await safetyEvents.list({ tenantId: "tenant-b", jobId: job.id })).toHaveLength(1);
  });

  it("SQL 查询与 CAS 更新都带租户条件和参数", async () => {
    const query = vi.fn(async (_sql: string, ..._params: unknown[]): Promise<Record<string, unknown>[]> => []);
    const client = { $queryRawUnsafe: query } as unknown as PrismaClientLike;
    const jobs = new SqlTractorJobRepository(client);
    const trajectories = new SqlTrajectoryRepository(client);
    const safetyEvents = new SqlTractorSafetyEventRepository(client);

    await jobs.findJob("tenant-a", "job-1");
    await jobs.listStages("tenant-a", "job-1");
    await jobs.listJobs({ tenantId: "tenant-a", status: "RUNNING" });
    await jobs.updateJob("tenant-a", "job-1", { status: "FAILED" }, { expectedStatus: "RUNNING" });
    await jobs.updateStage("tenant-a", "stage-1", { status: "DONE" }, { expectedStatus: "SENT" });
    await trajectories.findByJob("tenant-a", "job-1");
    await trajectories.listByJob("tenant-a", "job-1");
    await safetyEvents.list({ tenantId: "tenant-a", jobId: "job-1" });

    for (const [sql, ...params] of query.mock.calls) {
      expect(sql).toMatch(/tenant_id/);
      expect(params).toContain("tenant-a");
    }
    expect(query.mock.calls[2]![0]).toBe("SELECT * FROM tractor_jobs WHERE tenant_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT $3 OFFSET $4");
    expect(query.mock.calls[2]!.slice(1)).toEqual(["tenant-a", "RUNNING", 50, 0]);
    expect(query.mock.calls[7]![0]).toBe("SELECT * FROM tractor_safety_events WHERE tenant_id = $1 AND job_id = $2 ORDER BY created_at DESC LIMIT $3");
    expect(query.mock.calls[7]!.slice(1)).toEqual(["tenant-a", "job-1", 50]);
    expect(query.mock.calls[3]![0]).toContain("status = $");
    expect(query.mock.calls[4]![0]).toContain("s.status = $");
    expect(query.mock.calls[3]![1]).toBe("FAILED");
    expect(query.mock.calls[4]![1]).toBe("DONE");
    expect(query.mock.calls[3]!.slice(1)).toContain("RUNNING");
    expect(query.mock.calls[4]!.slice(1)).toContain("SENT");
  });
});

describe("作业执行器（B2）", () => {
  function setup(overrides: Partial<JobExecutorDeps> = {}) {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatched: ControlDispatchInput[] = [];
    const dispatch = vi.fn(async (input: ControlDispatchInput) => {
      dispatched.push(input);
      return { commandId: `cmd-${dispatched.length}` };
    });
    const waitCommand = vi.fn(async (): Promise<"DONE" | "FAILED" | "PAUSED" | "TIMEOUT" | "UNAVAILABLE"> => "DONE");
    const publish = vi.fn(async () => {});
    const executor = createJobExecutor({ jobs, safetyEvents, dispatch, waitCommand, publish, ...overrides });
    return { jobs, safetyEvents, dispatched, dispatch, waitCommand, publish, executor };
  }

  it("逐分步下发，全部收口后作业完成", async () => {
    const { jobs, executor, dispatched } = setup();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "测试",
    });
    for (const stage of buildJobStages("SEEDING", { areaMu: 10, durationMin: 20 })) {
      await jobs.addStage(undefined, { tenantId: "tenant-demo", jobId: job.id, stage: stage.stage, commandType: stage.commandType, parameters: stage.parameters, timeoutMs: stage.timeoutMs });
    }
    await executor.run(job);

    const finished = await jobs.findJob("tenant-demo", job.id);
    expect(finished?.status).toBe("COMPLETED");
    expect(dispatched.map((input) => input.type)).toEqual(["TOOL_SWITCH", "SEEDING", "RETURN_HOME"]);
    // 每步下发带各自持久化的参数：换具带机具编码，作业带面积与时长，返航不带参数
    expect(dispatched[1]!.parameters).toMatchObject({ areaMu: 10, durationMin: 20 });
    expect(dispatched[0]!.parameters).toEqual({ toolCode: "SEEDER" });
    expect(dispatched[2]!.parameters).toEqual({});
  });

  it("旧执行周期收到迟到 PAUSED 时不能覆盖已恢复的新周期", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    let releaseResult!: () => void;
    let markWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseResult = resolve; });
    const executor = createJobExecutor({
      jobs,
      safetyEvents,
      dispatch: async () => ({ commandId: "cmd-stage" }),
      waitCommand: async () => {
        markWaiting();
        await blocked;
        return "PAUSED";
      },
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });

    const running = executor.run(job);
    await waiting;
    await jobs.updateJob("tenant-demo", job.id, { status: "PAUSED" });
    const resumed = await jobs.updateJob("tenant-demo", job.id, { status: "RUNNING" });
    expect(resumed?.runRevision).toBe(2);
    releaseResult();
    await running;

    expect(await jobs.findJob("tenant-demo", job.id)).toMatchObject({ status: "RUNNING", runRevision: 2 });
  });

  it("预检返回后作业已被急停，不再下发分步指令", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatch = vi.fn(async () => ({ commandId: "cmd-stage" }));
    const executor = createJobExecutor({
      jobs, safetyEvents, dispatch,
      waitCommand: async () => "DONE",
      beforeStage: async () => {
        await jobs.updateJob("tenant-demo", job.id, { status: "ESTOPPED", reason: "预检期间并发急停" });
        return { passed: true };
      },
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "RUNNING" });
    await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });

    await executor.run(job, { started: true });

    expect(dispatch).not.toHaveBeenCalled();
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("ESTOPPED");
  });

  it("每个分步下发前重新预检，作业步位置门失败时不下发作业或返航", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatched: ControlDispatchInput[] = [];
    const beforeStage = vi.fn(async (_job: unknown, stage: { stage: string }) => ({ passed: stage.stage !== "OPERATION" }));
    const executor = createJobExecutor({
      jobs, safetyEvents, beforeStage,
      dispatch: async (input) => { dispatched.push(input); return { commandId: `cmd-${dispatched.length}` }; },
      waitCommand: async () => "DONE",
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "",
    });
    for (const stage of buildJobStages("SEEDING", { areaMu: 10, durationMin: 20 })) {
      await jobs.addStage(undefined, { tenantId: "tenant-demo", jobId: job.id, stage: stage.stage, commandType: stage.commandType, parameters: stage.parameters, timeoutMs: stage.timeoutMs });
    }

    await executor.run(job);

    expect(dispatched.map((input) => input.type)).toEqual(["TOOL_SWITCH"]);
    expect(beforeStage.mock.calls.map((call) => call[1].stage)).toEqual(["TOOL_SWITCH", "OPERATION"]);
    expect(await jobs.findJob("tenant-demo", job.id)).toMatchObject({ status: "PAUSED", currentStage: 1 });
    expect((await jobs.listStages("tenant-demo", job.id)).map((stage) => stage.status)).toEqual(["DONE", "PENDING", "PENDING"]);
  });

  it("PENDING 步预检失败后可在条件恢复时继续，无需 RESUME 控制指令", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatched: ControlDispatchInput[] = [];
    let passed = false;
    const executor = createJobExecutor({
      jobs,
      safetyEvents,
      beforeStage: async () => ({ passed }),
      dispatch: async (input) => { dispatched.push(input); return { commandId: "cmd-operation" }; },
      waitCommand: async () => "DONE",
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });

    await executor.run(job);
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("PAUSED");
    expect(dispatched).toEqual([]);

    passed = true;
    await executor.resume("tenant-demo", job.id);
    await vi.waitFor(async () => expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("COMPLETED"));
    expect(dispatched.map((input) => input.type)).toEqual(["SEEDING"]);
  });

  it("SENT 步 RESUME 后二次预检失败会确认 PAUSE，设备不停而本地不假暂停", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatched: ControlDispatchInput[] = [];
    const beforeStage = vi.fn()
      .mockResolvedValueOnce({ passed: true, commandId: "cmd-active" })
      .mockResolvedValueOnce({ passed: false, commandId: "cmd-active" });
    const executor = createJobExecutor({
      jobs,
      safetyEvents,
      beforeStage,
      dispatch: async (input) => { dispatched.push(input); return { commandId: `cmd-${dispatched.length}` }; },
      waitCommand: async () => "DONE",
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "PAUSED" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });

    await executor.resume("tenant-demo", job.id);
    await vi.waitFor(async () => expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("PAUSED"));

    expect(dispatched.map((input) => input.type)).toEqual(["RESUME", "PAUSE"]);
    expect(dispatched[1]).toMatchObject({ parameters: { targetCommandId: "cmd-active" } });
    expect((await jobs.listStages("tenant-demo", job.id))[0]).toMatchObject({ status: "SENT", commandId: "cmd-active" });
  });

  it("预检发现 PENDING 孤儿指令后回写关联并续跑，不重复下发", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatch = vi.fn(async () => ({ commandId: "cmd-unexpected" }));
    const waitCommand = vi.fn(async () => "DONE" as const);
    const executor = createJobExecutor({
      jobs,
      safetyEvents,
      beforeStage: async () => ({ passed: true, commandId: "cmd-orphan" }),
      dispatch,
      waitCommand,
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });

    await executor.run(job);

    expect(dispatch).not.toHaveBeenCalled();
    expect(waitCommand).toHaveBeenCalledWith("tenant-demo", "tractor-001", "cmd-orphan", 1000);
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("COMPLETED");
    expect((await jobs.listStages("tenant-demo", job.id))[0]).toMatchObject({ status: "DONE", commandId: "cmd-orphan" });
  });

  it("QUEUED 孤儿预检失败时原子取消，不向排队指令发无效 PAUSE", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatch = vi.fn(async () => ({ commandId: "cmd-unexpected" }));
    const commandOf = vi.fn()
      .mockResolvedValueOnce({ status: "QUEUED" })
      .mockResolvedValueOnce({ status: "CANCELLED" });
    const cancelCommand = vi.fn(async () => true);
    const executor = createJobExecutor({
      jobs, safetyEvents, dispatch, commandOf, cancelCommand,
      beforeStage: async () => ({ passed: false, commandId: "cmd-queued", commandStatus: "QUEUED" }),
      waitCommand: async () => "DONE",
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });

    await executor.run(job);

    expect(dispatch).not.toHaveBeenCalled();
    expect(cancelCommand).toHaveBeenCalledWith("tenant-demo", "cmd-queued", expect.any(String));
    expect((await jobs.listStages("tenant-demo", job.id))[0]).toMatchObject({ status: "FAILED", commandId: "cmd-queued" });
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("FAILED");
  });

  it("分步收口超时先确认暂停，设备停稳后才写本地 PAUSED", async () => {
    const { jobs, executor, dispatched, waitCommand } = setup();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    waitCommand.mockResolvedValueOnce("TIMEOUT").mockResolvedValueOnce("DONE");

    await executor.run(job);

    expect(dispatched.map((input) => input.type)).toEqual(["SEEDING", "PAUSE"]);
    expect((await jobs.listStages("tenant-demo", job.id))[0]).toMatchObject({ status: "SENT", commandId: "cmd-1" });
    expect((await jobs.findJob("tenant-demo", job.id))).toMatchObject({ status: "PAUSED" });
  });

  it("分步收口超时且暂停无法确认时保持 RUNNING/SENT，不假称设备已停", async () => {
    const { jobs, executor, dispatched, waitCommand } = setup();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    waitCommand.mockResolvedValueOnce("TIMEOUT").mockResolvedValueOnce("TIMEOUT");

    await executor.run(job);

    expect(dispatched.map((input) => input.type)).toEqual(["SEEDING", "PAUSE"]);
    expect((await jobs.listStages("tenant-demo", job.id))[0]?.status).toBe("SENT");
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("RUNNING");
  });

  it("设备自主暂停回执会同步本地 PAUSED，保留 SENT 分步供恢复", async () => {
    const { jobs, executor, waitCommand } = setup();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    waitCommand.mockResolvedValueOnce("PAUSED");

    await executor.run(job);

    expect((await jobs.listStages("tenant-demo", job.id))[0]).toMatchObject({ status: "SENT", commandId: "cmd-1" });
    expect((await jobs.findJob("tenant-demo", job.id))).toMatchObject({ status: "PAUSED" });
  });

  it("恢复时发现目标指令已 DONE，先补齐本地分步再续跑，不发无效 RESUME", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatch = vi.fn(async () => ({ commandId: "cmd-unexpected" }));
    const executor = createJobExecutor({
      jobs, safetyEvents, dispatch,
      commandOf: async () => ({ status: "DONE" }),
      waitCommand: async () => "DONE",
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "PAUSED" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-done" }, { expectedStatus: "PENDING" });

    const resumed = await executor.resume("tenant-demo", job.id);

    expect(resumed).toMatchObject({ status: "RUNNING", currentStage: 1 });
    expect(dispatch).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("COMPLETED"));
    expect((await jobs.listStages("tenant-demo", job.id))[0]).toMatchObject({ status: "DONE", commandId: "cmd-done" });
  });

  it("stop 与 resume 并发时按作业串行，最终控制与本地状态一致", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatched: ControlDispatchInput[] = [];
    let releasePause!: (result: "DONE") => void;
    const pauseConfirmed = new Promise<"DONE">((resolve) => { releasePause = resolve; });
    const executor = createJobExecutor({
      jobs, safetyEvents,
      dispatch: async (input) => {
        dispatched.push(input);
        return { commandId: input.type === "PAUSE" ? "cmd-pause" : "cmd-resume" };
      },
      waitCommand: async (_tenant, _device, commandId) => commandId === "cmd-pause" ? pauseConfirmed : "DONE",
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "RUNNING" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });

    const stopping = executor.stop("tenant-demo", job.id, false);
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    const resuming = executor.resume("tenant-demo", job.id);
    await Promise.resolve();
    expect(dispatched.map((input) => input.type)).toEqual(["PAUSE"]);
    releasePause("DONE");
    await stopping;
    await resuming;
    await vi.waitFor(async () => expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("COMPLETED"));

    expect(dispatched.map((input) => input.type)).toEqual(["PAUSE", "RESUME"]);
    expect((await jobs.listStages("tenant-demo", job.id))[0]?.status).toBe("DONE");
  });

  it("分步下发前作业被暂停时停止推进并在分步留痕，不再下发后续步骤", async () => {
    const { jobs, executor, dispatched, waitCommand } = setup();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "",
    });
    for (const stage of buildJobStages("SEEDING", { areaMu: 10, durationMin: 20 })) {
      await jobs.addStage(undefined, { tenantId: "tenant-demo", jobId: job.id, stage: stage.stage, commandType: stage.commandType, parameters: stage.parameters, timeoutMs: stage.timeoutMs });
    }
    // 第一步收口时把作业暂停，模拟安全监测或人工处置抢先改了状态
    waitCommand.mockImplementationOnce(async () => {
      await jobs.updateJob("tenant-demo", job.id, { status: "PAUSED", reason: "人工暂停" });
      return "DONE" as const;
    });

    await executor.run(job);

    const finished = await jobs.findJob("tenant-demo", job.id);
    expect(finished?.status).toBe("PAUSED");
    expect(dispatched.map((input) => input.type)).toEqual(["TOOL_SWITCH"]);
    // 已收口的分步记 DONE，但作业 CAS 发现 PAUSED 后立即退出，不再推进后续步骤
    const stages = await jobs.listStages("tenant-demo", job.id);
    expect(stages[0]!.status).toBe("DONE");
    expect(stages[1]!.status).toBe("PENDING");
  });

  it("下发被拒即收口作业为失败，不继续下一步", async () => {
    const { jobs, executor, dispatch } = setup();
    dispatch.mockResolvedValueOnce(null);
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "TILLAGE",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "",
    });
    await jobs.addStage(undefined, { tenantId: "tenant-demo", jobId: job.id, stage: "TOOL_SWITCH", commandType: "TOOL_SWITCH", parameters: { toolCode: "PLOW" }, timeoutMs: 1000 });
    await executor.run(job);
    const finished = await jobs.findJob("tenant-demo", job.id);
    expect(finished?.status).toBe("FAILED");
    expect(finished?.reason).toContain("下发被拒");
  });

  it("控制侧建单成功后回写崩溃，重试以同一幂等键复用分步指令", async () => {
    const { jobs, executor, dispatched } = setup();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.addStage(undefined, { tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000 });
    vi.spyOn(jobs, "updateStage").mockRejectedValueOnce(new Error("模拟回写前崩溃"));
    await executor.run(job);
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("RUNNING");
    const pendingStage = (await jobs.listStages("tenant-demo", job.id))[0]!;
    expect(pendingStage.status).toBe("PENDING");
    const recovered = await recoveryCommand(pendingStage, async (key) => ({
      id: "cmd-1",
      status: "QUEUED",
      idempotencyKey: key,
    }));
    expect(recovered).toEqual({ id: "cmd-1", status: "QUEUED" });

    await executor.run(job, { started: true });
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]?.idempotencyKey).toBe(`tractor:${job.id}:stage:${(await jobs.listStages("tenant-demo", job.id))[0]!.id}`);
    expect(dispatched[1]?.idempotencyKey).toBe(dispatched[0]?.idempotencyKey);
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("COMPLETED");
  });

  it("控制服务传输故障不终态化作业，恢复扫描可重试", async () => {
    const { jobs, executor, dispatch } = setup();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.addStage(undefined, { tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000 });
    dispatch.mockRejectedValueOnce(new Error("control unavailable"));
    await executor.run(job);
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("RUNNING");
    expect((await jobs.listStages("tenant-demo", job.id))[0]?.status).toBe("PENDING");

    await executor.run(job, { started: true });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("COMPLETED");
  });

  it("过期执行者不能覆盖新租约的作业或分步状态", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-24T00:00:00.000Z"));
      const jobs = new InMemoryTractorJobRepository();
      const job = await jobs.createJob(undefined, {
        tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
        parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
      });
      const stage = await jobs.addStage(undefined, {
        tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
      });
      expect(await jobs.claimJob(job.tenantId, job.id, "owner-a", 1000)).not.toBeNull();
      vi.setSystemTime(new Date("2026-11-24T00:00:02.000Z"));
      expect(await jobs.claimJob(job.tenantId, job.id, "owner-b", 1000)).not.toBeNull();
      expect(await jobs.updateJob(job.tenantId, job.id, { status: "FAILED" }, { expectedStatus: "RUNNING", owner: "owner-a" })).toBeNull();
      expect(await jobs.updateStage(job.tenantId, stage.id, { status: "FAILED" }, { expectedStatus: "PENDING", owner: "owner-a" })).toBeNull();
      expect(await jobs.updateJob(job.tenantId, job.id, { status: "RUNNING" }, { expectedStatus: "PLANNED", owner: "owner-b" })).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("执行租约阻止同一作业并发重复下发", async () => {
    const { jobs, executor, dispatched, waitCommand } = setup();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.addStage(undefined, { tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000 });
    let release!: (result: "DONE") => void;
    waitCommand.mockImplementationOnce(() => new Promise<"DONE">((resolve) => { release = resolve; }));
    const running = executor.run(job);
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    await executor.run(job, { started: true });
    expect(dispatched).toHaveLength(1);
    release("DONE");
    await running;
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("COMPLETED");
  });

  it("急停下发 ESTOP 并留安全事件", async () => {
    const { jobs, safetyEvents, executor, dispatched } = setup();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "WEEDING",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "RUNNING" });
    const stopped = await executor.stop("tenant-demo", job.id, true);
    expect(stopped?.status).toBe("ESTOPPED");
    expect(dispatched[0]!.type).toBe("ESTOP");
    const events = await safetyEvents.list({ tenantId: "tenant-demo", });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "ESTOP", level: "CRITICAL" });
  });

  it("暂停携带 targetCommandId，控制侧 DONE 确认后才写 PAUSED", async () => {
    const { jobs, executor, dispatched, waitCommand } = setup();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "RUNNING" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });

    const stopped = await executor.stop("tenant-demo", job.id, false);
    expect(stopped?.status).toBe("PAUSED");
    expect(dispatched[0]).toMatchObject({ tenantId: "tenant-demo", type: "PAUSE", parameters: { targetCommandId: "cmd-active" } });
    expect(waitCommand).toHaveBeenCalledWith("tenant-demo", "tractor-001", "cmd-1", 30_000);
  });

  it("执行等待期间被暂停时保留 SENT 分步，恢复后继续原指令而不重复下发", async () => {
    const { jobs, executor, dispatched, waitCommand } = setup();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "",
    });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    waitCommand.mockImplementationOnce(async () => {
      await executor.stop("tenant-demo", job.id, false);
      return "PAUSED" as const;
    });

    await executor.run(job);
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("PAUSED");
    expect((await jobs.listStages("tenant-demo", job.id))[0]).toMatchObject({ id: stage.id, status: "SENT", commandId: "cmd-1" });

    await executor.resume("tenant-demo", job.id);
    await vi.waitFor(async () => expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("COMPLETED"));
    expect(dispatched.map((input) => input.type)).toEqual(["SEEDING", "PAUSE", "RESUME"]);
    expect((await jobs.listStages("tenant-demo", job.id))[0]).toMatchObject({ status: "DONE", commandId: "cmd-1" });
  });

  it("暂停下发被拒或确认失败时保持 RUNNING，不假称已暂停", async () => {
    const { jobs, executor, dispatch, waitCommand } = setup();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "RUNNING" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });

    dispatch.mockResolvedValueOnce(null);
    await expect(executor.stop("tenant-demo", job.id, false)).rejects.toThrow("状态未变更");
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("RUNNING");

    waitCommand.mockResolvedValueOnce("TIMEOUT");
    await expect(executor.stop("tenant-demo", job.id, false)).rejects.toThrow("确认超时");
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("RUNNING");
  });

  it("恢复只允许 PAUSED，发 RESUME 并复用原分步指令续跑", async () => {
    const { jobs, executor, dispatched, waitCommand } = setup();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "",
    });
    await expect(executor.resume("tenant-demo", job.id)).rejects.toThrow("只有 PAUSED");
    expect(dispatched).toHaveLength(0);

    await jobs.updateJob("tenant-demo", job.id, { status: "PAUSED" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });
    const resumed = await executor.resume("tenant-demo", job.id);
    expect(resumed.status).toBe("RUNNING");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ type: "RESUME", parameters: { targetCommandId: "cmd-active" } });
    await vi.waitFor(async () => expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("COMPLETED"));
    expect(dispatched.map((input) => input.type)).toEqual(["RESUME"]);
    expect(waitCommand).toHaveBeenCalledWith("tenant-demo", "tractor-001", "cmd-active", 1000);
  });

  it("RESUME 确认超时且急停未确认时转入 SAFETY_UNKNOWN，不假称仍暂停", async () => {
    const { jobs, safetyEvents, executor, dispatched, waitCommand } = setup();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "PAUSED" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });
    waitCommand.mockResolvedValueOnce("TIMEOUT").mockResolvedValueOnce("TIMEOUT");

    await expect(executor.resume("tenant-demo", job.id)).rejects.toThrow("SAFETY_UNKNOWN");
    expect(dispatched.map((input) => input.type)).toEqual(["RESUME", "ESTOP"]);
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("SAFETY_UNKNOWN");
    expect((await safetyEvents.list({ tenantId: "tenant-demo" }))[0]).toMatchObject({ kind: "ESTOP", level: "CRITICAL" });
  });

  it("RESUME 确认超时但随后急停确认时收口为 ESTOPPED", async () => {
    const { jobs, executor, dispatched, waitCommand } = setup({
      commandOf: async (_tenant, commandId) => ({ status: commandId === "cmd-active" ? "PAUSED" : "ACKED" }),
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "PAUSED" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });
    waitCommand.mockResolvedValueOnce("TIMEOUT").mockResolvedValueOnce("DONE");

    await expect(executor.resume("tenant-demo", job.id)).rejects.toThrow("ESTOPPED");
    expect(dispatched.map((input) => input.type)).toEqual(["RESUME", "ESTOP"]);
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("ESTOPPED");
  });

  it("RESUME 确认超时且仍在排队时先取消恢复，再下发急停", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatched: ControlDispatchInput[] = [];
    const actions: string[] = [];
    let resumeStatus = "QUEUED";
    const cancelCommand = vi.fn(async () => {
      actions.push("cancel");
      resumeStatus = "CANCELLED";
      return true;
    });
    const executor = createJobExecutor({
      jobs,
      safetyEvents,
      dispatch: async (input) => {
        actions.push(`dispatch:${input.type}`);
        dispatched.push(input);
        return { commandId: input.type === "RESUME" ? "cmd-resume" : "cmd-estop" };
      },
      waitCommand: async (_tenant, _device, commandId): Promise<"DONE" | "TIMEOUT"> => commandId === "cmd-resume" ? "TIMEOUT" : "DONE",
      commandOf: async (_tenant, commandId) => ({ status: commandId === "cmd-active" ? "PAUSED" : resumeStatus }),
      cancelCommand,
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "PAUSED" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });

    await expect(executor.resume("tenant-demo", job.id)).rejects.toThrow("ESTOPPED");
    expect(dispatched.map((input) => input.type)).toEqual(["RESUME", "ESTOP"]);
    expect(cancelCommand).toHaveBeenCalledWith("tenant-demo", "cmd-resume", expect.stringContaining("撤销排队恢复"));
    expect(actions.indexOf("cancel")).toBeLessThan(actions.indexOf("dispatch:ESTOP"));
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("ESTOPPED");
  });

  it("RESUME 明确被控制侧拒绝时保持 PAUSED，不升级急停", async () => {
    const { jobs, executor, dispatch } = setup();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "PAUSED" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });
    dispatch.mockResolvedValueOnce(null);

    await expect(executor.resume("tenant-demo", job.id)).rejects.toThrow("下发被控制侧拒绝");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0].type).toBe("RESUME");
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("PAUSED");
  });

  it.each(["false", "throw", "still-queued"] as const)("RESUME 取消结果%s时不收口为 ESTOPPED", async (mode) => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatched: ControlDispatchInput[] = [];
    let resumeStatus = "QUEUED";
    const cancelCommand = vi.fn(async () => {
      if (mode === "throw") throw new Error("cancel unavailable");
      if (mode === "false") return false;
      if (mode === "still-queued") return true;
      resumeStatus = "CANCELLED";
      return true;
    });
    const executor = createJobExecutor({
      jobs, safetyEvents,
      dispatch: async (input) => {
        dispatched.push(input);
        return { commandId: input.type === "RESUME" ? "cmd-resume" : "cmd-estop" };
      },
      waitCommand: async (_tenant, _device, commandId): Promise<"DONE" | "TIMEOUT"> => commandId === "cmd-resume" ? "TIMEOUT" : "DONE",
      commandOf: async (_tenant, commandId) => ({ status: commandId === "cmd-active" ? "PAUSED" : resumeStatus }),
      cancelCommand,
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "PAUSED" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });

    await expect(executor.resume("tenant-demo", job.id)).rejects.toThrow("SAFETY_UNKNOWN");
    expect(dispatched.map((input) => input.type)).toEqual(["RESUME", "ESTOP"]);
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("SAFETY_UNKNOWN");
  });

  it("RESUME 下发响应丢失后按幂等键找回，证实设备已接收才急停收口", async () => {
    const commandByIdempotencyKey = vi.fn(async () => ({ id: "cmd-resume", status: "ACKED" }));
    const { jobs, executor, dispatched, dispatch } = setup({
      commandByIdempotencyKey,
      commandOf: async (_tenant, commandId) => ({ status: commandId === "cmd-active" ? "PAUSED" : "ACKED" }),
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "PAUSED" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });
    let resumeKey = "";
    dispatch.mockImplementationOnce(async (input) => {
      resumeKey = input.idempotencyKey!;
      throw new Error("response lost");
    });

    await expect(executor.resume("tenant-demo", job.id)).rejects.toThrow("ESTOPPED");
    expect(commandByIdempotencyKey).toHaveBeenCalledWith("tenant-demo", resumeKey);
    expect(dispatched.map((input) => input.type)).toEqual(["ESTOP"]);
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("ESTOPPED");
  });

  it("RESUME 仍为 SENT 时不能证明不会补发，急停后保持 SAFETY_UNKNOWN", async () => {
    const { jobs, executor, dispatched, waitCommand } = setup({
      commandByIdempotencyKey: async () => ({ id: "cmd-resume", status: "SENT" }),
      commandOf: async (_tenant, commandId) => ({ status: commandId === "cmd-active" ? "PAUSED" : "SENT" }),
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "PAUSED" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });
    waitCommand.mockResolvedValueOnce("TIMEOUT").mockResolvedValueOnce("DONE");

    await expect(executor.resume("tenant-demo", job.id)).rejects.toThrow("SAFETY_UNKNOWN");
    expect(dispatched.map((input) => input.type)).toEqual(["RESUME", "ESTOP"]);
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("SAFETY_UNKNOWN");
  });

  it("RESUME 下发前先持久化恢复意图，成功后清除", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const updateSpy = vi.spyOn(jobs, "updateJob");
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    let persistedBeforeDispatch = false;
    let jobId = "";
    const executor = createJobExecutor({
      jobs, safetyEvents,
      dispatch: async () => {
        const current = await jobs.findJob("tenant-demo", jobId);
        persistedBeforeDispatch = current?.parameters.pendingResume !== undefined;
        return { commandId: "cmd-resume" };
      },
      waitCommand: async () => "DONE",
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    jobId = job.id;
    await jobs.updateJob("tenant-demo", job.id, { status: "PAUSED" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });

    await executor.resume("tenant-demo", job.id);

    expect(persistedBeforeDispatch).toBe(true);
    const runningWrite = updateSpy.mock.calls.find((call) => call[2]?.status === "RUNNING");
    expect(runningWrite?.[2].parameters?.pendingResume).toBeUndefined();
    expect((await jobs.findJob("tenant-demo", job.id))?.parameters.pendingResume).toBeUndefined();
  });

  it("两个实例并发恢复时只有一个能持久化并下发 RESUME", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatched: ControlDispatchInput[] = [];
    let entered = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => { release = resolve; });
    const beforeStage = vi.fn(async () => {
      entered += 1;
      if (entered === 2) release();
      await bothEntered;
      return { passed: true };
    });
    const makeExecutor = () => createJobExecutor({
      jobs, safetyEvents, beforeStage,
      dispatch: async (input) => { dispatched.push(input); return { commandId: `cmd-resume-${dispatched.length}` }; },
      waitCommand: async () => "DONE",
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "PAUSED" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });

    const results = await Promise.allSettled([makeExecutor().resume("tenant-demo", job.id), makeExecutor().resume("tenant-demo", job.id)]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(dispatched.map((input) => input.type)).toEqual(["RESUME"]);
    expect((await jobs.findJob("tenant-demo", job.id))?.parameters.pendingResume).toBeUndefined();
  });

  it("重启恢复对账带恢复意图的 PAUSED 作业并急停", async () => {
    const { jobs, executor, dispatched, waitCommand } = setup({
      commandByIdempotencyKey: async () => ({ id: "cmd-resume", status: "ACKED" }),
      commandOf: async (_tenant, commandId) => ({ status: commandId === "cmd-active" ? "PAUSED" : "ACKED" }),
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1, pendingResume: { idempotencyKey: "tractor:job-crash:safety:RESUME:key", targetCommandId: "cmd-active", requestedAt: new Date().toISOString() } },
      operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "PAUSED" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });
    waitCommand.mockResolvedValue("DONE");

    await recoverUnfinishedJobs({ tenantId: "tenant-demo", jobs, executor });

    expect(dispatched.map((input) => input.type)).toEqual(["ESTOP"]);
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("ESTOPPED");
  });

  it("重启恢复持续对账 SAFETY_UNKNOWN，RESUME 证实不可下发后才收口", async () => {
    let resumeStatus = "SENT";
    const { jobs, executor, dispatched } = setup({
      commandByIdempotencyKey: async () => ({ id: "cmd-resume", status: resumeStatus }),
      commandOf: async (_tenant, commandId) => ({ status: commandId === "cmd-active" ? "PAUSED" : resumeStatus }),
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1, pendingResume: { idempotencyKey: "tractor:job-unknown:safety:RESUME:key", targetCommandId: "cmd-active", requestedAt: new Date().toISOString() } },
      operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "SAFETY_UNKNOWN" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });
    await jobs.updateStage("tenant-demo", stage.id, { status: "FAILED", detail: "并发收口失败" }, { expectedStatus: "SENT" });

    await recoverUnfinishedJobs({ tenantId: "tenant-demo", jobs, executor });
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("SAFETY_UNKNOWN");

    resumeStatus = "ACKED";
    await recoverUnfinishedJobs({ tenantId: "tenant-demo", jobs, executor });
    expect(dispatched.map((input) => input.type)).toEqual(["ESTOP", "ESTOP"]);
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("ESTOPPED");
    expect((await jobs.findJob("tenant-demo", job.id))?.parameters.pendingResume).toBeUndefined();
  });

  it("重启恢复对账无恢复意图的旧 SAFETY_UNKNOWN 作业并持续急停", async () => {
    const { jobs, executor, dispatched } = setup();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "SAFETY_UNKNOWN", reason: "旧版恢复结果未知" });

    await recoverUnfinishedJobs({ tenantId: "tenant-demo", jobs, executor });
    await recoverUnfinishedJobs({ tenantId: "tenant-demo", jobs, executor });

    expect(dispatched.map((input) => input.type)).toEqual(["ESTOP", "ESTOP"]);
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("SAFETY_UNKNOWN");
  });

  it("RESUME 下发响应丢失且无法找回时保持 SAFETY_UNKNOWN", async () => {
    const { jobs, executor, dispatch } = setup({
      commandByIdempotencyKey: async () => null,
      commandOf: async (_tenant, commandId) => {
        if (commandId === "cmd-active") return { status: "PAUSED" };
        throw new Error("control unavailable");
      },
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "PAUSED" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });
    dispatch.mockRejectedValueOnce(new Error("response lost"));

    await expect(executor.resume("tenant-demo", job.id)).rejects.toThrow("SAFETY_UNKNOWN");
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("SAFETY_UNKNOWN");
  });

  it("暂停确认期间发生并发急停，CAS 不把 ESTOPPED 覆盖回 PAUSED", async () => {
    const { jobs, executor, waitCommand } = setup();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "RUNNING" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });
    waitCommand.mockImplementationOnce(async () => {
      await jobs.updateJob("tenant-demo", job.id, { status: "ESTOPPED", reason: "并发急停" });
      return "DONE" as const;
    });

    await expect(executor.stop("tenant-demo", job.id, false)).rejects.toThrow("状态已变化");
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("ESTOPPED");
  });

  it("分步超时前发生并发急停，迟到的 FAILED 不覆盖 ESTOPPED", async () => {
    const { jobs, executor, waitCommand } = setup();
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "",
    });
    await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    waitCommand.mockImplementationOnce(async () => {
      await jobs.updateJob("tenant-demo", job.id, { status: "ESTOPPED", reason: "并发急停" });
      return "TIMEOUT" as const;
    });

    await executor.run(job);
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("ESTOPPED");
  });
});

describe("未完成作业恢复", () => {
  it("服务重启后续跑 PLANNED 与 RUNNING，不自动恢复暂停或终态", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const input = { tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING" as const, parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "" };
    const planned = await jobs.createJob(undefined, input);
    const running = await jobs.createJob(undefined, input);
    const paused = await jobs.createJob(undefined, input);
    const completed = await jobs.createJob(undefined, input);
    await jobs.createJob(undefined, { ...input, tenantId: "tenant-other" });
    await jobs.updateJob("tenant-demo", running.id, { status: "RUNNING" });
    await jobs.updateJob("tenant-demo", paused.id, { status: "PAUSED" });
    await jobs.updateJob("tenant-demo", completed.id, { status: "COMPLETED" });
    const run = vi.fn(async () => {});

    await recoverUnfinishedJobs({
      tenantId: "tenant-demo",
      jobs,
      executor: { run, stop: async () => null, resume: async () => { throw new Error("未使用"); } },
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: planned.id }), undefined);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: running.id }), { started: true });
  });

  it("恢复扫描不绕过执行器安全门，未通过预检也必须进入处置闭环", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatched: ControlDispatchInput[] = [];
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    const executor = createJobExecutor({
      jobs,
      safetyEvents,
      beforeStage: async () => ({ passed: false, commandId: "cmd-orphan" }),
      dispatch: async (input) => { dispatched.push(input); return { commandId: "cmd-pause" }; },
      waitCommand: async () => "DONE",
    });

    await recoverUnfinishedJobs({
      tenantId: "tenant-demo", jobs, executor,
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ type: "PAUSE", parameters: { targetCommandId: "cmd-orphan" } });
    expect((await jobs.listStages("tenant-demo", job.id))[0]).toMatchObject({ id: stage.id, status: "SENT", commandId: "cmd-orphan" });
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("PAUSED");
  });

  it("不同设备的恢复并行执行，首个长作业不会阻塞后续作业", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const input = { tenantId: "tenant-demo", plotCode: "P-1", operationType: "SEEDING" as const, parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "" };
    const first = await jobs.createJob(undefined, { ...input, deviceId: "tractor-001" });
    const second = await jobs.createJob(undefined, { ...input, deviceId: "tractor-002" });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const run = vi.fn(async (job: { id: string }) => {
      if (job.id === first.id) await firstBlocked;
    });
    const recovery = recoverUnfinishedJobs({
      tenantId: "tenant-demo", jobs,
      executor: { run, stop: async () => null, resume: async () => { throw new Error("未使用"); } },
    });
    try {
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: second.id }), undefined);
    } finally {
      releaseFirst();
      await recovery;
    }
  });

  it("恢复扫描翻页覆盖超过 400 条未完成作业", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const input = { tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING" as const, parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "" };
    for (let index = 0; index < 401; index += 1) await jobs.createJob(undefined, input);
    const run = vi.fn(async () => {});
    await recoverUnfinishedJobs({
      tenantId: "tenant-demo", jobs,
      executor: { run, stop: async () => null, resume: async () => { throw new Error("未使用"); } },
    });
    expect(run).toHaveBeenCalledTimes(401);
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
    const waitCommand = vi.fn(async (): Promise<"DONE" | "FAILED" | "PAUSED" | "TIMEOUT" | "UNAVAILABLE"> => "DONE");
    const monitor = createTractorMonitor({
      tenantId: "tenant-demo",
      jobs,
      safetyEvents,
      fetchRtk: async () => rtk,
      insideGeofence: async () => true,
      dispatch,
      waitCommand,
      intervalMs: 10_000,
      commLossSeconds: 30,
      rtkHdopMax: 2,
      now: () => new Date("2026-11-20T00:00:00.000Z"),
    });
    return { jobs, safetyEvents, dispatched, dispatch, waitCommand, monitor };
  }

  async function runningJob(jobs: InMemoryTractorJobRepository): Promise<string> {
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "RUNNING" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });
    return job.id;
  }

  it("监测急停与分步下发共享作业锁，急停收口后不再下发新分步", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const withJobAction = createJobActionLock();
    const dispatched: ControlDispatchInput[] = [];
    let releaseEstop!: () => void;
    const estopConfirmed = new Promise<void>((resolve) => { releaseEstop = resolve; });
    const dispatch = vi.fn(async (input: ControlDispatchInput) => {
      dispatched.push(input);
      return { commandId: input.type === "ESTOP" ? "cmd-estop" : "cmd-stage" };
    });
    const waitCommand = vi.fn(async (_tenantId: string, _deviceId: string, commandId: string) => {
      if (commandId === "cmd-estop") await estopConfirmed;
      return "DONE" as const;
    });
    const beforeStage = vi.fn(async () => ({ passed: true }));
    const executor = createJobExecutor({ withJobAction, jobs, safetyEvents, dispatch, waitCommand, beforeStage });
    const monitor = createTractorMonitor({
      withJobAction,
      tenantId: "tenant-demo",
      jobs,
      safetyEvents,
      fetchRtk: async () => null,
      insideGeofence: async () => true,
      dispatch,
      waitCommand,
      now: () => new Date("2026-11-20T00:00:00.000Z"),
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "RUNNING" });
    await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });

    const monitoring = monitor.tick();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    const running = executor.run(job, { started: true });
    expect(beforeStage).not.toHaveBeenCalled();
    releaseEstop();
    await Promise.all([monitoring, running]);

    expect(dispatched.map((input) => input.type)).toEqual(["ESTOP"]);
    expect(beforeStage).not.toHaveBeenCalled();
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("ESTOPPED");
  });

  it("监测分页覆盖超过 50 条 RUNNING 作业，旧作业不会被漏掉", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const fetchRtk = vi.fn(async () => null);
    const monitor = createTractorMonitor({
      tenantId: "tenant-demo", jobs, safetyEvents, fetchRtk,
      insideGeofence: async () => true,
      dispatch: async () => ({ commandId: `cmd-${Math.random()}` }),
      waitCommand: async () => "DONE",
      now: () => new Date("2026-11-20T00:00:00.000Z"),
    });
    const ids: string[] = [];
    for (let index = 0; index < 51; index += 1) {
      const job = await jobs.createJob(undefined, {
        tenantId: "tenant-demo", plotCode: "P-1", deviceId: `tractor-${index}`, operationType: "SEEDING",
        parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
      });
      await jobs.updateJob("tenant-demo", job.id, { status: "RUNNING" });
      ids.push(job.id);
    }

    await monitor.tick();

    expect(fetchRtk).toHaveBeenCalledTimes(51);
    for (const id of ids) expect((await jobs.findJob("tenant-demo", id))?.status).toBe("ESTOPPED");
  });

  it("越界首次暂停、持续越界升级急停", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatched: ControlDispatchInput[] = [];
    const dispatch = vi.fn(async (input: ControlDispatchInput) => {
      dispatched.push(input);
      return { commandId: `cmd-${dispatched.length}` };
    });
    const monitor = createTractorMonitor({
      tenantId: "tenant-demo",
      jobs,
      safetyEvents,
      fetchRtk: async () => ({ hasFix: true, lng: 107.5, lat: 30.9, hdop: 1, recordedAt: "2026-11-20T00:00:00.000Z" }),
      insideGeofence: async () => false,
      dispatch,
      waitCommand: async () => "DONE" as const,
      intervalMs: 10_000,
      now: () => new Date("2026-11-20T00:00:00.000Z"),
    });
    const jobId = await runningJob(jobs);

    await monitor.tick();
    expect(dispatched[0]!.type).toBe("PAUSE");
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("PAUSED");
    expect((await safetyEvents.list({ tenantId: "tenant-demo",  jobId }))[0]?.kind).toBe("GEOFENCE_BREACH");

    await monitor.tick();
    expect(dispatched[1]!.type).toBe("ESTOP");
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("ESTOPPED");
    const events = await safetyEvents.list({ tenantId: "tenant-demo",  jobId });
    expect(events.find((event) => event.kind === "GEOFENCE_BREACH" && event.level === "CRITICAL")).toBeTruthy();
  });

  it("通信失联直接急停收口", async () => {
    const { jobs, safetyEvents, dispatched, monitor } = setup(null);
    const jobId = await runningJob(jobs);
    await monitor.tick();
    expect(dispatched[0]!.type).toBe("ESTOP");
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("ESTOPPED");
    expect((await safetyEvents.list({ tenantId: "tenant-demo",  jobId }))[0]).toMatchObject({ kind: "COMM_LOSS", level: "CRITICAL" });
  });

  it("地块边界查询不可用时不误判越界，也不下发安全处置", async () => {
    const { jobs, safetyEvents, dispatch, monitor } = setup({ hasFix: true, lng: 107.5, lat: 30.9, hdop: 1, recordedAt: "2026-11-20T00:00:00.000Z" });
    const jobId = await runningJob(jobs);
    const unavailable = createTractorMonitor({
      tenantId: "tenant-demo",
      jobs,
      safetyEvents,
      fetchRtk: async () => ({ hasFix: true, lng: 107.5, lat: 30.9, hdop: 1, recordedAt: "2026-11-20T00:00:00.000Z" }),
      insideGeofence: async () => null,
      dispatch,
      waitCommand: async () => "DONE",
      now: () => new Date("2026-11-20T00:00:00.000Z"),
    });
    await unavailable.tick();
    expect(dispatch).not.toHaveBeenCalled();
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("RUNNING");
    expect(await safetyEvents.list({ tenantId: "tenant-demo", jobId })).toHaveLength(0);
    await monitor.stop();
  });

  it("返航阶段不按作业地块围栏误判越界", async () => {
    const { jobs, dispatch, monitor } = setup({ hasFix: true, lng: 107.5, lat: 30.9, hdop: 1, recordedAt: "2026-11-20T00:00:00.000Z" });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "RUNNING" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "RETURN_HOME", commandType: "RETURN_HOME", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-return" }, { expectedStatus: "PENDING" });
    const outside = createTractorMonitor({
      tenantId: "tenant-demo", jobs, safetyEvents: new InMemoryTractorSafetyEventRepository(),
      fetchRtk: async () => ({ hasFix: true, lng: 107.5, lat: 30.9, hdop: 1, recordedAt: "2026-11-20T00:00:00.000Z" }),
      insideGeofence: async () => false,
      dispatch,
      waitCommand: async () => "DONE" as const,
      now: () => new Date("2026-11-20T00:00:00.000Z"),
    });
    await outside.tick();
    expect(dispatch).not.toHaveBeenCalled();
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("RUNNING");
    await monitor.stop();
    await outside.stop();
  });

  it("越界暂停后围栏不可用不清除升级状态，直接急停", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatched: ControlDispatchInput[] = [];
    let inside: boolean | null = false;
    const monitor = createTractorMonitor({
      tenantId: "tenant-demo", jobs, safetyEvents,
      fetchRtk: async () => ({ hasFix: true, lng: 107.5, lat: 30.9, hdop: 1, recordedAt: "2026-11-20T00:00:00.000Z" }),
      insideGeofence: async () => inside,
      dispatch: async (input) => { dispatched.push(input); return { commandId: `cmd-${dispatched.length}` }; },
      waitCommand: async () => "DONE" as const,
      now: () => new Date("2026-11-20T00:00:00.000Z"),
    });
    const jobId = await runningJob(jobs);
    await monitor.tick();
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("PAUSED");
    inside = null;
    await monitor.tick();
    expect(dispatched.map((item) => item.type)).toEqual(["PAUSE", "ESTOP"]);
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("ESTOPPED");
  });

  it("RTK 质量劣化暂停作业", async () => {
    const { jobs, safetyEvents, dispatched, monitor } = setup({ hasFix: true, lng: 107.5, lat: 30.9, hdop: 3.5, recordedAt: "2026-11-20T00:00:00.000Z" });
    const jobId = await runningJob(jobs);
    await monitor.tick();
    expect(dispatched[0]!.type).toBe("PAUSE");
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("PAUSED");
    expect((await safetyEvents.list({ tenantId: "tenant-demo",  jobId }))[0]).toMatchObject({ kind: "RTK_QUALITY" });
  });

  it("同时在越界与偏离观察集的作业去重处理，急停不被覆盖回暂停", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const trajectories = new InMemoryTrajectoryRepository();
    const dispatched: ControlDispatchInput[] = [];
    const dispatch = vi.fn(async (input: ControlDispatchInput) => {
      dispatched.push(input);
      return { commandId: `cmd-${dispatched.length}` };
    });
    let inside = true;
    const monitor = createTractorMonitor({
      tenantId: "tenant-demo",
      jobs, safetyEvents, trajectories,
      fetchRtk: async () => ({ hasFix: true, lng: 107.5, lat: 30.9, hdop: 1, recordedAt: "2026-11-20T00:00:00.000Z" }),
      insideGeofence: async () => inside,
      dispatch,
      waitCommand: async () => "DONE" as const,
      intervalMs: 10_000,
      trajectoryDeviationMaxM: 5,
      now: () => new Date("2026-11-20T00:00:00.000Z"),
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "RUNNING" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });
    await trajectories.create(undefined, {
      jobId: job.id, tenantId: "tenant-demo", plotCode: "P-1", source: "MANUAL",
      path: [[107.0, 30.0], [107.1, 30.0]], totalDistanceM: 0, durationMin: 0, warnings: [],
    });

    // tick 1：界内、偏离轨迹 → 暂停，入偏离观察集
    await monitor.tick();
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("PAUSED");

    // tick 2：已因偏离暂停，再出界直接升级急停；同一 tick 不重复处置
    inside = false;
    await monitor.tick();
    expect(dispatched[1]!.type).toBe("ESTOP");
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("ESTOPPED");

    // tick 3：终态不再处理，更不会被覆盖回暂停
    await monitor.tick();
    expect(dispatched).toHaveLength(2);
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("ESTOPPED");
  });

  it("安全指令下发失败或未确认时不写 PAUSED/ESTOPPED", async () => {
    const { jobs, safetyEvents, dispatch, waitCommand, monitor } = setup({ hasFix: true, lng: 107.5, lat: 30.9, hdop: 3.5, recordedAt: "2026-11-20T00:00:00.000Z" });
    const jobId = await runningJob(jobs);
    dispatch.mockResolvedValueOnce(null);
    await monitor.tick();
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("RUNNING");
    expect(await safetyEvents.list({ tenantId: "tenant-demo", jobId })).toHaveLength(0);

    waitCommand.mockResolvedValueOnce("FAILED");
    await monitor.tick();
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("RUNNING");
    expect(await safetyEvents.list({ tenantId: "tenant-demo", jobId })).toHaveLength(0);
  });

  it("安全指令确认超时后复用同一幂等键，不重复创建暂停指令", async () => {
    const { jobs, dispatched, waitCommand, monitor } = setup({ hasFix: true, lng: 107.5, lat: 30.9, hdop: 3.5, recordedAt: "2026-11-20T00:00:00.000Z" });
    const jobId = await runningJob(jobs);
    waitCommand.mockResolvedValueOnce("TIMEOUT").mockResolvedValueOnce("DONE");

    await monitor.tick();
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("RUNNING");
    await monitor.tick();

    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("PAUSED");
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]?.idempotencyKey).toMatch(/^tractor:.+:monitor:PAUSE:cmd-active:[^:]+:0$/);
    expect(dispatched[1]?.idempotencyKey).toBe(dispatched[0]?.idempotencyKey);
  });

  it("监测下发连续歧义失败时复用同一幂等键，第三次成功才暂停", async () => {
    const { jobs, dispatch, monitor } = setup({ hasFix: true, lng: 107.5, lat: 30.9, hdop: 3.5, recordedAt: "2026-11-20T00:00:00.000Z" });
    const jobId = await runningJob(jobs);
    const keys: string[] = [];
    dispatch.mockImplementation(async (input) => {
      keys.push(input.idempotencyKey!);
      if (keys.length < 3) throw new Error("response lost");
      return { commandId: "cmd-pause" };
    });

    await monitor.tick();
    await monitor.tick();
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("RUNNING");
    await monitor.tick();

    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("PAUSED");
  });

  it("监测只有连续两次明确拒绝后才推进安全指令尝试编号", async () => {
    const { jobs, dispatch, monitor } = setup({ hasFix: true, lng: 107.5, lat: 30.9, hdop: 3.5, recordedAt: "2026-11-20T00:00:00.000Z" });
    const jobId = await runningJob(jobs);
    const keys: string[] = [];
    dispatch.mockImplementation(async (input) => {
      keys.push(input.idempotencyKey!);
      return keys.length <= 2 ? null : { commandId: "cmd-pause" };
    });

    await monitor.tick();
    await monitor.tick();
    await monitor.tick();

    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/:0$/);
    expect(keys[2]).toMatch(/:1$/);
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("PAUSED");
  });

  it("人工急停 SAFETY_UNKNOWN 只确认停车，不把未知 RESUME 收口为 ESTOPPED", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatched: ControlDispatchInput[] = [];
    const executor = createJobExecutor({
      jobs, safetyEvents,
      dispatch: async (input) => { dispatched.push(input); return { commandId: "cmd-estop" }; },
      waitCommand: async () => "DONE",
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "SAFETY_UNKNOWN", reason: "RESUME 结果未知" });

    const stopped = await executor.stop("tenant-demo", job.id, true);

    expect(dispatched.map((input) => input.type)).toEqual(["ESTOP"]);
    expect(stopped).toMatchObject({ status: "SAFETY_UNKNOWN" });
    expect(stopped?.reason).toContain("仍需人工核实");
    expect(stopped?.finishedAt).toBeUndefined();
  });

  it("监测发现未确认恢复意图时急停并保持 SAFETY_UNKNOWN", async () => {
    const { jobs, dispatched, monitor } = setup(null);
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1, pendingResume: { idempotencyKey: "tractor:job-pending:safety:RESUME:key", targetCommandId: "cmd-active", requestedAt: new Date().toISOString() } },
      operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "PAUSED" });

    await monitor.tick();

    expect(dispatched.map((input) => input.type)).toEqual(["ESTOP"]);
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("SAFETY_UNKNOWN");
  });

  it("SAFETY_UNKNOWN 再次急停确认后仍保持未知，等待人工核实 RESUME", async () => {
    const { jobs, safetyEvents, dispatched, monitor } = setup(null);
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "SAFETY_UNKNOWN", reason: "RESUME 结果未知" });

    await monitor.tick();
    await monitor.tick();

    expect(dispatched.map((input) => input.type)).toEqual(["ESTOP", "ESTOP"]);
    expect(dispatched[0]?.idempotencyKey).toMatch(/:0$/);
    expect(dispatched[1]?.idempotencyKey).toMatch(/:1$/);
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("SAFETY_UNKNOWN");
    expect((await safetyEvents.list({ tenantId: "tenant-demo", jobId: job.id }))[0]?.message).toContain("保持 SAFETY_UNKNOWN");
  });

  it("生产对账入口持续急停无意图的旧 SAFETY_UNKNOWN 作业", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatched: ControlDispatchInput[] = [];
    const executor = createJobExecutor({
      jobs, safetyEvents,
      dispatch: async (input) => { dispatched.push(input); return { commandId: `cmd-estop-${dispatched.length}` }; },
      waitCommand: async () => "DONE",
    });
    const monitor = createTractorMonitor({
      tenantId: "tenant-demo", jobs, safetyEvents,
      fetchRtk: async () => null,
      insideGeofence: async () => true,
      dispatch: async (input) => { dispatched.push(input); return { commandId: "cmd-estop" }; },
      waitCommand: async () => "DONE",
      reconcileSafetyUnknown: (job) => executor.resume(job.tenantId, job.id),
    });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "SAFETY_UNKNOWN", reason: "旧版恢复结果未知" });

    await monitor.tick();
    await monitor.tick();

    expect(dispatched.map((input) => input.type)).toEqual(["ESTOP", "ESTOP"]);
    expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("SAFETY_UNKNOWN");
  });

  it("等待控制侧 DONE 期间保持 RUNNING，确认后才暂停并携带目标指令", async () => {
    const { jobs, dispatched, waitCommand, monitor } = setup({ hasFix: true, lng: 107.5, lat: 30.9, hdop: 3.5, recordedAt: "2026-11-20T00:00:00.000Z" });
    const jobId = await runningJob(jobs);
    let release!: (result: "DONE") => void;
    waitCommand.mockImplementationOnce(() => new Promise<"DONE" | "FAILED" | "TIMEOUT">((resolve) => { release = resolve; }));
    const ticking = monitor.tick();
    await vi.waitFor(() => expect(waitCommand).toHaveBeenCalledOnce());
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("RUNNING");
    expect(dispatched[0]).toMatchObject({ type: "PAUSE", parameters: { targetCommandId: "cmd-active" } });

    release("DONE");
    await ticking;
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("PAUSED");
  });

  it("rtkFix=false 视为无效定位并暂停，不继续做位置判定", async () => {
    const { jobs, dispatched, monitor } = setup({ hasFix: false, lng: 107.5, lat: 30.9, hdop: 1, recordedAt: "2026-11-20T00:00:00.000Z" });
    const jobId = await runningJob(jobs);
    await monitor.tick();
    expect(dispatched[0]?.type).toBe("PAUSE");
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("PAUSED");
  });

  it("安全确认期间正常推进分步不阻断已确认的暂停", async () => {
    const { jobs, waitCommand, monitor } = setup({ hasFix: true, lng: 107.5, lat: 30.9, hdop: 3.5, recordedAt: "2026-11-20T00:00:00.000Z" });
    const jobId = await runningJob(jobs);
    waitCommand.mockImplementationOnce(async () => {
      await jobs.updateJob("tenant-demo", jobId, { currentStage: 1 });
      return "DONE" as const;
    });

    await monitor.tick();

    expect((await jobs.findJob("tenant-demo", jobId))).toMatchObject({ status: "PAUSED", currentStage: 1 });
  });

  it("监测确认期间作业暂停后恢复，陈旧安全结果不能覆盖新执行周期", async () => {
    const { jobs, waitCommand, monitor } = setup({ hasFix: true, lng: 107.5, lat: 30.9, hdop: 3.5, recordedAt: "2026-11-20T00:00:00.000Z" });
    const jobId = await runningJob(jobs);
    vi.spyOn(console, "error").mockImplementation(() => {});
    waitCommand.mockImplementationOnce(async () => {
      await jobs.updateJob("tenant-demo", jobId, { status: "PAUSED", reason: "另一实例暂停" });
      await jobs.updateJob("tenant-demo", jobId, { status: "RUNNING", reason: "另一实例恢复" });
      return "DONE" as const;
    });

    await monitor.tick();

    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("RUNNING");
    expect((await jobs.findJob("tenant-demo", jobId))?.reason).toBe("另一实例恢复");
  });

  it("监测暂停确认期间发生并发急停，不把 ESTOPPED 覆盖回 PAUSED", async () => {
    const { jobs, waitCommand, monitor } = setup({ hasFix: true, lng: 107.5, lat: 30.9, hdop: 3.5, recordedAt: "2026-11-20T00:00:00.000Z" });
    const jobId = await runningJob(jobs);
    waitCommand.mockImplementationOnce(async () => {
      await jobs.updateJob("tenant-demo", jobId, { status: "ESTOPPED", reason: "并发急停" });
      return "DONE" as const;
    });
    await monitor.tick();
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("ESTOPPED");
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
    expect(await safetyEvents.list({ tenantId: "tenant-demo", })).toHaveLength(1);

    const passed = { passed: true, tenantId: "tenant-demo", gates: [] };
    precheck.mockResolvedValueOnce(passed);
    const ok = await post(base, "/api/v1/tractor/jobs", {
      plotCode: "P-1", deviceId: "tractor-001", operationType: "TILLAGE", parameters: { areaMu: 10, durationMin: 20 },
    }, headers);
    expect(ok.status).toBe(201);
    const job = (await ok.json() as { data: { status: string; currentStage: number } }).data;
    expect(job).toMatchObject({ status: "PLANNED", currentStage: 0 });
    // 分步计划随作业落库
    const stages = await jobs.listStages("tenant-demo", (await jobs.listJobs({ tenantId: "tenant-demo",}))[0]!.id);
    expect(stages.map((stage) => stage.stage)).toEqual(["TOOL_SWITCH", "OPERATION", "RETURN_HOME"]);
  });

  it("轨迹规划失败不留孤儿作业", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const trajectories = new InMemoryTrajectoryRepository();
    const trajectoryPlanner = vi.fn(async () => {
      throw new Error("地块没有可用边界，无法自动算作业轨迹");
    });
    const base = await start(createTractorHttpServer({ jobs, safetyEvents, trajectories, trajectoryPlanner }));
    const headers = { "x-user-id": "user-1", "x-permissions": "tractor:write" };

    const res = await post(base, "/api/v1/tractor/jobs", {
      plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 },
      implementWidthM: 6,
    }, headers);
    expect(res.status).toBe(400);
    expect((await res.json() as { message: string }).message).toContain("无法自动算作业轨迹");
    // 轨迹规划失败时作业不应落库，避免无分步的孤儿作业
    expect(await jobs.listJobs({ tenantId: "tenant-demo",})).toHaveLength(0);
  });

  it("显式非法轨迹在预检和落库前返回 400，不降级为无轨迹作业", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const precheck = vi.fn(async () => ({ passed: true, tenantId: "tenant-demo", gates: [] }));
    const trajectoryPlanner = vi.fn(async () => null);
    const base = await start(createTractorHttpServer({ jobs, precheck, trajectoryPlanner }));
    const headers = { "x-user-id": "u", "x-permissions": "tractor:write" };
    for (const trajectory of [null, { path: [[107, 30]] }, { path: [[null, 30], [107, 31]] }, "bad"]) {
      const response = await post(base, "/api/v1/tractor/jobs", {
        plotCode: "P-1", deviceId: "d", operationType: "SEEDING",
        parameters: { areaMu: 1, durationMin: 1 }, trajectory,
      }, headers);
      expect(response.status).toBe(400);
    }
    expect(precheck).not.toHaveBeenCalled();
    expect(trajectoryPlanner).not.toHaveBeenCalled();
    expect(await jobs.listJobs({ tenantId: "tenant-demo" })).toHaveLength(0);
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

  it("请求头租户隔离列表、详情、轨迹与暂停/恢复操作，跨租户一律 404", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const trajectories = new InMemoryTrajectoryRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatch = vi.fn(async () => ({ commandId: "cmd-1" }));
    const executor = createJobExecutor({ jobs, safetyEvents, dispatch, waitCommand: async () => "DONE" });
    const precheck = vi.fn(async (input: { tenantId: string }) => ({ passed: true, tenantId: input.tenantId, gates: [] }));
    const base = await start(createTractorHttpServer({ jobs, trajectories, safetyEvents, executor, precheck, trajectoryPlanner: async (input) => input.explicitPath ? trajectoryFromPoints(input.explicitPath) : null }));
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-a", plotCode: "P-1", deviceId: "d", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-a", job.id, { status: "PAUSED" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-a", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-a", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });
    await trajectories.create(undefined, {
      tenantId: "tenant-a", jobId: job.id, plotCode: "P-1", source: "MANUAL", path: [[107, 30], [107.1, 30]],
      totalDistanceM: 100, durationMin: 1, warnings: [],
    });
    await jobs.createJob(undefined, {
      tenantId: "tenant-b", plotCode: "P-1", deviceId: "d", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await safetyEvents.create(undefined, { tenantId: "tenant-a", plotCode: "P-1", deviceId: "d", kind: "ESTOP", level: "CRITICAL", message: "A" });
    await safetyEvents.create(undefined, { tenantId: "tenant-b", plotCode: "P-1", deviceId: "d", kind: "ESTOP", level: "CRITICAL", message: "B" });
    const headers = { "x-user-id": "u", "x-permissions": "tractor:read", "x-tenant-id": "tenant-b" };

    const list = await fetch(`${base}/api/v1/tractor/jobs`, { headers });
    expect((await list.json() as { data: { items: Array<{ tenantId: string }> } }).data.items.map((item) => item.tenantId)).toEqual(["tenant-b"]);
    expect((await fetch(`${base}/api/v1/tractor/jobs/${job.id}`, { headers })).status).toBe(404);
    const stopped = await post(base, `/api/v1/tractor/jobs/${job.id}/stop`, {}, { ...headers, "x-permissions": "tractor:write" });
    expect(stopped.status, await stopped.text()).toBe(404);
    const resumed = await post(base, `/api/v1/tractor/jobs/${job.id}/resume`, {}, { ...headers, "x-permissions": "tractor:write" });
    expect(resumed.status, await resumed.text()).toBe(404);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await trajectories.findByJob("tenant-b", job.id)).toBeNull();

    const own = await fetch(`${base}/api/v1/tractor/jobs/${job.id}`, { headers: { ...headers, "x-tenant-id": "tenant-a" } });
    expect(own.status).toBe(200);
    expect((await own.json() as { data: { trajectory: { tenantId: string } } }).data.trajectory.tenantId).toBe("tenant-a");
    const events = await fetch(`${base}/api/v1/tractor/safety-events`, { headers });
    expect((await events.json() as { data: { items: Array<{ tenantId: string }> } }).data.items.map((item) => item.tenantId)).toEqual(["tenant-b"]);
  });

  it("暂停/恢复接口等待控制确认并下发 PAUSE/RESUME，非 PAUSED 恢复返回 409", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const dispatched: ControlDispatchInput[] = [];
    const executor = createJobExecutor({
      jobs, safetyEvents,
      beforeStage: async (job, stage) => {
        const result = await precheck({
          tenantId: job.tenantId,
          allowCommandId: stage.commandId,
          stageKind: stage.stage,
        });
        return { passed: result.passed };
      },
      dispatch: async (input) => { dispatched.push(input); return { commandId: `cmd-${dispatched.length}` }; },
      waitCommand: async () => "DONE",
    });
    const precheck = vi.fn(async (input: { tenantId: string; allowCommandId?: string; stageKind?: string }) => ({ passed: true, tenantId: input.tenantId, gates: [] }));
    const base = await start(createTractorHttpServer({ jobs, safetyEvents, executor, precheck }));
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "d", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "RUNNING" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });
    const headers = { "x-user-id": "u", "x-permissions": "tractor:write" };

    const paused = await post(base, `/api/v1/tractor/jobs/${job.id}/stop`, {}, headers);
    expect(paused.status).toBe(200);
    expect((await paused.json() as { data: { status: string } }).data.status).toBe("PAUSED");
    expect(dispatched[0]).toMatchObject({ type: "PAUSE", parameters: { targetCommandId: "cmd-active" } });

    const resumed = await post(base, `/api/v1/tractor/jobs/${job.id}/resume`, {}, headers);
    expect(resumed.status).toBe(200);
    expect((await resumed.json() as { data: { status: string } }).data.status).toBe("RUNNING");
    expect(dispatched[1]).toMatchObject({ type: "RESUME", parameters: { targetCommandId: "cmd-active" } });
    expect(precheck).toHaveBeenCalledWith(expect.objectContaining({ allowCommandId: "cmd-active", stageKind: "OPERATION" }));
    await vi.waitFor(async () => expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("COMPLETED"));
    expect((await post(base, `/api/v1/tractor/jobs/${job.id}/resume`, {}, headers)).status).toBe(409);
    expect(dispatched).toHaveLength(2);
  });

  it("HTTP 恢复 PENDING 孤儿不重复预检，由执行器携带在途命令统一过门", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const precheck = vi.fn(async () => { throw new Error("HTTP 不应绕过执行器直接预检"); });
    const beforeStage = vi.fn(async () => ({ passed: true, commandId: "cmd-orphan", commandStatus: "QUEUED" }));
    const dispatch = vi.fn(async () => ({ commandId: "cmd-unexpected" }));
    const executor = createJobExecutor({
      jobs, safetyEvents, beforeStage, dispatch,
      waitCommand: async () => "DONE",
    });
    const base = await start(createTractorHttpServer({ jobs, safetyEvents, executor, precheck }));
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "d", operationType: "SEEDING",
      parameters: { areaMu: 1, durationMin: 1 }, operator: "u", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "PAUSED" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });

    const resumed = await post(base, `/api/v1/tractor/jobs/${job.id}/resume`, {}, { "x-user-id": "u", "x-permissions": "tractor:write" });

    expect(resumed.status, await resumed.text()).toBe(200);
    expect(precheck).not.toHaveBeenCalled();
    expect(beforeStage).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), expect.objectContaining({ id: stage.id, status: "PENDING" }));
    expect(dispatch).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect((await jobs.findJob("tenant-demo", job.id))?.status).toBe("COMPLETED"));
  });

  it("内存建单后段失败时明确返回失败并把作业收口为 FAILED", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const trajectories = new InMemoryTrajectoryRepository();
    const run = vi.fn(async () => {});
    const addStage = jobs.addStage.bind(jobs);
    let calls = 0;
    vi.spyOn(jobs, "addStage").mockImplementation(async (tx, input) => {
      calls += 1;
      if (calls === 2) throw new Error("分步落库失败");
      return addStage(tx, input);
    });
    const base = await start(createTractorHttpServer({
      jobs, trajectories,
      executor: { run, stop: async () => null, resume: async () => { throw new Error("未使用"); } },
      trajectoryPlanner: async (input) => input.explicitPath ? trajectoryFromPoints(input.explicitPath) : null,
    }));
    const res = await post(base, "/api/v1/tractor/jobs", {
      plotCode: "P-1", deviceId: "d", operationType: "SEEDING", parameters: { areaMu: 1, durationMin: 1 }, trajectory: { path: [[107, 30], [107.1, 30]] },
    }, { "x-user-id": "u", "x-permissions": "tractor:write" });
    expect(res.status).toBe(400);
    expect((await res.json() as { message: string }).message).toContain("分步落库失败");
    const records = await jobs.listJobs({ tenantId: "tenant-demo" });
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("FAILED");
    expect(run).not.toHaveBeenCalled();
  });

  it("SQL 组合根的作业、轨迹、分步写入共用同一事务，提交失败不返回成功", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const trajectories = new InMemoryTrajectoryRepository();
    const run = vi.fn(async () => {});
    const createJob = vi.spyOn(jobs, "createJob");
    const addStage = vi.spyOn(jobs, "addStage");
    const createTrajectory = vi.spyOn(trajectories, "create");
    const tx = {} as Tx;
    const transaction = vi.fn(async <T>(handler: (tx: Tx) => Promise<T>): Promise<T> => {
      await handler(tx);
      throw new Error("数据库提交失败");
    });
    const base = await start(createTractorHttpServer({
      jobs, trajectories, transaction,
      executor: { run, stop: async () => null, resume: async () => { throw new Error("未使用"); } },
      trajectoryPlanner: async (input) => input.explicitPath ? trajectoryFromPoints(input.explicitPath) : null,
    }));
    const res = await post(base, "/api/v1/tractor/jobs", {
      plotCode: "P-1", deviceId: "d", operationType: "SEEDING", parameters: { areaMu: 1, durationMin: 1 }, trajectory: { path: [[107, 30], [107.1, 30]] },
    }, { "x-user-id": "u", "x-permissions": "tractor:write" });
    expect(res.status).toBe(400);
    expect(transaction).toHaveBeenCalledOnce();
    expect(createJob.mock.calls.every(([usedTx]) => usedTx === tx)).toBe(true);
    expect(createTrajectory.mock.calls.every(([usedTx]) => usedTx === tx)).toBe(true);
    expect(addStage.mock.calls.every(([usedTx]) => usedTx === tx)).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("安全事件列表按类型筛选，非法类型 400", async () => {
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    await safetyEvents.create(undefined, { tenantId: "tenant-demo", plotCode: "P-1", deviceId: "d", kind: "ESTOP", level: "CRITICAL", message: "急停" });
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

describe("轨迹几何算法", () => {
  it("点到折线距离：在线段上为 0，垂直偏移按纬度换算", () => {
    const path: TrajectoryPoint[] = [[107.0, 30.0], [107.1, 30.0]];
    expect(distanceToPolylineM({ lng: 107.05, lat: 30.0 }, path)).toBe(0);
    // 纬度偏 0.0001 度 ≈ 11 米，远超 5 米门限
    expect(distanceToPolylineM({ lng: 107.05, lat: 30.0001 }, path)).toBeGreaterThan(5);
    // 折线端点之外，距离取到最近端点
    expect(distanceToPolylineM({ lng: 106.9, lat: 30.0 }, path)).toBeGreaterThan(5);
  });

  it("MANUAL 轨迹只现算里程，时长留空", () => {
    const draft = trajectoryFromPoints([[107.0, 30.0], [107.1, 30.0]]);
    expect(draft.source).toBe("MANUAL");
    expect(draft.durationMin).toBe(0);
    expect(draft.totalDistanceM).toBeGreaterThan(0);
  });

  it("AUTO 轨迹从覆盖规划结果转换，带作业带与方向", () => {
    const draft = trajectoryFromCoverage({
      headingDeg: 90, implementWidthM: 6, totalDistanceM: 1200, durationMin: 15,
      warnings: ["覆盖倍数 1.0"],
      path: { coordinates: [[107.0, 30.0], [107.1, 30.0]] },
      lanes: [{ index: 1, pass: 1, coordinates: [[107.0, 30.0], [107.1, 30.0]], lengthM: 1000 }],
    });
    expect(draft.source).toBe("AUTO");
    expect(draft.headingDeg).toBe(90);
    expect(draft.implementWidthM).toBe(6);
    expect(draft.lanes).toHaveLength(1);
  });
});

describe("轨迹跟随偏离监测", () => {
  const PATH: TrajectoryPoint[] = [[107.0, 30.0], [107.1, 30.0]];

  function setup(rtkSample: RtkSample | null) {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const trajectories = new InMemoryTrajectoryRepository();
    const dispatched: ControlDispatchInput[] = [];
    const dispatch = vi.fn(async (input: ControlDispatchInput) => {
      dispatched.push(input);
      return { commandId: `cmd-${dispatched.length}` };
    });
    const monitor = createTractorMonitor({
      tenantId: "tenant-demo",
      jobs, safetyEvents, trajectories,
      fetchRtk: async () => rtkSample,
      insideGeofence: async () => true,
      dispatch,
      waitCommand: async () => "DONE" as const,
      intervalMs: 10_000,
      trajectoryDeviationMaxM: 5,
      now: () => new Date("2026-11-20T00:00:00.000Z"),
    });
    return { jobs, safetyEvents, trajectories, dispatched, monitor };
  }

  async function runningJobWithTrajectory(jobs: InMemoryTractorJobRepository, trajectories: InMemoryTrajectoryRepository): Promise<string> {
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "RUNNING" });
    const stage = await jobs.addStage(undefined, {
      tenantId: "tenant-demo", jobId: job.id, stage: "OPERATION", commandType: "SEEDING", parameters: {}, timeoutMs: 1000,
    });
    await jobs.updateStage("tenant-demo", stage.id, { status: "SENT", commandId: "cmd-active" }, { expectedStatus: "PENDING" });
    await trajectories.create(undefined, {
      jobId: job.id, tenantId: "tenant-demo", plotCode: "P-1", source: "MANUAL",
      path: PATH, totalDistanceM: 0, durationMin: 0, warnings: [],
    });
    return job.id;
  }

  it("围栏边界不可用时仍执行本地轨迹偏离监测", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const trajectories = new InMemoryTrajectoryRepository();
    const dispatch = vi.fn(async () => ({ commandId: "cmd-deviation" }));
    const monitor = createTractorMonitor({
      tenantId: "tenant-demo", jobs, safetyEvents, trajectories,
      fetchRtk: async () => ({ hasFix: true, lng: 107.05, lat: 30.001, hdop: 1, recordedAt: "2026-11-20T00:00:00.000Z" }),
      insideGeofence: async () => null,
      dispatch,
      waitCommand: async () => "DONE",
      trajectoryDeviationMaxM: 5,
      now: () => new Date("2026-11-20T00:00:00.000Z"),
    });
    const jobId = await runningJobWithTrajectory(jobs, trajectories);
    await monitor.tick();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "PAUSE" }));
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("PAUSED");
    expect((await safetyEvents.list({ tenantId: "tenant-demo", jobId }))[0]?.kind).toBe("TRAJECTORY_DEVIATION");
    await monitor.tick();
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("ESTOPPED");
  });

  it("首次偏离暂停、持续偏离升级急停", async () => {
    const { jobs, safetyEvents, trajectories, dispatched, monitor } = setup({ hasFix: true, lng: 107.05, lat: 30.001, hdop: 1, recordedAt: "2026-11-20T00:00:00.000Z" });
    const jobId = await runningJobWithTrajectory(jobs, trajectories);

    await monitor.tick();
    expect(dispatched[0]!.type).toBe("PAUSE");
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("PAUSED");
    expect((await safetyEvents.list({ tenantId: "tenant-demo",  jobId }))[0]).toMatchObject({ kind: "TRAJECTORY_DEVIATION", level: "WARNING" });

    await monitor.tick();
    expect(dispatched[1]!.type).toBe("ESTOP");
    expect((await jobs.findJob("tenant-demo", jobId))?.status).toBe("ESTOPPED");
    const events = await safetyEvents.list({ tenantId: "tenant-demo",  jobId });
    expect(events.find((e) => e.kind === "TRAJECTORY_DEVIATION" && e.level === "CRITICAL")).toBeTruthy();
  });

  it("回轨迹上清零偏离计数，不再触发处置", async () => {
    let rtk = { hasFix: true, lng: 107.05, lat: 30.001, hdop: 1, recordedAt: "2026-11-20T00:00:00.000Z" };
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const trajectories = new InMemoryTrajectoryRepository();
    const dispatched: ControlDispatchInput[] = [];
    const dispatch = vi.fn(async (input: ControlDispatchInput) => {
      dispatched.push(input);
      return { commandId: `cmd-${dispatched.length}` };
    });
    const monitor = createTractorMonitor({
      tenantId: "tenant-demo",
      jobs, safetyEvents, trajectories,
      fetchRtk: async () => rtk,
      insideGeofence: async () => true,
      dispatch,
      waitCommand: async () => "DONE" as const,
      intervalMs: 10_000,
      trajectoryDeviationMaxM: 5,
      now: () => new Date("2026-11-20T00:00:00.000Z"),
    });
    const jobId = await runningJobWithTrajectory(jobs, trajectories);

    await monitor.tick();
    expect(dispatched).toHaveLength(1);

    // RTK 回到轨迹上
    rtk = { hasFix: true, lng: 107.05, lat: 30.0, hdop: 1, recordedAt: "2026-11-20T00:00:00.000Z" };
    await monitor.tick();
    // 无新增下发，偏离计数已清零
    expect(dispatched).toHaveLength(1);
    const events = await safetyEvents.list({ tenantId: "tenant-demo",  jobId, kind: "TRAJECTORY_DEVIATION" });
    expect(events).toHaveLength(1);
  });

  it("无轨迹的作业不做偏离判定", async () => {
    const { jobs, safetyEvents, dispatched, monitor } = setup({ hasFix: true, lng: 107.05, lat: 30.001, hdop: 1, recordedAt: "2026-11-20T00:00:00.000Z" });
    const job = await jobs.createJob(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 }, operator: "user-1", reason: "",
    });
    await jobs.updateJob("tenant-demo", job.id, { status: "RUNNING" });

    await monitor.tick();
    expect(dispatched).toHaveLength(0);
    expect(await safetyEvents.list({ tenantId: "tenant-demo",  jobId: job.id })).toHaveLength(0);
  });
});

describe("作业轨迹 HTTP 接口", () => {
  const savedAuthGuard: string | undefined = process.env.AUTH_GUARD_MODE;

  beforeEach(() => {
    process.env.AUTH_GUARD_MODE = "enforce";
  });

  afterEach(() => {
    if (savedAuthGuard === undefined) delete process.env.AUTH_GUARD_MODE;
    else process.env.AUTH_GUARD_MODE = savedAuthGuard;
  });

  it("手工轨迹规划拒绝越界点、穿出边界的线段和缺失边界", async () => {
    const square: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const planner = createTrajectoryPlanner({
      getPlot: async () => ({ geom: { type: "Polygon", coordinates: [square] } }),
      coveragePlan: async () => null,
    });
    await expect(planner({ tenantId: "tenant-demo", plotCode: "P-1", explicitPath: [[2, 2], [8, 8]] })).resolves.toMatchObject({ source: "MANUAL" });
    await expect(planner({ tenantId: "tenant-demo", plotCode: "P-1", explicitPath: [[2, 5], [12, 5]] })).rejects.toThrow("超出地块边界");
    await expect(planner({ tenantId: "tenant-demo", plotCode: "P-1", explicitPath: [[2, 2], [3, 3]] })).resolves.toBeTruthy();

    const concave: Array<[number, number]> = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]];
    const concavePlanner = createTrajectoryPlanner({
      getPlot: async () => ({ geom: { type: "Polygon", coordinates: [concave] } }),
      coveragePlan: async () => null,
    });
    await expect(concavePlanner({ tenantId: "tenant-demo", plotCode: "P-1", explicitPath: [[2, 8], [8, 2]] })).rejects.toThrow("超出地块边界");

    const missingBoundary = createTrajectoryPlanner({ getPlot: async () => ({ geom: null }), coveragePlan: async () => null });
    await expect(missingBoundary({ tenantId: "tenant-demo", plotCode: "P-1", explicitPath: [[2, 2], [3, 3]] })).rejects.toThrow("没有可用边界");
  });

  it("手工与自动轨迹都拒绝进入 Polygon 内环", async () => {
    const geom = {
      type: "Polygon" as const, srid: 4490,
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
      ],
    };
    const planner = createTrajectoryPlanner({
      getPlot: async () => ({ geom }),
      coveragePlan: async () => ({
        headingDeg: 0, implementWidthM: 2, totalDistanceM: 80, durationMin: 10, warnings: [],
        path: { coordinates: [[2, 5], [8, 5]] }, lanes: [],
      }),
    });
    await expect(planner({ tenantId: "tenant-demo", plotCode: "P-1", explicitPath: [[5, 5], [7, 5]] })).rejects.toThrow("超出地块边界");
    await expect(planner({ tenantId: "tenant-demo", plotCode: "P-1", explicitPath: [[2, 5], [8, 5]] })).rejects.toThrow("超出地块边界");
    await expect(planner({ tenantId: "tenant-demo", plotCode: "P-1", implementWidthM: 2 })).rejects.toThrow("超出地块边界或内环");
  });

  it("直接传轨迹点建 MANUAL 轨迹，路径点挂到作业步并随详情返回", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const trajectories = new InMemoryTrajectoryRepository();
    const trajectoryPlanner = vi.fn(async (input: { explicitPath?: TrajectoryPoint[] }) =>
      input.explicitPath ? trajectoryFromPoints(input.explicitPath) : null,
    );
    const base = await start(createTractorHttpServer({ jobs, safetyEvents, trajectories, trajectoryPlanner }));
    const headers = { "x-user-id": "user-1", "x-permissions": "tractor:write" };

    const path: TrajectoryPoint[] = [[107.0, 30.0], [107.1, 30.0], [107.2, 30.0]];
    const res = await post(base, "/api/v1/tractor/jobs", {
      plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 },
      trajectory: { path },
    }, headers);
    expect(res.status).toBe(201);

    const jobId = (await res.json() as { data: { id: string } }).data.id;
    const trajectory = await trajectories.findByJob("tenant-demo", jobId);
    expect(trajectory).not.toBeNull();
    expect(trajectory!.source).toBe("MANUAL");
    expect(trajectory!.path).toEqual(path);
    expect(trajectory!.durationMin).toBe(20);

    // 路径点挂到 OPERATION 步参数，MQTT 指令载荷带的是路径点
    const stages = await jobs.listStages("tenant-demo", jobId);
    const opStage = stages.find((s) => s.stage === "OPERATION")!;
    expect(opStage.parameters.path).toEqual(path);

    // 作业详情返回轨迹
    const detail = await fetch(`${base}/api/v1/tractor/jobs/${jobId}`, { headers: { "x-user-id": "user-1", "x-permissions": "tractor:read" } });
    const body = (await detail.json() as { data: { trajectory?: { source: string; path: TrajectoryPoint[] } } }).data;
    expect(body.trajectory?.source).toBe("MANUAL");
    expect(body.trajectory?.path).toEqual(path);
  });

  it("传幅宽走 AUTO，trajectoryPlanner 算轨迹落库", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const trajectories = new InMemoryTrajectoryRepository();
    const trajectoryPlanner = vi.fn(async (input: { implementWidthM?: number }) =>
      trajectoryFromCoverage({
        headingDeg: 0, implementWidthM: input.implementWidthM ?? 0,
        totalDistanceM: 1200, durationMin: 15, warnings: [],
        path: { coordinates: [[107.0, 30.0], [107.1, 30.0]] },
        lanes: [{ index: 1, pass: 1, coordinates: [[107.0, 30.0], [107.1, 30.0]], lengthM: 1000 }],
      }),
    );
    const base = await start(createTractorHttpServer({ jobs, safetyEvents, trajectories, trajectoryPlanner }));
    const headers = { "x-user-id": "user-1", "x-permissions": "tractor:write" };

    const res = await post(base, "/api/v1/tractor/jobs", {
      plotCode: "P-1", deviceId: "tractor-001", operationType: "TILLAGE",
      parameters: { areaMu: 10, durationMin: 20 },
      implementWidthM: 6,
    }, headers);
    expect(res.status).toBe(201);

    const jobId = (await res.json() as { data: { id: string } }).data.id;
    const trajectory = await trajectories.findByJob("tenant-demo", jobId);
    expect(trajectory).not.toBeNull();
    expect(trajectory!.source).toBe("AUTO");
    expect(trajectory!.headingDeg).toBe(0);
    expect(trajectory!.implementWidthM).toBe(6);
    expect(trajectory!.lanes).toHaveLength(1);
    expect(trajectory!.durationMin).toBe(20);
    expect(trajectory!.warnings.join("；")).toContain("执行按作业参数 20 分钟");
    const opStage = (await jobs.listStages("tenant-demo", jobId)).find((stage) => stage.stage === "OPERATION")!;
    expect(opStage.parameters.durationMin).toBe(20);
  });

  it("不传轨迹也不传幅宽，不建轨迹", async () => {
    const jobs = new InMemoryTractorJobRepository();
    const safetyEvents = new InMemoryTractorSafetyEventRepository();
    const trajectories = new InMemoryTrajectoryRepository();
    const base = await start(createTractorHttpServer({ jobs, safetyEvents, trajectories }));
    const headers = { "x-user-id": "user-1", "x-permissions": "tractor:write" };

    const res = await post(base, "/api/v1/tractor/jobs", {
      plotCode: "P-1", deviceId: "tractor-001", operationType: "SEEDING",
      parameters: { areaMu: 10, durationMin: 20 },
    }, headers);
    expect(res.status).toBe(201);

    const jobId = (await res.json() as { data: { id: string } }).data.id;
    const trajectory = await trajectories.findByJob("tenant-demo", jobId);
    expect(trajectory).toBeNull();
  });
});
