import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { createOperationHttpServer } from "../src/http.js";
import { conflictsOf, InMemoryTaskRepository } from "../src/task.repository.js";
import type { Task } from "../src/task.repository.js";
import { createWeatherForecastFetcher, weatherConflictsOf } from "../src/weather-conflict.js";
import type { ForecastDaySnapshot } from "../src/weather-conflict.js";

// 本批测试随交付编写，按交付口径未执行（已写未跑）。

const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
  return `http://127.0.0.1:${address.port}`;
}

async function start(options: Parameters<typeof createOperationHttpServer>[0] = {}): Promise<string> {
  return listen(createOperationHttpServer(options));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** 晴好基准日：各要素都在适宜区间，逐用例只改判定要素 */
function day(date: string, extra: Partial<ForecastDaySnapshot> = {}): ForecastDaySnapshot {
  return { date, weather: "晴", tempMin: 12, tempMax: 26, windLevel: 2, windSpeed: 3, rainProbability: 10, rainAmount: 0, ...extra };
}

function taskRow(extra: Partial<Task> & Pick<Task, "id">): Task {
  return { tenantId: "tenant-demo", plotCode: "P-A", type: "IRRIGATION", name: "测试任务", status: "PENDING", createdAt: "2026-11-18T00:00:00.000Z", version: 1, ...extra };
}

describe("weatherConflictsOf 纯函数（方案 8.4/8.7）", () => {
  it("未排时间或时间非法不判，诚实返回空", () => {
    const rainy = [day("2026-11-20", { weather: "中雨", rainProbability: 70 })];
    expect(weatherConflictsOf("IRRIGATION", undefined, undefined, rainy)).toEqual([]);
    expect(weatherConflictsOf("IRRIGATION", "not-a-time", undefined, rainy)).toEqual([]);
  });

  it("灌溉遇明显降雨提示推迟：概率达 50% 或雨量达 8mm 任一命中", () => {
    const byProbability = weatherConflictsOf("IRRIGATION", "2026-11-20T02:00:00Z", undefined, [day("2026-11-20", { weather: "小雨", rainProbability: 50 })]);
    expect(byProbability).toHaveLength(1);
    expect(byProbability[0]!.level).toBe("WARNING");
    expect(byProbability[0]!.reasons.join()).toContain("推迟灌溉");

    const byAmount = weatherConflictsOf("IRRIGATION", "2026-11-20T02:00:00Z", undefined, [day("2026-11-20", { rainProbability: 10, rainAmount: 8 })]);
    expect(byAmount).toHaveLength(1);

    const below = weatherConflictsOf("IRRIGATION", "2026-11-20T02:00:00Z", undefined, [day("2026-11-20", { rainProbability: 49, rainAmount: 7.9 })]);
    expect(below).toEqual([]);
  });

  it("施肥遇雨提示顺延，避免肥料随水流失", () => {
    const hits = weatherConflictsOf("FERTILIZATION", "2026-11-20T02:00:00Z", undefined, [day("2026-11-20", { rainProbability: 60 })]);
    expect(hits[0]!.reasons.join()).toContain("顺延");
  });

  it("喷药大风为 CRITICAL：风速超 8m/s 或风力达 4 级；降雨与高温另给缘由", () => {
    const bySpeed = weatherConflictsOf("SPRAYING", "2026-11-20T02:00:00Z", undefined, [day("2026-11-20", { windSpeed: 8.5 })]);
    expect(bySpeed[0]!.level).toBe("CRITICAL");
    const byLevel = weatherConflictsOf("SPRAYING", "2026-11-20T02:00:00Z", undefined, [day("2026-11-20", { windLevel: 4 })]);
    expect(byLevel[0]!.level).toBe("CRITICAL");

    const mixed = weatherConflictsOf("SPRAYING", "2026-11-20T02:00:00Z", undefined, [day("2026-11-20", { rainProbability: 60, tempMax: 35 })]);
    expect(mixed[0]!.level).toBe("WARNING");
    expect(mixed[0]!.reasons.join()).toContain("冲刷");
    expect(mixed[0]!.reasons.join()).toContain("避开");
  });

  it("耕整/播种/除草遇雨提示泥泞改期，播种低温另提示冻害", () => {
    for (const type of ["TILLAGE", "SEEDING", "WEEDING"] as const) {
      const hits = weatherConflictsOf(type, "2026-11-20T02:00:00Z", undefined, [day("2026-11-20", { rainAmount: 10 })]);
      expect(hits[0]!.reasons.join()).toContain("泥泞");
    }
    const frost = weatherConflictsOf("SEEDING", "2026-11-20T02:00:00Z", undefined, [day("2026-11-20", { tempMin: 5 })]);
    expect(frost[0]!.reasons.join()).toContain("冻害");
  });

  it("计划窗按农场日历日（东八区）与预报求交，窗外不判、命中按日期排序", () => {
    // 20:00Z 已是东八区次日 04:00，窗跨 11-19 与 11-20 两个农场日
    const days = [
      day("2026-11-21", { rainProbability: 80 }),
      day("2026-11-18", { rainProbability: 80 }),
      day("2026-11-20", { rainProbability: 80 }),
      day("2026-11-19", { rainProbability: 80 }),
    ];
    const hits = weatherConflictsOf("IRRIGATION", "2026-11-18T20:00:00Z", "2026-11-19T20:00:00Z", days);
    expect(hits.map((hit) => hit.date)).toEqual(["2026-11-19", "2026-11-20"]);
  });

  it("未给结束时间按开始当日判，晴好日无提示", () => {
    expect(weatherConflictsOf("IRRIGATION", "2026-11-20T02:00:00Z", undefined, [day("2026-11-20")])).toEqual([]);
    expect(weatherConflictsOf("IRRIGATION", "2026-11-20T02:00:00Z", undefined, [day("2026-11-21", { rainProbability: 80 })])).toEqual([]);
  });
});

describe("conflictsOf 时间窗重叠泛化（方案 8.7）", () => {
  const window = { scheduledAt: "2026-11-20T02:00:00Z", scheduledEndAt: "2026-11-20T06:00:00Z" };

  it("无共用资源的重叠也给一条时间窗重叠提示，只提示不阻断", () => {
    const rows = [taskRow({ id: "t-1", plotCode: "P-B", ...window })];
    const hits = conflictsOf({ plotCode: "P-A", ...window }, rows);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.reasons).toEqual(["计划时间窗重叠"]);
  });

  it("同地块/同负责人/同设备命中时给具体缘由", () => {
    const rows = [taskRow({ id: "t-1", assigneeName: "张建国", deviceId: "dev-1", ...window })];
    const hits = conflictsOf({ plotCode: "P-A", assigneeName: "张建国", deviceId: "dev-1", ...window }, rows);
    expect(hits[0]!.reasons).toEqual(["同地块计划时间重叠", "同负责人计划时间重叠", "同设备计划时间重叠，将按队列顺序执行"]);
  });

  it("不重叠、未排时间、已结束、已归档与自身都不提示", () => {
    const rows = [
      taskRow({ id: "t-far", scheduledAt: "2026-11-21T02:00:00Z" }),
      taskRow({ id: "t-unscheduled" }),
      taskRow({ id: "t-done", status: "COMPLETED", ...window }),
      taskRow({ id: "t-archived", deletedAt: "2026-11-18T01:00:00.000Z", ...window }),
      taskRow({ id: "t-self", ...window }),
    ];
    expect(conflictsOf({ id: "t-self", plotCode: "P-A", ...window }, rows)).toEqual([]);
    expect(conflictsOf({ plotCode: "P-A" }, rows)).toEqual([]);
  });
});

