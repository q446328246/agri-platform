import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryAlertRepository } from "../src/alert.repository.js";
import type { WeatherAlert } from "../src/alert.repository.js";
import { demoAlerts, demoForecastDays, demoForecastHours } from "../src/demo.js";
import { farmDate, farmDateOffset, farmToday } from "../src/farm-time.js";
import { InMemoryForecastRepository } from "../src/forecast.repository.js";
import {
  createEd25519JwtSigner,
  createQWeatherClient,
  estimateRainProbability,
  getQWeatherMapper,
  kmhToMs,
  mapAlertLevel,
  mapDaily,
  mapHourly,
  mapWarning,
  parseWindScale,
  compassToZh,
  toIsoTime,
  type QWeatherDailyItem,
  type QWeatherHourlyItem,
  type QWeatherWarningItem,
  type QWeatherV1DailyItem,
  type QWeatherV1HourlyItem,
  type QWeatherV1AlertItem,
} from "../src/qweather.js";
import { buildQWeatherFromEnv, buildSyncerOptionsFromEnv, createWeatherSyncer } from "../src/sync.js";

// ---------- 单元：纯映射函数 ----------

describe("qweather 字段映射", () => {
  it("windScale \"3-4\" 与 \"≤3\" 归一到整数级，取上界", () => {
    expect(parseWindScale("3-4")).toBe(4);
    expect(parseWindScale("≤3")).toBe(3);
    expect(parseWindScale("5")).toBe(5);
    expect(parseWindScale(undefined)).toBe(0);
  });

  it("km/h → m/s 保留 1 位小数", () => {
    expect(kmhToMs("16")).toBeCloseTo(4.4, 1);
    expect(kmhToMs("0")).toBe(0);
    expect(kmhToMs(undefined)).toBe(0);
  });

  it("rainProbability 按 precip 与 text 估算，晴/中雨/暴雨梯度合理", () => {
    expect(estimateRainProbability("晴", 0)).toBeLessThan(20);
    expect(estimateRainProbability("多云", 0)).toBeGreaterThanOrEqual(15);
    expect(estimateRainProbability("中雨", 10)).toBeGreaterThanOrEqual(80);
    expect(estimateRainProbability("晴", 20)).toBeGreaterThanOrEqual(90);
  });

  it("mapAlertLevel 颜色 → 三级（红/橙→CRITICAL，黄→WARNING，蓝→INFO）", () => {
    expect(mapAlertLevel("红色")).toEqual({ level: "CRITICAL", color: "红" });
    expect(mapAlertLevel("橙色")).toEqual({ level: "CRITICAL", color: "橙" });
    expect(mapAlertLevel("黄色")).toEqual({ level: "WARNING", color: "黄" });
    expect(mapAlertLevel("蓝色")).toEqual({ level: "INFO", color: "蓝" });
  });

  it("toIsoTime 兼容和风带时区偏移的字符串", () => {
    expect(toIsoTime("2026-11-06T15:00+08:00")).toBe("2026-11-06T07:00:00.000Z");
    expect(toIsoTime("2026-11-06T07:00:00.000Z")).toBe("2026-11-06T07:00:00.000Z");
  });

  it("mapDaily 覆盖 windSpeed/level/rainProbability 与 refreshedAt", () => {
    const item: QWeatherDailyItem = {
      fxDate: "2026-11-06",
      tempMax: "31",
      tempMin: "21",
      textDay: "多云",
      windDirDay: "东南风",
      windScaleDay: "3-4",
      windSpeedDay: "16",
      precip: "0.0",
      humidity: "60",
    };
    const mapped = mapDaily(item, "达州市", "2026-11-06T00:00:00.000Z");
    expect(mapped.date).toBe("2026-11-06");
    expect(mapped.city).toBe("达州市");
    expect(mapped.weather).toBe("多云");
    expect(mapped.tempMax).toBe(31);
    expect(mapped.tempMin).toBe(21);
    expect(mapped.windLevel).toBe(4);
    expect(mapped.windSpeed).toBeCloseTo(4.4, 1);
    expect(mapped.rainProbability).toBeGreaterThanOrEqual(15);
    expect(mapped.refreshedAt).toBe("2026-11-06T00:00:00.000Z");
  });

  it("mapHourly 幂等 id 按 hourAt 生成，pop 存在时优先使用", () => {
    const item: QWeatherHourlyItem = {
      fxTime: "2026-11-06T15:00+08:00",
      temp: "24",
      text: "小雨",
      windDir: "南风",
      windSpeed: "8",
      humidity: "80",
      precip: "1.2",
      pop: "65",
    };
    const hourly = mapHourly(item, "2026-11-06T00:00:00.000Z");
    expect(hourly.hourAt).toBe("2026-11-06T07:00:00.000Z");
    expect(hourly.id).toBe("wx-hour-qw-2026-11-06T07:00:00.000Z");
    expect(hourly.rainProbability).toBe(65);
    expect(hourly.windSpeed).toBeCloseTo(2.2, 1);
    expect(hourly.temperature).toBe(24);
  });

  it("mapWarning type 编码映射 + status=Cancel → active=false", () => {
    const item: QWeatherWarningItem = {
      id: "H1131000001471412",
      pubTime: "2026-11-06T10:00+08:00",
      startTime: "2026-11-06T10:00+08:00",
      endTime: "2026-11-07T10:00+08:00",
      status: "Update",
      level: "橙色",
      type: "05",
      title: "四川省达州市发布大风橙色预警",
      text: "阵风可达 8 级...",
    };
    const alert = mapWarning(item, "达州市");
    expect(alert.alertCode).toBe("QW-H1131000001471412");
    expect(alert.alertType).toBe("WIND");
    expect(alert.level).toBe("CRITICAL");
    expect(alert.color).toBe("橙");
    expect(alert.active).toBe(true);
    expect(alert.expiresAt).toBe("2026-11-07T02:00:00.000Z");

    const cancelled = mapWarning({ ...item, status: "Cancel" }, "达州市");
    expect(cancelled.active).toBe(false);
  });
});

