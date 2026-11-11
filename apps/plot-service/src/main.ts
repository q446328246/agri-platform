/**
 * 示例服务入口（组合根）。
 *
 * 本入口手工装配依赖并走通一条完整链路：地块建档 → 事务内写本地消息表 →
 * 中继投递 → 消费处理 → 重复投递被幂等拦下。
 * 不依赖 HTTP 适配器即可运行，便于在不启动中间件的情况下验证装配关系；
 * 接入 HTTP 后应由根模块导入 AppModule.forRoot 并交由框架托管生命周期。
 */
import "reflect-metadata";

import type { DomainEvent, PlotCreatedPayload } from "@agri/contracts";
import { loadConfig } from "@agri/config";
import { PgClientAdapter, PrismaService } from "@agri/db";
import type { EventPublisher, OutboxStore } from "@agri/mq";
import {
  EventDispatcher,
  EventLogPublisher,
  IdempotencyGuard,
  InMemoryEventPublisher,
  InMemoryIdempotencyStore,
  InMemoryOutboxStore,
  OutboxService,
  PgEventLogStore,
  setDefaultPublisher,
} from "@agri/mq";
import { configureDecorators, LoggerService, MetricsService } from "@agri/observability";
import { polygonAreaMu, roundAreaMu, ulid } from "@agri/shared";

import { PlotCodeService } from "./plot-code.service.js";
import { PlotEventConsumer } from "./plot.consumer.js";
import { InMemoryInfraLineRepository, SqlInfraLineRepository } from "./infra-line.repository.js";
import { InMemoryCropSeasonRepository, SqlCropSeasonRepository } from "./season.repository.js";
import { InMemoryPlotChangeLogRepository, SqlPlotChangeLogRepository } from "./plot-change-log.repository.js";
import { InMemoryZoneRepository, SqlZoneRepository } from "./zone.repository.js";
import { InMemoryPlotRepository, SqlPlotRepository } from "./plot.repository.js";
import { SqlPlotOutboxStore } from "./outbox.repository.js";
import { PlotService } from "./plot.service.js";
import { createExamplePrismaFactory } from "./prisma.factory.js";
import { createPlotHttpServer } from "./http.js";

/** 演示用的地块边界：矩形，首尾闭合，坐标为 CGCS2000 十进制度 */
const DEMO_RING = [
  [107.8421, 30.9942],
  [107.8433, 30.9942],
  [107.8433, 30.9951],
  [107.8421, 30.9951],
  [107.8421, 30.9942],
];

const DEMO_GEOM = {
  type: "Polygon" as const,
  coordinates: [DEMO_RING],
  srid: 4490,
};