describe("operation HTTP 天气冲突接线", () => {
  const rainyDay = day("2026-11-20", { weather: "中雨", rainProbability: 70, rainAmount: 12 });
  const schedule = { scheduledAt: "2026-11-20T02:00:00Z", scheduledEndAt: "2026-11-20T04:00:00Z" };
  const headers = { "content-type": "application/json" };

  async function createTask(base: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Promise<Response> {
    return fetch(`${base}/api/v1/farm-tasks`, { method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) });
  }

  it("创建响应附带 weatherConflicts，身份头透传给预报取数", async () => {
    const seen: Array<Record<string, string>> = [];
    const base = await start({
      tasks: new InMemoryTaskRepository([]),
      fetchWeatherForecast: async (identity) => { seen.push(identity); return [rainyDay]; },
    });
    const created = await createTask(base, { name: "雨前灌溉", plotCode: "P-RAIN", type: "IRRIGATION", ...schedule }, { "x-tenant-id": "tenant-demo", "x-user-id": "user-1" });
    expect(created.status).toBe(201);
    const data = (await created.json()).data;
    expect(data.weatherConflicts).toHaveLength(1);
    expect(data.weatherConflicts[0].reasons.join()).toContain("推迟灌溉");
    expect(data.conflicts).toEqual([]);
    expect(seen[0]).toMatchObject({ "x-tenant-id": "tenant-demo", "x-user-id": "user-1" });
  });

  it("时间窗重叠提示不限共用资源：异地块重叠也进 conflicts，回查端点契约不变", async () => {
    const base = await start({ tasks: new InMemoryTaskRepository([]) });
    await createTask(base, { name: "甲任务", plotCode: "P-A", type: "TILLAGE", ...schedule });
    const second = await createTask(base, { name: "乙任务", plotCode: "P-B", type: "SEEDING", ...schedule });
    const data = (await second.json()).data;
    expect(data.conflicts).toHaveLength(1);
    expect(data.conflicts[0].reasons).toEqual(["计划时间窗重叠"]);
    expect(data.weatherConflicts).toEqual([]);

    const recheck = await fetch(`${base}/api/v1/farm-tasks/${data.id}/conflicts`);
    expect(recheck.status).toBe(200);
    expect((await recheck.json()).data).toHaveLength(1);
  });

  it("预报取数失败或未注入时诚实返回空提示，不假定无冲突也不阻断创建", async () => {
    const failing = await start({ tasks: new InMemoryTaskRepository([]), fetchWeatherForecast: async () => { throw new Error("weather down"); } });
    const created = await createTask(failing, { name: "降级灌溉", plotCode: "P-FAIL", type: "IRRIGATION", ...schedule });
    expect(created.status).toBe(201);
    expect((await created.json()).data.weatherConflicts).toEqual([]);

    const noFetcher = await start({ tasks: new InMemoryTaskRepository([]) });
    const plain = await createTask(noFetcher, { name: "无预报灌溉", plotCode: "P-NONE", type: "IRRIGATION", ...schedule });
    expect((await plain.json()).data.weatherConflicts).toEqual([]);
  });

  it("weather-conflicts 回查：不存在 404，未排时间空数组，排了时间按窗判定", async () => {
    const base = await start({ tasks: new InMemoryTaskRepository([]), fetchWeatherForecast: async () => [rainyDay] });
    expect((await fetch(`${base}/api/v1/farm-tasks/task-ghost/weather-conflicts`)).status).toBe(404);

    const unscheduled = (await (await createTask(base, { name: "未排时间", plotCode: "P-X", type: "IRRIGATION" })).json()).data;
    const empty = await fetch(`${base}/api/v1/farm-tasks/${unscheduled.id}/weather-conflicts`);
    expect(empty.status).toBe(200);
    expect((await empty.json()).data).toEqual([]);

    const scheduled = (await (await createTask(base, { name: "已排时间", plotCode: "P-Y", type: "IRRIGATION", ...schedule })).json()).data;
    const hits = await fetch(`${base}/api/v1/farm-tasks/${scheduled.id}/weather-conflicts`);
    expect(hits.status).toBe(200);
    expect((await hits.json()).data).toHaveLength(1);
  });
});