// ---------- 农场时区取日 ----------

describe("farm-time", () => {
  it("farmDate 固定按东八区取日，不受宿主时区影响", () => {
    // 容器时区为 UTC：11-08T20:00Z 已是农场 11-09 凌晨
    expect(farmDate("2026-11-08T20:00:00.000Z")).toBe("2026-11-09");
    expect(farmDate("2026-11-09T15:59:59.000Z")).toBe("2026-11-09");
    expect(farmDate("2026-11-09T16:00:00.000Z")).toBe("2026-11-10");
    expect(farmDate("2026-11-06T15:00+08:00")).toBe("2026-11-06");
    expect(farmDate("2026-11-06")).toBe("2026-11-06");
    expect(farmDate(new Date("2026-11-08T20:00:00.000Z"))).toBe("2026-11-09");
  });

  it("farmDateOffset 跨月跨年按日历日推进，无夏令时漂移", () => {
    const from = new Date("2026-12-30T20:00:00.000Z"); // 农场 12-31
    expect(farmDate(from)).toBe("2026-12-31");
    expect(farmDateOffset(1, from)).toBe("2027-01-01");
    expect(farmDateOffset(7, from)).toBe("2027-01-07");
    expect(farmDateOffset(-1, from)).toBe("2026-12-30");
    expect(farmDateOffset(0, from)).toBe("2026-12-31");
  });

  it("无法解析的输入退回原串前 10 位，farmToday 给出农场当日日历日", () => {
    expect(farmDate("not-a-date")).toBe("not-a-date");
    expect(farmToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(farmToday()).toBe(farmDate(Date.now()));
  });
});

// ---------- 客户端：mock fetch ----------

describe("createQWeatherClient (v7 Deprecated)", () => {
  it("code 非 200 时抛错，方便上层降级", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: "403", daily: [], hourly: [], warning: [] }),
    }));
    const client = createQWeatherClient({ apiVersion: "v7", key: "test-key" }, fetchMock as never);
    await expect(client.fetchDaily(7)).rejects.toThrow(/code=403/);
  });

  it("URL 携带 location + key，默认 host 使用 devapi.qweather.com；天数决定 3d/7d 档位", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: "200", daily: [] }),
    }));
    const client = createQWeatherClient({ apiVersion: "v7", key: "abc", locationId: "101270600" }, fetchMock as never);
    await client.fetchDaily(7);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("https://devapi.qweather.com/v7/weather/7d");
    expect(url).toContain("location=101270600");
    expect(url).toContain("key=abc");

    await client.fetchDaily(3);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/v7/weather/3d");
  });

  it("HTTP 非 2xx 抛错", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const client = createQWeatherClient({ apiVersion: "v7", key: "abc" }, fetchMock as never);
    await expect(client.fetchHourly24()).rejects.toThrow(/HTTP 500/);
  });
});

// ---------- 客户端：v1 ----------

