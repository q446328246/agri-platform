import { describe, expect, it } from "vitest";

import {
  buildPlotCodeFixture,
  createTestDatabase,
  deviceFixture,
  freezeTime,
  gridFixture,
  InMemoryEventBus,
  MockClock,
  plotFixture,
  resetDatabase,
  seasonFixture,
  telemetryFixture,
  TestModuleBuilder,
} from "../src/index.js";

/**
 * 测试工具自身的契约测试。
 * 工具出错会污染所有下游用例，因此时钟推进、事件总线与夹具的默认值都要被约束住。
 */
describe("测试工具", () => {
  it("可控时钟按毫秒推进", () => {
    const clock = new MockClock("2026-04-20T00:00:00.000Z");
    expect(clock.nowIso()).toBe("2026-04-20T00:00:00.000Z");
    clock.advance(86400000);
    expect(clock.nowIso()).toBe("2026-04-21T00:00:00.000Z");
    expect(() => clock.advance(-1)).toThrow();
  });

  it("接管全局时间后可复归", () => {
    const clock = freezeTime("2026-06-01T00:00:00.000Z");
    const restore = clock.freeze();
    expect(new Date(Date.now()).toISOString()).toBe("2026-06-01T00:00:00.000Z");
    restore();
    expect(Date.now()).not.toBe(Date.parse("2026-06-01T00:00:00.000Z"));
  });

  it("内存事件总线完成发布订阅并保留历史", async () => {
    const bus = new InMemoryEventBus(new MockClock("2026-05-01T00:00:00.000Z"));
    const received: string[] = [];
    bus.on("plot.plot.created", (event) => {
      received.push(event.eventId);
    });

    const receipt = await bus.publish("plot.plot.created", { parcelCode: "511723-000001-01-00001-0000-5" });
    expect(received).toEqual([receipt.eventId]);
    expect(bus.published("plot.plot.created")[0]?.occurredAt).toBe("2026-05-01T00:00:00.000Z");

    bus.reset();
    expect(bus.published()).toHaveLength(0);
  });

  it("测试库可复位并释放连接", async () => {
    const db = await createTestDatabase({ schema: "test_unit" });
    await resetDatabase(db, ["plot", "plot_grid"]);
    expect(db.executedSql.some((sql) => sql.startsWith("TRUNCATE TABLE plot, plot_grid"))).toBe(true);

    await db.stop();
    expect(db.stopped).toBe(true);
    expect(db.executedSql).toContain("DISCONNECT");
  });

  it("夹具默认值可用且彼此关联", () => {
    const plot = plotFixture();
    expect(plot.parcelCode).toBe(buildPlotCodeFixture());
    expect(plot.areaMu).toBeGreaterThan(0);

    expect(gridFixture().parcelId).toBe(plot.parcelId);
    expect(deviceFixture().deviceCode).toMatch(/^DEV-/);
    expect(seasonFixture().parcelId).toBe(plot.parcelId);
    expect(telemetryFixture().metric).toBe("soil.moisture");
    expect(telemetryFixture().unit).toBe("%");
  });

  it("模块构造器可覆盖依赖并取回实例", async () => {
    class FakeRepository {
      kind = "stub";
    }

    const moduleRef = await TestModuleBuilder.create()
      .withProviders([{ provide: FakeRepository, useValue: { kind: "memory" } }])
      .withOverride(FakeRepository, { kind: "stub" })
      .build();

    expect(moduleRef.get<{ kind: string }>(FakeRepository).kind).toBe("stub");
    await moduleRef.close();
  });
});
