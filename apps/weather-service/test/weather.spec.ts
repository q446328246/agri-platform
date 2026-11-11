import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import { InMemoryAlertRepository, SqlAlertRepository } from "../src/alert.repository.js";
import type { WeatherAlert } from "../src/alert.repository.js";
import { demoAlerts, demoForecastDays, demoForecastHours } from "../src/demo.js";
import { farmDateOffset, farmToday } from "../src/farm-time.js";
import { InMemoryForecastRepository, SqlForecastRepository } from "../src/forecast.repository.js";
import { createWeatherHttpServer } from "../src/http.js";

/**
 * 天气服务接口验证：今天起七日预报窗口与作业提示、逐小时预报、灾害预警筛选、
 * 气象历史曲线转发遥测读数并做指标白名单校验。
 */

async function withServer(run: (base: string) => Promise<void>, extra: Parameters<typeof createWeatherHttpServer>[0] = {}): Promise<void> {
  const server = createWeatherHttpServer({
    forecasts: new InMemoryForecastRepository({ days: demoForecastDays(), hours: demoForecastHours() }),
    alerts: new InMemoryAlertRepository(demoAlerts()),
    ...extra,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function get(base: string, path: string): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() };
}

describe("天气服务 HTTP 接口", () => {
  it("预报默认今天起七日窗口，带风雨要素与农事作业提示（演示种子只有 5 天）", async () => {
    await withServer(async (base) => {
      const forecast = await get(base, "/api/v1/weather/forecast");
      expect(forecast.status).toBe(200);
      expect(forecast.body.data.location).toBe("达州市");
      expect(forecast.body.data.forecast).toHaveLength(5);
      expect(forecast.body.data.today).toBe(farmToday());
      expect(forecast.body.data.forecast[0].date).toBe(forecast.body.data.today);
      const first = forecast.body.data.forecast[0];
      expect(Object.keys(first)).toEqual(expect.arrayContaining(["date", "weather", "tempMin", "tempMax", "windDirection", "windLevel", "windSpeed", "rainProbability", "rainAmount"]));
      // 第三日为明显降雨日，用于触发「暂缓灌溉」类提示
      const rainyDay = forecast.body.data.forecast[2];
      expect(rainyDay.rainProbability).toBeGreaterThanOrEqual(50);
      expect(typeof forecast.body.data.headline).toBe("string");
      expect(forecast.body.data.headline.length).toBeGreaterThan(0);
      expect(forecast.body.data.judges.map((item: { operation: string }) => item.operation)).toContain("IRRIGATION");

      const days = await get(base, "/api/v1/weather/forecast?days=2");
      expect(days.body.data.forecast).toHaveLength(2);

      const week = await get(base, "/api/v1/weather/forecast?days=7");
      expect(week.body.data.forecast.map((item: { date: string }) => item.date)).toEqual(
        Array.from({ length: 5 }, (_, index) => farmDateOffset(index)),
      );
    });
  });

  it("早于今天与超出窗口的预报行都不返回，旧行仍保留在仓储里", async () => {
    const stale = demoForecastDays(new Date(Date.now() - 10 * 86_400_000));
    const future = demoForecastDays(new Date(Date.now() + 10 * 86_400_000));
    const store = new InMemoryForecastRepository({ days: [...stale, ...demoForecastDays(), ...future] });
    await withServer(async (base) => {
      const res = await get(base, "/api/v1/weather/forecast?days=7");
      const dates: string[] = res.body.data.forecast.map((item: { date: string }) => item.date);
      expect(dates).toEqual(Array.from({ length: 5 }, (_, index) => farmDateOffset(index)));
      expect(dates).not.toContain(stale[0]?.date);
      expect(dates).not.toContain(future[0]?.date);
      expect(await store.count()).toBe(15);
    }, { forecasts: store });
  });

  it("逐小时预报返回未来时次并可用于作业窗口", async () => {
    await withServer(async (base) => {
      const hourly = await get(base, "/api/v1/weather/forecast/hourly?hours=24");
      expect(hourly.status).toBe(200);
      expect(hourly.body.data.hourly).toHaveLength(24);
      const times = hourly.body.data.hourly.map((item: { hourAt: string }) => Date.parse(item.hourAt));
      expect(times.every((value: number, index: number) => index === 0 || value > times[index - 1])).toBe(true);

      const withHours = await get(base, "/api/v1/weather/forecast?hours=12");
      expect(withHours.body.data.hourly).toHaveLength(12);
    });
  });

  it("作业提示按天气形势给出适宜或暂缓结论", async () => {
    await withServer(async (base) => {
      const advice = await get(base, "/api/v1/weather/advice");
      expect(advice.status).toBe(200);
      const irrigation = advice.body.data.items.find((item: { operation: string }) => item.operation === "IRRIGATION");
      // 演示种子当日多云、降雨概率低，不应触发「推迟」；最高温 31°C 超过晴热阈值时转为需注意
      expect(irrigation.suggest === "DELAY").toBe(false);
      expect(irrigation.level === "INFO" || irrigation.level === "WARNING").toBe(true);
      expect(advice.body.data.judges.every((item: { label: string }) => item.label.length > 0)).toBe(true);
    });
  });

  it("预报有降雨时作业提示转为暂缓，并给出排涝准备", async () => {
    // 种子必须锚到真实今天：查询窗口只返回「今天起 N 天」，写死的历史日期会被整体挡掉
    const now = new Date();
    const rainyTomorrow = demoForecastDays(now).map((day, index) => (index === 0 ? { ...day, weather: "中雨", tempMax: 26, rainProbability: 85, rainAmount: 28, windLevel: 4, windSpeed: 9.2 } : day));
    const server = createWeatherHttpServer({
      forecasts: new InMemoryForecastRepository({ days: rainyTomorrow, hours: [] }),
      alerts: new InMemoryAlertRepository(demoAlerts(now)),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/weather/forecast`);
      const body = (await response.json()) as { data: { headline: string; advice: Array<{ operation: string; suggest: string; level: string }>; judges: Array<{ operation: string; suitable: boolean }> } };
      const suggestOf = (operation: string): string => body.data.advice.find((item) => item.operation === operation)?.suggest ?? "";
      expect(suggestOf("IRRIGATION")).toBe("DELAY");
      expect(suggestOf("FERTILIZATION")).toBe("DELAY");
      expect(suggestOf("SPRAYING")).toBe("SUSPEND");
      expect(body.data.judges.find((item) => item.operation === "IRRIGATION")?.suitable).toBe(false);
      expect(body.data.headline.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("灾害预警支持级别与有效性筛选，非法枚举返回 400", async () => {
    await withServer(async (base) => {
      const active = await get(base, "/api/v1/weather/alerts");
      expect(active.status).toBe(200);
      expect(active.body.data.total).toBe(3);
      expect(active.body.data.items.every((item: { active: boolean }) => item.active)).toBe(true);

      const critical = await get(base, "/api/v1/weather/alerts?level=CRITICAL");
      expect(critical.body.data.items).toHaveLength(1);
      expect(critical.body.data.items[0].alertType).toBe("RAINSTORM");

      const windOnly = await get(base, "/api/v1/weather/alerts?alertType=WIND");
      expect(windOnly.body.data.items).toHaveLength(1);

      const all = await get(base, "/api/v1/weather/alerts?active=false");
      expect(all.body.data.total).toBe(4);

      const badLevel = await get(base, "/api/v1/weather/alerts?level=SEVERE");
      expect(badLevel.status).toBe(400);
      expect(badLevel.body.code).toBe("WEATHER-400");

      const badType = await get(base, "/api/v1/weather/alerts?alertType=TSUNAMI");
      expect(badType.status).toBe(400);
    });
  });

  it("气象历史曲线转发遥测读数，指标白名单外返回 400", async () => {
    const readings = [
      { deviceId: "device-weather-001", plotCode: "", metric: "airTemperature", value: 26, unit: "°C", recordedAt: "2026-11-05T01:00:00.000Z" },
      { deviceId: "device-weather-001", plotCode: "", metric: "airTemperature", value: 31, unit: "°C", recordedAt: "2026-11-05T02:00:00.000Z" },
    ];
    const asked: string[] = [];
    await withServer(async (base) => {
      const history = await get(base, "/api/v1/weather/history?metric=airTemperature&from=2026-11-01&to=2026-11-05");
      expect(history.status).toBe(200);
      expect(history.body.data.label).toBe("空气温度");
      expect(history.body.data.points.map((point: { value: number }) => point.value)).toEqual([26, 31]);
      expect(history.body.data.stats).toEqual({ min: 26, max: 31, avg: 28.5, count: 2 });
      expect(asked[0]).toContain("metric=airTemperature");
      // 纯日期按农场东八区日历日转换：from=11-01 起点=10-31T16Z，to=11-05 末尾=11-05T15:59:59.999Z
      expect(asked[0]).toContain(`from=${encodeURIComponent("2026-10-31T16:00:00.000Z")}`);
      expect(asked[0]).toContain(`to=${encodeURIComponent("2026-11-05T15:59:59.999Z")}`);

      const bad = await get(base, "/api/v1/weather/history?metric=stockPrice");
      expect(bad.status).toBe(400);
      expect(bad.body.message).toContain("airTemperature");
    }, {
      telemetryUrl: "http://telemetry.stub",
      fetchReading: async (url: string) => {
        asked.push(url);
        return { data: readings };
      },
    });
  });

  it("历史区间按农场东八区日历日界定，边界外读数不纳入", async () => {
    // 农场 11-01 06:00 = 10-31T22Z（应纳入）；农场 10-31 23:00 = 10-31T15Z（应排除）
    // 农场 11-05 23:00 = 11-05T15Z（应纳入）；农场 11-06 00:00 = 11-05T16Z（应排除）
    const readings = [
      { deviceId: "w", plotCode: "", metric: "airTemperature", value: 99, unit: "°C", recordedAt: "2026-10-31T15:00:00.000Z" },
      { deviceId: "w", plotCode: "", metric: "airTemperature", value: 10, unit: "°C", recordedAt: "2026-10-31T22:00:00.000Z" },
      { deviceId: "w", plotCode: "", metric: "airTemperature", value: 20, unit: "°C", recordedAt: "2026-11-05T15:00:00.000Z" },
      { deviceId: "w", plotCode: "", metric: "airTemperature", value: 88, unit: "°C", recordedAt: "2026-11-05T16:00:00.000Z" },
    ];
    await withServer(async (base) => {
      const history = await get(base, "/api/v1/weather/history?metric=airTemperature&from=2026-11-01&to=2026-11-05");
      expect(history.status).toBe(200);
      expect(history.body.data.points.map((point: { value: number }) => point.value)).toEqual([10, 20]);
      expect(history.body.data.stats.count).toBe(2);
    }, {
      telemetryUrl: "http://telemetry.stub",
      fetchReading: async (url: string) => {
        const params = new URL(url, "http://stub").searchParams;
        const from = params.get("from") ?? "";
        const to = params.get("to") ?? "";
        return { data: readings.filter((row) => (!from || row.recordedAt >= from) && (!to || row.recordedAt <= to)) };
      },
    });
  });

  it("实时读数合并遥测要素，遥测不可用时标记数据源", async () => {
    await withServer(async (base) => {
      const realtime = await get(base, "/api/v1/weather/realtime");
      expect(realtime.status).toBe(200);
      expect(realtime.body.data.dataSource).toBe("telemetry");
      expect(realtime.body.data.stationStatus).toBe("ONLINE");
      const temperature = realtime.body.data.elements.find((item: { key: string }) => item.key === "airTemperature");
      expect(temperature.value).toBe(28);
      expect(temperature.unit).toBe("°C");
    }, {
      telemetryUrl: "http://telemetry.stub",
      fetchReading: async () => ({ data: [{ deviceId: "device-weather-001", plotCode: "", metric: "airTemperature", value: 28, unit: "°C", recordedAt: "2026-11-05T03:00:00.000Z" }] }),
    });

    await withServer(async (base) => {
      const realtime = await get(base, "/api/v1/weather/realtime");
      expect(realtime.body.data.dataSource).toBe("unavailable");
      expect(realtime.body.data.stationStatus).toBe("UNKNOWN");
      expect(realtime.body.data.elements.every((item: { value: unknown }) => item.value === null)).toBe(true);
    }, {
      telemetryUrl: "http://telemetry.stub",
      fetchReading: async () => null,
    });
  });

  it("跨服务读取遥测时透传网关身份头，enforce 部署下才不会被判 401", async () => {
    const seen: Array<Record<string, string>> = [];
    await withServer(async (base) => {
      const identity = { "x-user-id": "user-admin", "x-permissions": "telemetry:read,weather:read", "x-tenant-id": "tenant-demo" };
      const realtime = await fetch(`${base}/api/v1/weather/realtime`, { headers: identity });
      expect(realtime.status).toBe(200);
      const history = await fetch(`${base}/api/v1/weather/history?metric=airTemperature`, { headers: identity });
      expect(history.status).toBe(200);
      expect(seen).toHaveLength(2);
      for (const headers of seen) expect(headers).toMatchObject(identity);
    }, {
      telemetryUrl: "http://telemetry.stub",
      fetchReading: async (_url: string, headers: Record<string, string>) => {
        seen.push(headers);
        return { data: [{ metric: "airTemperature", value: 28, unit: "°C", recordedAt: "2026-11-05T03:00:00.000Z" }] };
      },
    });
  });

  it("要素目录与预警仓储行为符合约定", async () => {
    await withServer(async (base) => {
      const metrics = await get(base, "/api/v1/weather/metrics");
      expect(metrics.status).toBe(200);
      expect(metrics.body.data.map((item: { key: string }) => item.key)).toEqual([
        "airTemperature", "airHumidity", "rainfall", "co2Concentration", "oxygen", "windDirection", "windSpeed", "lightIntensity",
      ]);
    });

    const store = new InMemoryAlertRepository();
    const alert: WeatherAlert = {
      id: "a-1", alertCode: "WX-1", alertType: "FOG", level: "INFO", color: "蓝", title: "大雾", description: "能见度低",
      city: "达州市", plotCode: "", issuedAt: "2026-11-05T00:00:00.000Z", active: true,
    };
    await store.create(undefined, alert);
    await store.create(undefined, alert);
    expect(await store.count()).toBe(1);
    expect(await store.deactivate("WX-1")).toBe(true);
    expect(await store.deactivate("WX-1")).toBe(false);
    // 不传 activeOnly 时返回全部（含已撤销），接口侧默认显式传 activeOnly 过滤
    expect(await store.list()).toHaveLength(1);
    expect(await store.list({ activeOnly: true })).toEqual([]);
  });
});

describe("天气 SQL 仓储行映射", () => {
  function fakeClient(rows: Array<Record<string, unknown>>, executed: unknown[][]): { $queryRawUnsafe: () => Promise<Array<Record<string, unknown>>>; $executeRawUnsafe: (...args: unknown[]) => Promise<number> } {
    return {
      async $queryRawUnsafe() {
        return rows;
      },
      async $executeRawUnsafe(...args: unknown[]) {
        executed.push(args);
        return 1;
      },
    };
  }

  it("预报行映射为接口字段，日期只取日部分", async () => {
    const executed: unknown[][] = [];
    const repository = new SqlForecastRepository(fakeClient([{
      id: "wx-day-1", forecast_date: new Date("2026-11-06T12:00:00.000Z"), city: "达州市", weather: "多云",
      temp_min: 21.0, temp_max: 31.0, wind_direction: "东南风", wind_level: 2, wind_speed: 3.4,
      rain_probability: 24, rain_amount: 0.0, refreshed_at: new Date("2026-11-06T01:00:00.000Z"),
    }], executed) as never);
    const days = await repository.upcoming(new Date("2026-11-06T02:00:00.000Z"), 5);
    expect(days[0]?.date).toBe("2026-11-06");
    expect(days[0]?.tempMax).toBe(31);
    expect(days[0]?.refreshedAt).toBe("2026-11-06T01:00:00.000Z");

    await repository.create(undefined, {
      date: "2026-11-07", city: "达州市", weather: "晴", tempMin: 20, tempMax: 30, windDirection: "北风",
      windLevel: 2, windSpeed: 3, rainProbability: 10, rainAmount: 0, refreshedAt: "2026-11-06T02:00:00.000Z",
    });
    expect(executed.at(-1)?.[0]).toContain("INSERT INTO weather_forecasts");
  });

  it("upcoming 按农场时区界定 [今天, 今天+days) 窗口，SQL 不依赖数据库时区", async () => {
    const queries: unknown[][] = [];
    const repository = new SqlForecastRepository({
      async $queryRawUnsafe(...args: unknown[]) { queries.push(args); return []; },
      async $executeRawUnsafe() { return 0; },
    } as never);
    // 容器时区 UTC：11-08T20:00Z 已是农场 11-09 凌晨
    await repository.upcoming(new Date("2026-11-08T20:00:00.000Z"), 7);
    const args = queries[0] ?? [];
    expect(String(args[0])).toContain("forecast_date >= $1::date AND forecast_date < $2::date");
    expect(args[1]).toBe("2026-11-09");
    expect(args[2]).toBe("2026-11-16");
    expect(args[3]).toBe(7);
  });

  it("逐小时预报按时间升序读取，预警行映射保留可选失效时间", async () => {
    const forecastRepository = new SqlForecastRepository(fakeClient([{
      id: "wx-hour-1", hour_at: new Date("2026-11-06T03:00:00.000Z"), weather: "多云", temperature: 22.5,
      humidity: 68, wind_speed: 3.2, rain_probability: 20, refreshed_at: new Date("2026-11-06T02:00:00.000Z"),
    }], []) as never);
    const hours = await forecastRepository.hourly(new Date("2026-11-06T02:00:00.000Z"), 24);
    expect(hours[0]?.hourAt).toBe("2026-11-06T03:00:00.000Z");
    expect(hours[0]?.rainProbability).toBe(20);

    const alertRepository = new SqlAlertRepository(fakeClient([{
      id: "wx-alert-1", alert_code: "WX-WIND-1", alert_type: "WIND", level: "WARNING", color: "黄", title: "大风",
      description: "阵风 7 级", city: "达州市", plot_code: null, issued_at: new Date("2026-11-06T01:00:00.000Z"), expires_at: null, active: true,
    }], []) as never);
    const list = await alertRepository.list({ level: "WARNING", activeOnly: true });
    expect(list[0]?.plotCode).toBe("");
    expect(list[0]?.expiresAt).toBeUndefined();
  });
});

describe("和风同步器观测与强制同步端点", () => {
  async function post(base: string, path: string): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const response = await fetch(`${base}${path}`, { method: "POST" });
    return { status: response.status, body: await response.json() };
  }

  it("GET /sync-status：未启用同步器时 enabled=false，前端可降级隐藏额度信息", async () => {
    await withServer(async (base) => {
      const res = await get(base, "/api/v1/weather/sync-status");
      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(false);
      expect(res.body.data.dataSource).toBe("demo");
    });
  });

  it("GET /sync-status：注入 syncStats 后透传 todayCalls / dailyCallLimit / forceSyncCount", async () => {
    await withServer(async (base) => {
      const res = await get(base, "/api/v1/weather/sync-status");
      expect(res.body.data).toMatchObject({
        enabled: true,
        dataSource: "qweather",
        todayCalls: 3,
        dailyCallLimit: 20,
        forceSyncCount: 1,
        lastForecastSyncAt: "2026-11-06T00:00:00.000Z",
      });
    }, {
      source: "qweather",
      syncStats: () => ({
        dataSource: "qweather",
        todayCalls: 3,
        dailyCallLimit: 20,
        callCountDate: "2026-11-06",
        forceSyncCount: 1,
        lastForecastSyncAt: "2026-11-06T00:00:00.000Z",
        lastForceSyncAt: "2026-11-06T01:00:00.000Z",
        forecastSyncCount: 2,
        alertSyncCount: 1,
      }),
    });
  });

  it("POST /sync-now：未提供 syncNow 依赖时返回 501（无 Key 场景）", async () => {
    await withServer(async (base) => {
      const res = await post(base, "/api/v1/weather/sync-now");
      expect(res.status).toBe(501);
      expect(res.body.message).toContain("QWEATHER_KEY");
    });
  });

  it("POST /sync-now：提供 syncNow 时 bypass 额度并返回 forecast/alerts 结果", async () => {
    let called = 0;
    await withServer(async (base) => {
      const res = await post(base, "/api/v1/weather/sync-now");
      expect(res.status).toBe(200);
      expect(res.body.data.forecast).toBe(true);
      expect(res.body.data.alerts).toBe(true);
      expect(res.body.data.dataSource).toBe("qweather");
      expect(called).toBe(1);
    }, {
      source: "qweather",
      syncNow: async () => { called += 1; return { forecast: true, alerts: true }; },
      syncStats: () => ({ dataSource: "qweather", todayCalls: 21, dailyCallLimit: 20, forceSyncCount: 1, callCountDate: "2026-11-06", forecastSyncCount: 1, alertSyncCount: 1 }),
    });
  });
});