describe("createQWeatherClient (v1)", () => {
  it("默认 apiVersion=v1：基于经纬度拼接 URL，带 X-QW-Api-Key 头", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ days: [] }) }));
    const client = createQWeatherClient({ key: "cred-key", host: "https://ab12cd34.nx.qweatherapi.com", latitude: 31.21, longitude: 107.5 }, fetchMock as never);
    await client.fetchDaily(7);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    const init = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(url).toContain("https://ab12cd34.nx.qweatherapi.com/weather/v1/daily/31.21/107.50");
    expect(url).toContain("days=7");
    expect(init?.headers?.["X-QW-Api-Key"]).toBe("cred-key");

    // v1 每日预报上限 10 天，越界值收敛到边界而不是报错
    await client.fetchDaily(30);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("days=10");
    await client.fetchDaily(0);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("days=1");
  });

  it("提供 jwt 时走 Authorization: Bearer，优先于 key", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ hours: [] }) }));
    const client = createQWeatherClient({ host: "https://ab12cd34.nx.qweatherapi.com", jwt: "jwt-token", key: "fallback-key" }, fetchMock as never);
    await client.fetchHourly24();
    const init = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(init?.headers?.["Authorization"]).toBe("Bearer jwt-token");
    expect(init?.headers?.["X-QW-Api-Key"]).toBeUndefined();
  });

  it("预警走 /weatheralert/v1/current/{lat}/{lon}，返回 alerts 数组", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ alerts: [{ id: "A1" }] }) }));
    const client = createQWeatherClient({ host: "https://ab12cd34.nx.qweatherapi.com", key: "k", latitude: 31.21, longitude: 107.5 }, fetchMock as never);
    const result = await client.fetchWarning();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/weatheralert/v1/current/31.21/107.50");
    expect(result).toEqual([{ id: "A1" }]);
  });

  it("host 命中旧公共域名时 resolve 阶段直接抛错（v1 不支持 devapi/api.qweather.com）", () => {
    expect(() => createQWeatherClient({ host: "https://devapi.qweather.com", key: "k" })).toThrow(/不支持旧公共域名/);
  });

  it("非 2xx 时透回 body 里 error.title/detail", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { title: "Invalid Key", detail: "The provided key is invalid." } }),
    }));
    const client = createQWeatherClient({ host: "https://ab12cd34.nx.qweatherapi.com", key: "bad" }, fetchMock as never);
    await expect(client.fetchDaily(7)).rejects.toThrow(/401 \(Invalid Key\): The provided key is invalid\./);
  });
});

// ---------- v1 映射 ----------

