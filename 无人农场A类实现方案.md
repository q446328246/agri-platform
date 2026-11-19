# 无人农场 A 类（数据与基础设施）实现方案

> 配套文档：[`无人农场开发需求与待办.md`](./无人农场开发需求与待办.md)（需求清单、待办梳理与实现结果）
>
> 统一原则：**复用现有底座、双实现并存、用开关切换、可回退**，不推翻已有代码。

## A1 高频遥测时序数据容量方案

**现状**：`telemetry_readings` 全部落在 PostgreSQL，`SqlReadingRepository` 用原生 SQL 读写；`latest` 用 `ROW_NUMBER()` 全表扫，`history` 走 `LIMIT`。演示库 7504 条，真实秒级/分钟级上报会迅速膨胀。

**目标**：高频读数可长期留存、查询不随数据量退化，且不动 `ReadingRepository` 接口。

**选型对比**

| 方案 | 优点 | 代价 | 适合度 |
| --- | --- | --- | --- |
| **TimescaleDB**（PG 扩展，推荐） | 复用现有 PG + PostGIS，迁移最小，接口不变 | 需换/扩基础镜像，压缩与连续聚合要写迁移 | 高 |
| 独立时序库（InfluxDB/VictoriaMetrics） | 写入吞吐极高 | 需新增仓储实现与同步链路，与 PostGIS 空间查询割裂 | 中 |
| 冷数据归档到 MinIO（Parquet） | 成本低 | 历史查询需冷读，体验差 | 作为补充 |

**落地步骤**

1. **镜像改造**：`postgis/postgis:16-3.5` 不含 TimescaleDB。将 compose 的 `postgres` 服务换成同时具备 TimescaleDB + PostGIS 的基础镜像（如 Timescale 官方 `timescale/timescaledb-ha:pg16-ts2.x`，并在容器初始化脚本里 `CREATE EXTENSION postgis`）。镜像的 postgis 包来源需单独验证后再固化。
2. **迁移 059_timescale.sql**（放入 `infra/postgres/migrations/`，沿用编号迁移机制）：

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
SELECT create_hypertable('telemetry_readings', 'recorded_at',
                         chunk_time_interval => INTERVAL '7 day');
