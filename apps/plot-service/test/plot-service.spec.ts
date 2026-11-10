import "reflect-metadata";

import { EventTopic } from "@agri/contracts";
import type { DomainEvent, PlotCreatedPayload } from "@agri/contracts";
import { PrismaService } from "@agri/db";
import {
  EventDispatcher,
  IdempotencyGuard,
  InMemoryEventPublisher,
  InMemoryIdempotencyStore,
  InMemoryOutboxStore,
  OutboxService,
} from "@agri/mq";
import { polygonAreaMu, roundAreaMu, ulid } from "@agri/shared";
import { describe, expect, it } from "vitest";

import { PlotCodeService } from "../src/plot-code.service.js";
import { PlotEventConsumer } from "../src/plot.consumer.js";
import { InMemoryPlotRepository } from "../src/plot.repository.js";
import { PlotService } from "../src/plot.service.js";
import type { RegisterPlotInput } from "../src/plot.service.js";
import { createExamplePrismaFactory } from "../src/prisma.factory.js";

/**
 * 示例服务的装配测试：只替换仓储与消息实现，其余依赖走真实代码路径，
 * 因此能验证「建档 → 事务内写消息表 → 中继 → 消费幂等」这条链路的正确性。
 */

const DEMO_GEOM = {
  type: "Polygon" as const,
  coordinates: [
    [
      [107.8421, 30.9942],
      [107.8433, 30.9942],
      [107.8433, 30.9951],
      [107.8421, 30.9951],
      [107.8421, 30.9942],
    ],
  ],
  srid: 4490,
};

/** 带边界的夹具面积一律现算，不写死申报值（口径见 packages/shared/src/area.ts） */
const DEMO_AREA_MU = roundAreaMu(polygonAreaMu(DEMO_GEOM.coordinates[0] ?? []));

/** 组装一套独立实例，避免用例之间互相污染 */
async function buildSut(): Promise<{
  service: PlotService;
  repository: InMemoryPlotRepository;
  publisher: InMemoryEventPublisher;
  store: InMemoryOutboxStore;
  outbox: OutboxService;
  dispatcher: EventDispatcher;
  consumer: PlotEventConsumer;
}> {
  const publisher = new InMemoryEventPublisher();
  const store = new InMemoryOutboxStore();
  const outbox = new OutboxService(store, publisher, { tenantId: "t", traceId: "tr", producer: "plot" });
  const dispatcher = new EventDispatcher({ idempotency: new IdempotencyGuard(new InMemoryIdempotencyStore()) });
  const consumer = new PlotEventConsumer();
  consumer.bind(dispatcher);

  const repository = new InMemoryPlotRepository();
  const prisma = new PrismaService(
    { url: "postgresql://agri:agri@localhost:5432/agri", shardMode: "single", poolSize: 5, slowQueryMs: 500 },
    createExamplePrismaFactory(),
  );
  await prisma.onModuleInit();

  const service = new PlotService(repository, outbox, new PlotCodeService(), prisma);
  return { service, repository, publisher, store, outbox, dispatcher, consumer };
}

function makeInput(overrides: Partial<RegisterPlotInput> = {}): RegisterPlotInput {
  return {
    tenantId: "tenant-demo",
    farmId: "farm-kaijiang-01",
    region: "511723",
    farm: "000001",
    area: "01",
    parcel: "00001",
    parcelName: "开江县任市镇示范田一号地块",
    areaMu: DEMO_AREA_MU,
    soilType: "PADDY_SOIL",
    geom: DEMO_GEOM,
    traceId: ulid(),
    ...overrides,
  };
}

describe("地块服务", () => {
  it("建档生成编码并落库", async () => {
    const { service, repository } = await buildSut();
    const plot = await service.registerPlot(makeInput());

    expect(plot.parcelCode).toBe("511723-000001-01-00001-0000-5");
    expect(plot.parcelId).toMatch(/^\d+$/);
    expect(repository.all()).toHaveLength(1);
    expect(await service.getByCode(plot.parcelCode)).toMatchObject({ parcelName: "开江县任市镇示范田一号地块" });
  });

  it("同一编码重复建档被拒绝，错误码可直接返回前端", async () => {
    const { service, repository } = await buildSut();
    await service.registerPlot(makeInput());

    await expect(service.registerPlot(makeInput())).rejects.toMatchObject({ code: "PLOT-409-001" });
    expect(repository.all()).toHaveLength(1);
  });

  it("查询不存在的地块返回未找到错误", async () => {
    const { service } = await buildSut();
    await expect(service.getByCode("511723-000001-01-00009-0000-0")).rejects.toMatchObject({ code: "PLOT-404-001" });
  });

  it("支持更新和软删除地块", async () => {
    const { service, repository } = await buildSut();
    const plot = await service.registerPlot(makeInput());

    const updated = await service.updatePlot(plot.parcelCode, { parcelName: "更新后的地块", areaMu: 18.2 });
    expect(updated).toMatchObject({ parcelName: "更新后的地块", areaMu: 18.2 });

    await service.removePlot(plot.parcelCode);
    expect(repository.all()[0]?.deletedAt).toBeDefined();
    await expect(service.getByCode(plot.parcelCode)).rejects.toMatchObject({ code: "PLOT-404-001" });
  });

  it("建档事件先入本地消息表，再由中继投递", async () => {
    const { service, store, outbox, publisher } = await buildSut();
    await service.registerPlot(makeInput());

    expect(publisher.published).toHaveLength(0);
    expect((await store.listPending(10))[0]?.topic).toBe(EventTopic.PlotCreated);

    expect(await outbox.relayOnce()).toBe(1);
    expect(publisher.published).toHaveLength(1);
  });

  it("同一事件重复投递时消费者只处理一次", async () => {
    const { service, store, dispatcher, consumer } = await buildSut();
    const plot = await service.registerPlot(makeInput());

    const record = store.all()[0];
    const event: DomainEvent<PlotCreatedPayload> = {
      eventId: ulid(),
      topic: EventTopic.PlotCreated,
      version: 1,
      occurredAt: record?.createdAt ?? new Date().toISOString(),
      producer: "plot",
      tenantId: "tenant-demo",
      traceId: "trace-demo",
      payload: record?.payload as PlotCreatedPayload,
    };

    await dispatcher.dispatch(event);
    await dispatcher.dispatch(event);

    expect(consumer.handledEventIds).toEqual([event.eventId]);
    expect(plot.parcelCode).toBe(event.payload.parcelCode);
  });
});