describe("v1 mapper", () => {
  const v1Daily: QWeatherV1DailyItem = {
    forecastStartTime: "2026-11-06T22:00Z",
    forecastEndTime: "2026-11-07T22:00Z",
    temperatureMax: { value: 29.94, unit: "°C" },
    temperatureMin: { value: 20.93, unit: "°C" },
    daytime: {
      condition: { text: "小雨", code: "305" },
      wind: { direction: { degree: 135, compass: "se" }, speed: { value: 3.5, unit: "m/s" }, scale: 3 },
      precipitation: { amount: { value: 4.2, unit: "mm" }, probability: 0.78, type: "rain" },
    },
  };

  it("mapDaily v1：从 daytime 提取温度/风/降水，probability [0,1] → [0,100]，m/s 不变", () => {
    const mapper = getQWeatherMapper("v1");
    const mapped = mapper.mapDaily(v1Daily as unknown as Record<string, unknown>, "达州市", "2026-11-06T00:00:00.000Z");
    // 和风 v1 的 22:00Z 已是农场次日 06:00，取日必须按东八区，否则整周预报前移一天
    expect(mapped.date).toBe("2026-11-07");
    expect(mapped.weather).toBe("小雨");
    expect(mapped.tempMax).toBeCloseTo(29.94, 2);
    expect(mapped.tempMin).toBeCloseTo(20.93, 2);
    expect(mapped.windDirection).toBe("东南");
    expect(mapped.windLevel).toBe(3);
    expect(mapped.windSpeed).toBeCloseTo(3.5, 1);
    expect(mapped.rainProbability).toBe(78);
    expect(mapped.rainAmount).toBeCloseTo(4.2, 1);
  });

  it("mapHourly v1：humidity [0,1] → [0,100]，id 幂等", () => {
    const item: QWeatherV1HourlyItem = {
      forecastTime: "2026-11-06T08:00Z",
      condition: { text: "多云", code: "101" },
      temperature: { value: 26.4, unit: "°C" },
      humidity: 0.72,
      wind: { direction: { degree: 180, compass: "s" }, speed: { value: 2.8, unit: "m/s" }, scale: 2 },
      precipitation: { amount: { value: 0.4, unit: "mm" }, probability: 0.35 },
    };
    const mapped = getQWeatherMapper("v1").mapHourly(item as unknown as Record<string, unknown>, "2026-11-06T00:00:00.000Z");
    expect(mapped.hourAt).toBe("2026-11-06T08:00:00.000Z");
    expect(mapped.humidity).toBeCloseTo(72, 1);
    expect(mapped.temperature).toBeCloseTo(26.4, 1);
    expect(mapped.windSpeed).toBeCloseTo(2.8, 1);
    expect(mapped.rainProbability).toBe(35);
    expect(mapped.id).toBe("wx-hour-qw-2026-11-06T08:00:00.000Z");
  });

  it("mapWarning v1：severity + color + eventType.code 三向映射，messageType=cancel → active=false", () => {
    const alert: QWeatherV1AlertItem = {
      id: "20261106-001",
      issuedTime: "2026-11-06T09:00+08:00",
      messageType: { code: "alert" },
      eventType: { name: "大风", code: "1006" },
      severity: "severe",
      color: { code: "orange" },
      headline: "达州市气象台发布大风橙色预警",
      description: "预计未来 24 小时…",
      expireTime: "2026-11-07T09:00+08:00",
    };
    const mapped = getQWeatherMapper("v1").mapWarning(alert as unknown as Record<string, unknown>, "达州市");
    expect(mapped.alertCode).toBe("QW-20261106-001");
    expect(mapped.alertType).toBe("WIND");
    expect(mapped.level).toBe("CRITICAL");
    expect(mapped.color).toBe("橙");
    expect(mapped.active).toBe(true);
    expect(mapped.title).toContain("大风橙色预警");

    const cancelled = getQWeatherMapper("v1").mapWarning({ ...alert, messageType: { code: "cancel" } } as unknown as Record<string, unknown>, "达州市");
    expect(cancelled.active).toBe(false);
  });

  it("compassToZh 处理 16 方位，未知时原样", () => {
    expect(compassToZh("n")).toBe("北");
    expect(compassToZh("se")).toBe("东南");
    expect(compassToZh("vrb")).toBe("随机");
    expect(compassToZh("unknown_dir")).toBe("unknown_dir");
    expect(compassToZh(undefined)).toBe("");
  });
});

// ---------- 同步器 ----------