CREATE INDEX IF NOT EXISTS idx_readings_device_metric_time
  ON telemetry_readings (device_id, metric, depth_cm, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_readings_plot_time
  ON telemetry_readings (plot_code, recorded_at DESC);
-- 连续聚合加速 latest
SELECT add_continuous_aggregate('telemetry_readings_latest',
  start_offset => INTERVAL '30 days', end_offset => INTERVAL '1 day',
  schedule_interval => INTERVAL '15 min',
  AS SELECT device_id, metric, depth_cm, max(recorded_at) AS recorded_at,
            max(value) AS value, unit, plot_code
         FROM telemetry_readings
        WHERE quality_flags = '[]'::jsonb
        GROUP BY device_id, metric, depth_cm, unit, plot_code);
-- 保留策略：明细 90 天，聚合更久
SELECT alter_retention_policy('telemetry_readings_rp',
  interval => INTERVAL '90 days', tier_by => 'recorded_at DESC');
```

3. **读写改造**：`SqlReadingRepository.latest` 改读连续聚合（或靠分块裁剪 + 新索引），`history`/`recentValues` 靠索引定位分块；**接口签名不变**，前端与上层零改动。
4. **容量预估**：`设备数 × 指标数 × 上报频率 × 保留天数 × 单条字节`，据此定保留周期与降采样，落地前做一次写入/查询压测。
5. **回退**：保留现有 `SqlReadingRepository`，用与 `VIDEO_REPOSITORY_MODE`/`WEATHER_REPOSITORY_MODE` 同款的模式开关切换。

## A2 MQTT Broker 设备接入方案

**现状**：`field-gateway.ts` 走 **Modbus TCP 轮询** `control-service` 指令；设备采集走 **HTTP 回调**。无消息中间件，高频遥测与无人农机/无人机接入无合适通道。

**目标**：为高频遥测与指令下发提供 MQTT 通道，支持断网续传，与现有 HTTP 链路并存。

**选型**：推荐 **EMQX**（集群、规则引擎、可桥接内部消息总线，适配多农场扩展）；单场设备量小可用 Mosquitto。

**落地步骤**

1. **compose 增加 broker**（`infra/docker-compose.yml`）：

```yaml
  emqx:
    image: emqx/emqx:5.8
    ports:
      - "1883:1883"    # MQTT
      - "8883:8883"    # MQTT over TLS
      - "18083:18083"  # 控制台
    volumes:
      - agri-emqx:/opt/emqx/data
    healthcheck:
      test: ["CMD", "emqx_ctl", "status"]
      interval: 5s
      retries: 10
```

2. **Topic 规范**：

```
agri/{tenantId}/{deviceNo}/telemetry   # 设备 → 平台：遥测/状态
agri/{tenantId}/{deviceNo}/command     # 平台 → 设备：指令下发
agri/{tenantId}/{deviceNo}/receipt     # 设备 → 平台：执行回执
```

3. **`iot-service` 增加 MQTT 接入适配器**（`mqtt-broker.ts`）：用 `mqtt.js` 订阅遥测 topic，解析点表换算后的标准化读数，转成 `CreateReadingInput` 推送 `telemetry-service`；回执 topic 复用 `ControlChannel` 口径。开关 `IOT_MQTT_ENABLED`，缺省关，保留 HTTP 回调兼容/兜底。
4. **控制下发改造**：`control-service`/`field-gateway` 指令下发新增 MQTT 通道，与现有"设备回调领取"并存，开关切换。
5. **幂等与断网续传**：沿用 `@agri/mq` 的 `eventId` 幂等口径，遥测按 `(deviceId, metric, depthCm, recordedAt)` 去重；设备侧 QoS 1/2 + 本地队列，重连后按时间戳补传，平台侧去重兜底。
6. **安全**：复用 `DEVICE_CALLBACK_TOKEN` 做设备凭证认证，topic 级别 ACL，生产启用 TLS（8883）。

**回退**：关 `IOT_MQTT_ENABLED` 即回到纯 HTTP 链路，零业务影响。

## A3 和风天气（qweather）数据源凭据配置方案

**现状**：`weather-service/src/qweather.ts` 已完整实现 v1/v7、Ed25519 JWT 签发、`X-QW-Api-Key` 认证、mapper 与错误透传；`sync.ts` 定时同步落三张表；`.env.example` 给出全部配置项；compose 已把 `ed25519-private.pem` 只读挂载到 `/run/secrets/qweather-private.pem`。**只缺真实凭据与生效验证**。

**落地步骤**

1. 和风控制台创建项目，拿到**专属 API Host**、**API Key**，或 **Key ID / Developer ID / Project ID + Ed25519 私钥**（JWT 模式）。
2. 写入仓库根 `.env`（`.gitignore` 已忽略）：

```dotenv
QWEATHER_API_VERSION=v1
QWEATHER_HOST=xxx.yz.qweatherapi.com      # v1 必须专属 Host
# 二选一：API Key
QWEATHER_KEY=你的Key
# 或 JWT：Key ID / 开发者 ID / 项目 ID + 私钥路径
QWEATHER_KEY_ID=...
QWEATHER_DEVELOPER_ID=...
QWEATHER_PROJECT_ID=...
QWEATHER_PRIVATE_KEY_PATH=/run/secrets/qweather-private.pem
```

3. **注意**：compose 注释已说明，**不要**在 `environment:` 里用 `${QWEATHER_KEY:-}` 展开，compose 插值会用 shell 空值覆盖 `env_file` 里的真实值；`env_file: ../.env` 自动注入，保持现状。
4. **验证**：启动 `weather-service`，跑 `pnpm smoke:weather`，检查 `weather_forecasts`/`weather_forecast_hours`/`weather_alerts` 有真实数据、页面不再走内存 demo；确认 `resolveQWeatherConfig` 未因旧公共域名抛错（该校验是有意设计）。
5. **凭证管理**：私钥不入 git；`pnpm backup:system -- --include-secrets` 才带 `.env` 与私钥。

**风险**：v1 旧公共域名 2026 起逐步停用，务必用控制台专属 Host；注意免费额度与调用频率。

## A4 数据库迁移 / 备份恢复演练方案

**现状**：三个脚本已具备——`pnpm db:migrate`（编号迁移 + `schema_migrations` 记账）、`pnpm backup:system`（代码+库+配置，带 manifest 与保留策略）、`pnpm restore:system`（代码+库恢复）；compose 已挂 `../backups`。**缺的是真实演练**。

**演练步骤**

1. **备份**（配置 `BACKUP_DIR`、`BACKUP_KEEP`）：

```bash
pnpm backup:system -- --include-secrets --keep 10
pnpm backup:system -- --list
```

核验：`backups/<时间戳>/manifest.json` 完整、`db-*.dump` 大小合理、`sha256` 可算。

2. **迁移演练**（在**独立临时库**上从零跑，避免影响在用库）：

```bash
createdb agri_migrate_test
DB_URL=postgresql://agri:agri@127.0.0.1:5432/agri_migrate_test pnpm db:migrate
DB_URL=postgresql://agri:agri@127.0.0.1:5432/agri_migrate_test pnpm db:migrate -- --status
```

核验：`001`–`058` 全部「已应用」；再跑一次确认「已是最新」（迁移可重入、无遗漏）；每个迁移在单事务内执行、失败整体回滚。

3. **恢复演练**（恢复到临时库，验证可读可起）：

```bash
pnpm restore:system -- --from <备份时间戳> --db agri_restore_test
```

核验：恢复后的库能被 `pnpm db:migrate -- --status` 识别、能启动服务、地块数/遥测数与备份前一致。

4. **日常化**：用计划任务（Windows 任务计划 / cron）定期执行 `pnpm backup:system`，按 `BACKUP_KEEP` 保留；重要备份**异地**或落 MinIO。

**核验清单**：备份完整 → 迁移从零可跑 → 恢复可读 → 服务可起 → 关键表行数对得上。

## 建议推进顺序

A3 最简单，先配置验证；A4 紧随其后演练；A1、A2 涉及镜像与接入层改造，按「镜像验证 → 迁移 → 读写改造 → 压测」和「compose → 适配器 → 开关 → 联调」分别落地，均保留开关可回退。
