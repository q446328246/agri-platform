import "reflect-metadata";

import { PgClientAdapter, resolveDatabaseUrl } from "@agri/db";
import { configureDecorators, LoggerService } from "@agri/observability";

import { SqlAlertRepository } from "./alert.repository.js";
import { demoAlerts, demoForecastDays, demoForecastHours } from "./demo.js";
import { createWeatherHttpServer } from "./http.js";
import type { WeatherDependencies } from "./http.js";
import { SqlForecastRepository } from "./forecast.repository.js";
import { buildQWeatherFromEnv, buildSyncerOptionsFromEnv, createWeatherSyncer, type WeatherSyncer } from "./sync.js";

/** 日志级别白名单，缺省 info */
function parseLogLevel(value?: string): "debug" | "info" | "warn" | "error" {
  return value === "debug" || value === "warn" || value === "error" ? value : "info";
}

/**
 * 和风从 2026 年起逐步停用公共域名（devapi/api/geoapi.qweather.com）。
 * - v1：新接口不支持旧域名（已在 buildQWeatherFromEnv 中直接不启用同步器），本函数不会命中
 * - v7：旧接口过渡期仍可用，命中旧域名时记 warn；否则新 Key 会因 403 Invalid Host 失败
 */
function checkQWeatherHost(logger: LoggerService, host: string | undefined, apiVersion: "v1" | "v7"): void {
  if (apiVersion !== "v7") return;
  const value = (host ?? "https://devapi.qweather.com").toLowerCase();
  if (/\b(devapi|api|geoapi)\.qweather\.com\b/.test(value)) {
    logger.warn("和风天气 v7 公共域名 2026 起停用，建议切换到 v1 并使用控制台专属 API Host", {
      current: host,
      apiVersion,
      hint: "登录 https://console.qweather.com/setting 获取形如 xxx.yz.qweatherapi.com 的专属 Host，写入 QWEATHER_HOST（QWEATHER_API_VERSION 默认已为 v1）",
    });
  }
}