describe("createWeatherSyncer", () => {
  let forecasts: InMemoryForecastRepository;
  let alerts: InMemoryAlertRepository;
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    forecasts = new InMemoryForecastRepository({ days: demoForecastDays(), hours: demoForecastHours() });
    alerts = new InMemoryAlertRepository(demoAlerts());
    logger = { info: vi.fn(), warn: vi.fn() };
  });

  function fakeClient(overrides: Partial<{ daily: QWeatherDailyItem[]; hourly: QWeatherHourlyItem[]; warning: QWeatherWarningItem[]; error?: Error }> = {}) {
    const requestedDays: number[] = [];
    return {
      requestedDays,
      fetchDaily: async (days: number) => {
        requestedDays.push(days);
        if (overrides.error) throw overrides.error;
        return overrides.daily ?? [];
      },
      fetchHourly24: async () => {
        if (overrides.error) throw overrides.error;
        return overrides.hourly ?? [];
      },
      fetchWarning: async () => {
        if (overrides.error) throw overrides.error;
        return overrides.warning ?? [];
      },
    };
  }

  it("syncForecastNow 默认拉取今天起 7 天，把 daily 落到 weather_forecasts（同日覆盖、新日追加），并把 hourly upsert", async () => {
    const before = await forecasts.count();
    const today = farmToday();
    const tomorrow = farmDateOffset(1);
    const daily: QWeatherDailyItem[] = [
      { fxDate: today, tempMax: "28", tempMin: "18", textDay: "小雨", windDirDay: "东北风", windScaleDay: "≤3", windSpeedDay: "10", precip: "3.5" },
      { fxDate: tomorrow, tempMax: "24", tempMin: "15", textDay: "晴", windDirDay: "东风", windScaleDay: "3-4", windSpeedDay: "12", precip: "0" },
    ];
    // 时次锚到当前时间的下一个整点，容器时区（UTC）与农场时区不同也不会落到查询窗口外
    const nextHour = new Date(Math.ceil((Date.now() + 3_600_000) / 3_600_000) * 3_600_000).toISOString();
    const hourly: QWeatherHourlyItem[] = [
      { fxTime: nextHour, temp: "22", text: "晴", windDir: "东", windSpeed: "5", humidity: "70", precip: "0", pop: "10" },
    ];
    const client = fakeClient({ daily, hourly });
    const syncer = createWeatherSyncer({ client, mapper: getQWeatherMapper("v7"), forecasts, alerts, city: "达州市", logger });

    await syncer.syncForecastNow();

    expect(client.requestedDays).toEqual([7]);

    const after = await forecasts.count();
    // 今天与 demo 种子同日覆盖，明天若已在 demo 里也是覆盖；至少不应新增超过 2 天
    expect(after).toBeLessThanOrEqual(before + 1);

    const list = await forecasts.upcoming(new Date(), 7);
    const firstDay = list[0];
    expect(firstDay?.date).toBe(today);
    expect(firstDay?.weather).toBe("小雨");
    expect(firstDay?.rainAmount).toBe(3.5);

    const hourList = await forecasts.hourly(new Date(), 24);
    const target = hourList.find((h) => h.hourAt === nextHour);
    expect(target?.weather).toBe("晴");
    expect(target?.rainProbability).toBe(10);

    const stats = syncer.stats();
    expect(stats.dataSource).toBe("qweather");
    expect(stats.forecastSyncCount).toBe(1);
    expect(stats.lastForecastError).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("和风"), expect.objectContaining({ days: 7, daily: 2 }));
  });

  it("forecastDays 可配且收敛到 1~10；同步保留早于今天的旧行，由查询窗口挡掉", async () => {
    const yesterday = farmDateOffset(-1);
    await forecasts.upsertDay({
      date: yesterday, city: "达州市", weather: "阴", tempMin: 12, tempMax: 20,
      windDirection: "北风", windLevel: 2, windSpeed: 3, rainProbability: 10, rainAmount: 0,
      refreshedAt: new Date().toISOString(),
    });
    const client = fakeClient();
    const syncer = createWeatherSyncer({
      client, forecasts, alerts, city: "达州市", logger, forecastDays: 30,
    });
    await syncer.syncForecastNow();
    // v1 每日预报上限 10 天
    expect(client.requestedDays).toEqual([10]);
    expect(forecasts.all().some((row) => row.date === yesterday)).toBe(true);
    const list = await forecasts.upcoming(new Date(), 7);
    expect(list.some((row) => row.date === yesterday)).toBe(false);
    expect(list.every((row) => row.date >= farmToday() && row.date < farmDateOffset(7))).toBe(true);
  });

  it("syncAlertsNow 幂等落库并把和风已撤销的 QW-* 预警自动 deactivate", async () => {
    // 预置一条 QW 前缀且 active 的预警，模拟上一轮同步结果
    const stale: WeatherAlert = {
      id: "stale-1",
      alertCode: "QW-STALE",
      alertType: "RAINSTORM",
      level: "WARNING",
      color: "黄",
      title: "旧的暴雨预警",
      description: "...",
      city: "达州市",
      plotCode: "",
      issuedAt: new Date(Date.now() - 3600_000).toISOString(),
      active: true,
    };
    await alerts.create(undefined, stale);

    const warning: QWeatherWarningItem[] = [
      { id: "NEW-1", pubTime: "2026-11-06T09:00+08:00", endTime: "2026-11-06T18:00+08:00", status: "Update", level: "黄色", type: "05", title: "大风黄色预警", text: "..." },
    ];
    const syncer = createWeatherSyncer({ client: fakeClient({ warning }), forecasts, alerts, city: "达州市", logger });

    await syncer.syncAlertsNow();

    const active = await alerts.list({ activeOnly: true });
    const codes = active.map((a) => a.alertCode);
    expect(codes).toContain("QW-NEW-1");
    expect(codes).not.toContain("QW-STALE");

    // 非 QW- 前缀的演示预警不受影响
    expect(codes.some((c) => c.startsWith("WX-"))).toBe(true);

    const stats = syncer.stats();
    expect(stats.alertSyncCount).toBe(1);
    expect(stats.lastAlertError).toBeUndefined();
  });

  it("客户端抛错时 stats 记录 error 但不抛出，保留旧数据", async () => {
    const syncer = createWeatherSyncer({
      client: fakeClient({ error: new Error("network down") }),
      forecasts,
      alerts,
      city: "达州市",
      logger,
    });
    await expect(syncer.syncForecastNow()).resolves.toBeUndefined();
    await expect(syncer.syncAlertsNow()).resolves.toBeUndefined();

    const stats = syncer.stats();
    expect(stats.dataSource).toBe("local");
    expect(stats.lastForecastError).toContain("network down");
    expect(stats.lastAlertError).toContain("network down");
    expect(logger.warn).toHaveBeenCalled();
    // 旧数据仍在
    expect(await forecasts.count()).toBeGreaterThan(0);
  });

  it("start() 启动时若上次刷新仍在周期内则不发起初次同步，保护免费额度", async () => {
    let forecastCalls = 0;
    let warningCalls = 0;
    const client = {
      fetchDaily: async () => { forecastCalls += 1; return []; },
      fetchHourly24: async () => [],
      fetchWarning: async () => { warningCalls += 1; return []; },
    };
    // 仓储里把 refreshedAt 刷新为 “刚刚”，模拟周期内重启
    const nowIso = new Date().toISOString();
    await forecasts.upsertDay({
      date: "2099-01-01", city: "达州市", weather: "晴", tempMin: 10, tempMax: 20,
      windDirection: "东风", windLevel: 2, windSpeed: 3, rainProbability: 0, rainAmount: 0,
      refreshedAt: nowIso,
    });
    await alerts.create(undefined, {
      id: "recent", alertCode: "QW-RECENT", alertType: "WIND", level: "INFO", color: "蓝",
      title: "刚刚同步的大风预警", description: "...", city: "达州市", plotCode: "",
      issuedAt: nowIso, active: true,
    });
    const syncer = createWeatherSyncer({
      client, forecasts, alerts, city: "达州市", logger,
      forecastRefreshMinutes: 1440, alertRefreshMinutes: 1440,
    });
    syncer.start();
    // start 内部使用 void async，等待微服务队列完成
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    syncer.stop();
    expect(forecastCalls).toBe(0);
    expect(warningCalls).toBe(0);
  });

  it("今日调用达到 dailyCallLimit 时后续 sync 直接跳过，不再请求外部", async () => {
    let calls = 0;
    const client = {
      fetchDaily: async () => { calls += 1; return []; },
      fetchHourly24: async () => [],
      fetchWarning: async () => [],
    };
    const syncer = createWeatherSyncer({
      client, forecasts, alerts, city: "达州市", logger,
      dailyCallLimit: 3,
    });
    for (let i = 0; i < 10; i += 1) await syncer.syncForecastNow();
    expect(calls).toBe(3);
    const stats = syncer.stats();
    expect(stats.todayCalls).toBe(3);
    expect(stats.dailyCallLimit).toBe(3);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("每日和风调用上限"), expect.anything());
  });

  it("跨自然日自动清零今日调用计数", async () => {
    // 使用本地日历日构造时间，避免跨时区测试失效
    let currentDate = new Date(2026, 10, 6, 23, 59, 0);
    let calls = 0;
    const client = {
      fetchDaily: async () => { calls += 1; return []; },
      fetchHourly24: async () => [],
      fetchWarning: async () => [],
    };
    const syncer = createWeatherSyncer({
      client, forecasts, alerts, city: "达州市", logger,
      dailyCallLimit: 2,
      now: () => currentDate,
    });
    await syncer.syncForecastNow();
    await syncer.syncForecastNow();
    expect(calls).toBe(2);
    await syncer.syncForecastNow(); // 上限到达，不发起
    expect(calls).toBe(2);
    currentDate = new Date(2026, 10, 7, 0, 1, 0); // 本地跨天
    await syncer.syncForecastNow();
    expect(calls).toBe(3);
    expect(syncer.stats().todayCalls).toBe(1);
    expect(syncer.stats().callCountDate).toBe("2026-11-07");
  });

  it("forceSync 管理员强制同步 bypass dailyCallLimit，但仍计入 todayCalls 观测", async () => {
    let daily = 0;
    let warning = 0;
    const client = {
      fetchDaily: async () => { daily += 1; return []; },
      fetchHourly24: async () => [],
      fetchWarning: async () => { warning += 1; return []; },
    };
    const syncer = createWeatherSyncer({
      client, forecasts, alerts, city: "达州市", logger,
      dailyCallLimit: 1,
    });
    // 先把定时额度用完
    await syncer.syncForecastNow();
    await syncer.syncForecastNow(); // 上限内不发起
    expect(daily).toBe(1);
    // 管理员强制：bypass 上限，仍能发起
    const result = await syncer.forceSync();
    expect(result.forecast).toBe(true);
    expect(result.alerts).toBe(true);
    expect(daily).toBe(2);
    expect(warning).toBe(1);
    // 手动强制不走上限判定，仍可反复发起
    await syncer.forceSync();
    await syncer.forceSync();
    expect(daily).toBe(4);
    const stats = syncer.stats();
    expect(stats.forceSyncCount).toBe(3);
    expect(stats.lastForceSyncAt).toBeTypeOf("string");
    expect(stats.todayCalls).toBe(4); // 包含手动强制
  });
});