describe("createWeatherForecastFetcher 取数降级", () => {
  it("正常响应过滤缺测要素行，非法要素整条跳过不补 0", async () => {
    const stub = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { forecast: [rainyRow(), { date: "2026-11-21", weather: "晴", tempMin: null }] } }));
    });
    const base = await listen(stub);
    const fetcher = createWeatherForecastFetcher(base);
    const days = await fetcher({});
    expect(days).toHaveLength(1);
    expect(days![0]).toMatchObject({ date: "2026-11-20", rainProbability: 70 });
  });

  it("非 200、结构非法与连接失败都返回 undefined 由调用方按缺测处理", async () => {
    const bad = createServer((_req, res) => { res.writeHead(500); res.end(); });
    const badBase = await listen(bad);
    expect(await createWeatherForecastFetcher(badBase)({})).toBeUndefined();

    const malformed = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { forecast: "not-an-array" } }));
    });
    const malformedBase = await listen(malformed);
    expect(await createWeatherForecastFetcher(malformedBase)({})).toBeUndefined();

    expect(await createWeatherForecastFetcher("http://127.0.0.1:1")({})).toBeUndefined();
  });
});

function rainyRow(): Record<string, unknown> {
  return { date: "2026-11-20", weather: "中雨", tempMin: 10, tempMax: 18, windLevel: 3, windSpeed: 4, rainProbability: 70, rainAmount: 12 };
}