async function bootstrap(): Promise<void> {
  const port = Number(process.env.PORT ?? 3005);
  const logger = new LoggerService({ serviceName: "weather-service", level: parseLogLevel(process.env.LOG_LEVEL) });
  configureDecorators({ logger });
  // 默认持久化到 PostgreSQL；显式设置 memory 或未配置 DB_URL 时使用内存实现
  const mode = process.env.WEATHER_REPOSITORY_MODE === "memory" || !process.env.DB_URL ? "memory" : "sql";

  if (process.env.SERVICE_MODE === "http") {
    let syncer: WeatherSyncer | undefined;

    if (mode === "sql") {
      const client = PgClientAdapter.fromUrl(resolveDatabaseUrl(process.env.DB_URL));
      await client.$connect();
      const forecastRepository = new SqlForecastRepository(client);
      const alertRepository = new SqlAlertRepository(client);
      // 表为空时回填演示预报（迁移 012 已种过则跳过），保证任何时候启动都有当日五日数据
      if ((await forecastRepository.count()) === 0) {
        for (const day of demoForecastDays()) await forecastRepository.create(undefined, day);
        logger.info("已回填五日预报演示数据", { days: 5 });
      }
      if ((await forecastRepository.hourCount()) === 0) {
        for (const hour of demoForecastHours()) await forecastRepository.upsertHour(hour);
        logger.info("已回填逐小时预报演示数据", { hours: 48 });
      }
      if ((await alertRepository.count()) === 0) {
        for (const alert of demoAlerts()) await alertRepository.create(undefined, alert);
        logger.info("已回填气象预警演示数据", { alerts: demoAlerts().length });
      }

      // 和风天气可选接入：配置 QWEATHER_KEY 后启动定时同步器（默认每日一次，前端接口仍只读本地 SQL）
      const qw = buildQWeatherFromEnv(process.env);
      // source 固定为 sql；真正拉到和风数据后由 syncStats.dataSource 升级为 qweather，避免未启动时误报
      const source: WeatherDependencies["source"] = "sql";
      if (qw) {
        syncer = createWeatherSyncer({
          client: qw.client,
          mapper: qw.mapper,
          forecasts: forecastRepository,
          alerts: alertRepository,
          city: qw.config.city ?? "达州市",
          logger,
          ...buildSyncerOptionsFromEnv(process.env),
        });
        logger.info("和风天气同步已启用（每日一次，前端只读 DB）", {
          apiVersion: qw.config.apiVersion ?? "v1",
          auth: qw.config.jwtSigner ? "jwt-ed25519" : qw.config.jwt ? "jwt-static" : "apiKey",
          host: qw.config.host ?? "-",
          locationId: qw.config.locationId ?? "101270600",
          latitude: qw.config.latitude ?? "-",
          longitude: qw.config.longitude ?? "-",
          city: qw.config.city ?? "达州市",
        });
        checkQWeatherHost(logger, qw.config.host, qw.config.apiVersion ?? "v1");
        syncer.start();
      }

      const dependencies: WeatherDependencies = {
        forecasts: forecastRepository,
        alerts: alertRepository,
        telemetryUrl: process.env.TELEMETRY_SERVICE_URL,
        source,
        ...(syncer ? { syncStats: () => syncer!.stats(), syncNow: () => syncer!.forceSync() } : {}),
      };
      const server = createWeatherHttpServer(dependencies);
      server.listen(port, "127.0.0.1", () => logger.info("weather-service HTTP 已启动（SQL 持久化）", { port, source }));
      const shutdown = async (): Promise<void> => {
        syncer?.stop();
        server.close();
        await client.$disconnect();
      };
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
      return;
    }

    // 内存模式：无 DB，仍支持和风同步（内存仓储幂等覆盖，进程重启回到 demo 种子）
    const qw = buildQWeatherFromEnv(process.env);
    let source: WeatherDependencies["source"] = "demo";
    if (qw) {
      const memoryForecasts = new (await import("./forecast.repository.js")).InMemoryForecastRepository({ days: demoForecastDays(), hours: demoForecastHours() });
      const memoryAlerts = new (await import("./alert.repository.js")).InMemoryAlertRepository(demoAlerts());
      syncer = createWeatherSyncer({
        client: qw.client,
        mapper: qw.mapper,
        forecasts: memoryForecasts,
        alerts: memoryAlerts,
        city: qw.config.city ?? "达州市",
        logger,
        ...buildSyncerOptionsFromEnv(process.env),
      });
      source = "qweather";
      logger.info("和风天气同步已启用（内存仓储）", {
        apiVersion: qw.config.apiVersion ?? "v1",
        auth: qw.config.jwtSigner ? "jwt-ed25519" : qw.config.jwt ? "jwt-static" : "apiKey",
        host: qw.config.host ?? "-",
        locationId: qw.config.locationId ?? "101270600",
      });
      checkQWeatherHost(logger, qw.config.host, qw.config.apiVersion ?? "v1");
      syncer.start();
      const dependencies: WeatherDependencies = {
        forecasts: memoryForecasts,
        alerts: memoryAlerts,
        telemetryUrl: process.env.TELEMETRY_SERVICE_URL,
        source,
        syncStats: () => syncer!.stats(),
        syncNow: () => syncer!.forceSync(),
      };
      const server = createWeatherHttpServer(dependencies);
      server.listen(port, "127.0.0.1", () => logger.info("weather-service HTTP 已启动（内存 + 和风）", { port }));
      const shutdown = (): void => {
        syncer?.stop();
        server.close();
      };
      process.once("SIGINT", () => shutdown());
      process.once("SIGTERM", () => shutdown());
      return;
    }

    const server = createWeatherHttpServer({ telemetryUrl: process.env.TELEMETRY_SERVICE_URL, source: "demo" });
    server.listen(port, "127.0.0.1", () => logger.info("weather-service HTTP 已启动（内存实现）", { port }));
    return;
  }
  logger.info("weather-service 已启动（demo 模式）");
}

await bootstrap();