describe("buildSyncerOptionsFromEnv", () => {
  it("未配置时返回空对象，由 createWeatherSyncer 默认采用每日一次、拉取 7 天", () => {
    const options = buildSyncerOptionsFromEnv({});
    expect(options.forecastDays).toBeUndefined();
    expect(options.forecastRefreshMinutes).toBeUndefined();
    expect(options.alertRefreshMinutes).toBeUndefined();
    expect(options.dailyCallLimit).toBeUndefined();
  });

  it("配置时透传为正数，非法值回落 undefined", () => {
    const options = buildSyncerOptionsFromEnv({
      QWEATHER_FORECAST_DAYS: "7",
      QWEATHER_FORECAST_REFRESH_MINUTES: "1440",
      QWEATHER_ALERT_REFRESH_MINUTES: "180",
      QWEATHER_HOURLY_RETAIN_HOURS: "72",
      QWEATHER_DAILY_CALL_LIMIT: "20",
    });
    expect(options.forecastDays).toBe(7);
    expect(options.forecastRefreshMinutes).toBe(1440);
    expect(options.alertRefreshMinutes).toBe(180);
    expect(options.hourlyRetainHours).toBe(72);
    expect(options.dailyCallLimit).toBe(20);

    const bad = buildSyncerOptionsFromEnv({ QWEATHER_FORECAST_DAYS: "0", QWEATHER_FORECAST_REFRESH_MINUTES: "abc", QWEATHER_DAILY_CALL_LIMIT: "-1" });
    expect(bad.forecastDays).toBeUndefined();
    expect(bad.forecastRefreshMinutes).toBeUndefined();
    expect(bad.dailyCallLimit).toBeUndefined();
  });
});

