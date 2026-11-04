import { describe, expect, it } from "vitest";

import {
  ConfigError,
  EnvSecretsProvider,
  loadConfig,
  validateEnv,
} from "../src/index.js";

/**
 * 配置校验的目标是「启动期确定性失败」：
 * 缺项与非法值都必须在服务起来之前被拦下，而不是在运行期偶发报错。
 */

const FULL_ENV = {
  NODE_ENV: "production",
  SERVICE_NAME: "plot-service",
  PORT: "8080",
  LOG_LEVEL: "warn",
  DB_URL: "postgresql://agri:agri@db:5432/agri",
  DB_SHARD_MODE: "shared",
  DB_POOL_SIZE: "20",
  MQ_BROKERS: "10.0.0.1:9092,10.0.0.2:9092",
  MQ_GROUP_ID: "plot-service",
  REDIS_HOST: "redis",
};

describe("配置加载", () => {
  it("把平铺的环境变量归并为按域分组的配置", () => {
    const config = loadConfig(FULL_ENV);
    expect(config.serviceName).toBe("plot-service");
    expect(config.port).toBe(8080);
    expect(config.db.poolSize).toBe(20);
    expect(config.db.shardMode).toBe("shared");
    expect(config.mq.brokers).toEqual(["10.0.0.1:9092", "10.0.0.2:9092"]);
    expect(config.mq.clientId).toBe("plot-service");
    expect(config.redis.host).toBe("redis");
  });

  it("缺少必填项时抛出配置异常并列出问题项", () => {
    const { DB_URL: _dbUrl, ...withoutDb } = FULL_ENV;
    expect(() => loadConfig(withoutDb)).toThrow(ConfigError);
    try {
      loadConfig(withoutDb);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.join(" ")).toContain("DB_URL");
    }
  });

  it("声明式预检只汇报结果，不抛异常", () => {
    expect(validateEnv(FULL_ENV)).toEqual({ ok: true, issues: [] });
    const bad = validateEnv({ ...FULL_ENV, PORT: "70000" });
    expect(bad.ok).toBe(false);
    expect(bad.issues.join(" ")).toContain("PORT");
  });

  it("密钥缺失时抛出配置异常，空串视为缺失", () => {
    const provider = new EnvSecretsProvider({ DB_PASSWORD: "secret", EMPTY: "" });
    expect(provider.get("EMPTY")).toBeUndefined();
    expect(provider.require("DB_PASSWORD")).toBe("secret");
    expect(() => provider.require("MQ_TOKEN")).toThrow(ConfigError);
  });
});