async function bootstrap(): Promise<void> {
  const appConfig = loadConfig({
    NODE_ENV: "development",
    SERVICE_NAME: "plot-service",
    LOG_LEVEL: "info",
    DB_URL: "postgresql://agri:agri@localhost:5432/agri",
    MQ_BROKERS: "127.0.0.1:9092",
    MQ_GROUP_ID: "plot-service",
    ...process.env,
  });

  const logger = new LoggerService({ serviceName: appConfig.serviceName, level: appConfig.logLevel });
  const metrics = new MetricsService();
  configureDecorators({ logger, metrics });

  // 业务依赖
  // SQL 模式下必须注入真实的 pg 适配器，示例客户端只在内存演示时使用
  const repositoryMode = process.env.PLOT_REPOSITORY_MODE === "sql" ? "sql" : "memory";
  const prisma = new PrismaService(
    {
      url: appConfig.db.url,
      shardMode: appConfig.db.shardMode,
      poolSize: appConfig.db.poolSize,
      slowQueryMs: appConfig.db.slowQueryMs,
    },
    repositoryMode === "sql" ? () => PgClientAdapter.fromUrl(appConfig.db.url) : createExamplePrismaFactory(),
  );
  await prisma.onModuleInit();

  // 基础设施与横切能力
  // SQL 模式：建档事件与地块同事务落 plot_outbox，由中继投递到共享事件日志，跨进程可靠
  // 内存模式：进程内消息表与发布器，仅供不启动中间件的单进程演示
  const publisher: EventPublisher = repositoryMode === "sql"
    ? new EventLogPublisher(new PgEventLogStore(prisma.clientInstance), {
        tenantId: "tenant-demo",
        traceId: "plot-relay",
        producer: "plot",
      })
    : new InMemoryEventPublisher();
  setDefaultPublisher(publisher);
  const outboxStore: OutboxStore = repositoryMode === "sql"
    ? new SqlPlotOutboxStore(prisma.clientInstance)
    : new InMemoryOutboxStore();
  const outbox = new OutboxService(outboxStore, publisher, {
    tenantId: "tenant-demo",
    traceId: "boot",
    producer: "plot",
  });
  const dispatcher = new EventDispatcher({
    idempotency: new IdempotencyGuard(new InMemoryIdempotencyStore()),
    onError: (topic, eventId, error, attempt): void => {
      logger.warn("事件处理失败，将按策略重试", { topic, eventId, attempt, reason: error.message });
    },
  });
  const consumer = new PlotEventConsumer();
  consumer.bind(dispatcher);
  await dispatcher.start();

  const repository = repositoryMode === "sql"
    ? new SqlPlotRepository(prisma.clientInstance)
    : new InMemoryPlotRepository();
  const infraLines = repositoryMode === "sql"
    ? new SqlInfraLineRepository(prisma.clientInstance)
    : new InMemoryInfraLineRepository();
  const zones = repositoryMode === "sql"
    ? new SqlZoneRepository(prisma.clientInstance)
    : new InMemoryZoneRepository();
  const seasons = repositoryMode === "sql"
    ? new SqlCropSeasonRepository(prisma.clientInstance)
    : new InMemoryCropSeasonRepository();
  const changeLogs = repositoryMode === "sql"
    ? new SqlPlotChangeLogRepository(prisma.clientInstance)
    : new InMemoryPlotChangeLogRepository();

  const codeService = new PlotCodeService();
  const plotService = new PlotService(repository, outbox, codeService, prisma);

  if (process.env.SERVICE_MODE === "http") {
    const server = createPlotHttpServer(plotService, infraLines, zones, seasons, changeLogs);
    const port = Number(process.env.PORT ?? 3002);
    // SQL 模式周期性中继把 plot_outbox 待投递事件写入共享事件日志，供其他服务消费
    if (repositoryMode === "sql") {
      outbox.start();
    }
    server.listen(port, "127.0.0.1", () => logger.info("地块服务 HTTP 已启动", { port }));
    const shutdown = async (): Promise<void> => {
      server.close();
      if (repositoryMode === "sql") {
        outbox.stop();
      }
      await dispatcher.stop();
      await prisma.onModuleDestroy();
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    return;
  }

  // SQL 模式已接入 HTTP 持久化链路；未启动 HTTP 时不再向真实库写入演示事件
  if (repositoryMode === "sql") {
    await dispatcher.stop();
    await prisma.onModuleDestroy();
    logger.info("地块服务 SQL 模式已就绪（未启动 HTTP，跳过内存演示链路）");
    return;
  }

  // 1. 建档：编码由编码服务生成，业务数据与事件同事务落库
  const traceId = ulid();
  const plot = await plotService.registerPlot({
    tenantId: "tenant-demo",
    farmId: "farm-kaijiang-01",
    region: "511723",
    farm: "000001",
    area: "01",
    parcel: "00001",
    parcelName: "开江县任市镇示范田一号地块",
    // 面积一律由边界现算，与前端预览、迁移 015 同口径；写死的申报值会和几何对不上
    areaMu: roundAreaMu(polygonAreaMu(DEMO_RING)),
    soilType: "PADDY_SOIL",
    geom: DEMO_GEOM,
    traceId,
  });
  logger.info("地块建档完成", { parcelId: plot.parcelId, parcelCode: plot.parcelCode });

  // 2. 中继：把消息表中的待投递事件发到消息总线
  const relayed = await outbox.relayOnce();
  logger.info("本地消息表中继完成", { relayed });

  // 3. 消费：同一事件投递两次，第二次应被幂等丢弃
  // 走到这里必是内存演示模式（SQL 模式已提前返回），可安全取内存消息表的进程内视图
  const record = (outboxStore as InMemoryOutboxStore).all()[0];
  if (!record) {
    throw new Error("中继后未找到待投递记录");
  }
  const event: DomainEvent<PlotCreatedPayload> = {
    eventId: ulid(),
    topic: record.topic,
    version: 1,
    occurredAt: record.createdAt,
    producer: record.producer,
    tenantId: record.tenantId,
    traceId: record.traceId,
    payload: record.payload as PlotCreatedPayload,
  };
  await dispatcher.dispatch(event);
  await dispatcher.dispatch(event);

  // 4. 编码能力抽查：网格编码与出参坐标换算
  const gridCode = codeService.grid(plot.parcelCode, 1, 1);
  const clientCoord = codeService.toClient({ lng: 107.8421, lat: 30.9942 });

  await dispatcher.stop();
  await prisma.onModuleDestroy();

  process.stdout.write(
    `${JSON.stringify(
      {
        service: appConfig.serviceName,
        parcelCode: plot.parcelCode,
        areaMu: plot.areaMu,
        gridCode,
        handledEventCount: consumer.handledEventIds.length,
        deliveredEventCount: (publisher as InMemoryEventPublisher).published.length,
        clientCoord,
      },
      null,
      2,
    )}\n`,
  );
}

await bootstrap();