describe("buildQWeatherFromEnv", () => {
  it("QWEATHER_KEY 缺省时返回 undefined，保证零配置时行为与之前一致", () => {
    expect(buildQWeatherFromEnv({})).toBeUndefined();
    expect(buildQWeatherFromEnv({ QWEATHER_KEY: "  " })).toBeUndefined();
  });

  it("v7 旧接口：QWEATHER_API_VERSION=v7 时透出 host / locationId / city（过渡期保留）", () => {
    const result = buildQWeatherFromEnv({
      QWEATHER_API_VERSION: "v7",
      QWEATHER_KEY: "abc",
      QWEATHER_HOST: "https://api.qweather.com",
      QWEATHER_LOCATION_ID: "101010100",
      QWEATHER_CITY: "北京市",
    });
    expect(result?.config.apiVersion).toBe("v7");
    expect(result?.config.host).toBe("https://api.qweather.com");
    expect(result?.config.locationId).toBe("101010100");
    expect(result?.config.city).toBe("北京市");
  });

  it("v1 默认：提供专属 Host 与 Key 时启用，缺 Host 时直接不启动（本地测试无域名场景）", () => {
    const enabled = buildQWeatherFromEnv({
      QWEATHER_KEY: "cred",
      QWEATHER_HOST: "https://ab12cd34.nx.qweatherapi.com",
      QWEATHER_LATITUDE: "31.21",
      QWEATHER_LONGITUDE: "107.5",
    });
    expect(enabled?.config.apiVersion).toBe("v1");
    expect(enabled?.config.latitude).toBe(31.21);
    expect(enabled?.config.longitude).toBe(107.5);

    const noHost = buildQWeatherFromEnv({ QWEATHER_KEY: "cred" });
    expect(noHost).toBeUndefined();

    const legacyHost = buildQWeatherFromEnv({ QWEATHER_KEY: "cred", QWEATHER_HOST: "https://devapi.qweather.com" });
    expect(legacyHost).toBeUndefined();
  });

  it("v1 仅 jwt 也可启动（无 Key 但提供 Bearer 令牌）", () => {
    const result = buildQWeatherFromEnv({
      QWEATHER_JWT: "jwt-token",
      QWEATHER_HOST: "https://ab12cd34.nx.qweatherapi.com",
    });
    expect(result?.config.jwt).toBe("jwt-token");
    expect(result?.config.key).toBeUndefined();
  });
});

// ---------- JWT（Ed25519）签发 ----------

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

function testEd25519Pem(): string {
  return generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey;
}

describe("createEd25519JwtSigner", () => {
  it("签发三段式 JWT，Header 含 alg=EdDSA/kid，Payload 含 iss/sub/iat/exp 且 iat 前移 30 秒", () => {
    const signer = createEd25519JwtSigner({
      keyId: "CRED123",
      developerId: "QABCDEFGHIJ",
      projectId: "PROJ456",
      privateKeyPem: testEd25519Pem(),
    });
    const token = signer();
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    const header = decodeSegment(parts[0] as string);
    expect(header.alg).toBe("EdDSA");
    expect(header.kid).toBe("CRED123");
    const payload = decodeSegment(parts[1] as string);
    expect(payload.iss).toBe("QABCDEFGHIJ");
    expect(payload.sub).toBe("PROJ456");
    const nowSec = Math.floor(Date.now() / 1000);
    expect(payload.iat).toBeLessThanOrEqual(nowSec - 29);
    expect((payload.exp as number) - (payload.iat as number)).toBe(900);
    // 签名为非空 base64url 串
    expect(parts[2]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("可注入固定时间戳且 ttl 可配置，签名确定性", () => {
    const pem = testEd25519Pem();
    const signer = createEd25519JwtSigner({ keyId: "K", developerId: "Q1", projectId: "P1", privateKeyPem: pem, ttlSeconds: 60 });
    const t1 = signer(1_700_000_000_000);
    const t2 = signer(1_700_000_000_000);
    expect(t1).toBe(t2);
    const payload = decodeSegment(t1.split(".")[1] as string);
    expect(payload.iat).toBe(1_700_000_000 - 30);
    expect(payload.exp).toBe(1_700_000_000 - 30 + 60);
  });

  it("非法私钥 PEM 在构造阶段抛错", () => {
    expect(() => createEd25519JwtSigner({ keyId: "K", developerId: "Q1", projectId: "P1", privateKeyPem: "not-a-pem" })).toThrow();
  });
});

describe("createQWeatherClient (v1 JWT signer)", () => {
  it("配置 jwtSigner 时走动态 Bearer，优先于静态 jwt/key，且令牌为三段式", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ days: [] }) }));
    const signer = createEd25519JwtSigner({ keyId: "K", developerId: "Q1", projectId: "P1", privateKeyPem: testEd25519Pem() });
    const client = createQWeatherClient(
      { host: "https://ab12cd34.nx.qweatherapi.com", jwt: "static-should-be-ignored", jwtSigner: signer },
      fetchMock as never,
    );
    await client.fetchDaily(7);
    const init = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    const auth = init?.headers?.["Authorization"] ?? "";
    expect(auth.startsWith("Bearer ")).toBe(true);
    expect(auth.slice(7).split(".")).toHaveLength(3);
    expect(init?.headers?.["X-QW-Api-Key"]).toBeUndefined();
  });
});

describe("buildQWeatherFromEnv (JWT)", () => {
  it("提供内联私钥 + kid/iss/sub + 专属 Host 时注入 jwtSigner", () => {
    const result = buildQWeatherFromEnv({
      QWEATHER_HOST: "https://ab12cd34.nx.qweatherapi.com",
      QWEATHER_KEY_ID: "K",
      QWEATHER_DEVELOPER_ID: "Q1",
      QWEATHER_PROJECT_ID: "P1",
      QWEATHER_PRIVATE_KEY: testEd25519Pem(),
    });
    expect(result?.config.jwtSigner).toBeTypeOf("function");
    expect(result?.config.key).toBeUndefined();
  });

  it("缺 kid/iss/sub 任一项则不构造 signer；若无 key/jwt 则整体不启用", () => {
    const partial = buildQWeatherFromEnv({
      QWEATHER_HOST: "https://ab12cd34.nx.qweatherapi.com",
      QWEATHER_KEY_ID: "K",
      QWEATHER_PRIVATE_KEY: testEd25519Pem(),
    });
    expect(partial).toBeUndefined();
  });

  it("本地无专属 Host 时，即便有完整 JWT 凭据也不启用同步器", () => {
    const noHost = buildQWeatherFromEnv({
      QWEATHER_KEY_ID: "K",
      QWEATHER_DEVELOPER_ID: "Q1",
      QWEATHER_PROJECT_ID: "P1",
      QWEATHER_PRIVATE_KEY: testEd25519Pem(),
    });
    expect(noHost).toBeUndefined();
  });
});
