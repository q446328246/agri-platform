import { describe, expect, it, vi } from "vitest";

import { EventTopic } from "@agri/contracts";
import type { CommandTimeoutPayload } from "@agri/contracts";
import type { Tx } from "@agri/db";
import { InMemoryEventPublisher, InMemoryOutboxStore, OutboxService } from "@agri/mq";

import { InMemoryControlCommandRepository } from "../src/control.repository.js";
import type { ControlCommand, ControlCommandRepository } from "../src/control.repository.js";
import { ControlReceiptSweeper } from "../src/receipt-sweeper.js";

/**
 * 超时未回执的自动收口回归。
 *
 * 覆盖三件事：只收口真正超时的在途指令、收口与超时事件同事务、以及和现场迟到回执
 * 抢版本时先到先得。超时时长一律由指令时间戳现算，不写死。
 */

const MINUTE = 60_000;

function command(overrides: Partial<ControlCommand> = {}): ControlCommand {
  return {
    id: "cmd-1",
    tenantId: "tenant-demo",
    deviceId: "device-irri-001",
    plotCode: "511723-000001-01-00001-0000-5",
    operatorId: "user-admin",
    confirmedAt: "2026-11-12T00:00:00.000Z",
    type: "IRRIGATION",
    parameters: { zones: [{ zoneCode: "ZONE-01", areaMu: 10, targetMm: 20 }] },
    status: "QUEUED",
    origin: "MANUAL",
    reason: "土壤含水率低于下限",
    version: 1,
    createdAt: "2026-11-12T00:00:00.000Z",
    ...overrides,
  };
}

/** 收口任务要求「消息表 + 事务句柄」成对装配；内存消息表不真的用事务，给个空句柄即可 */
const fakeTx = { $queryRawUnsafe: async () => [], $executeRawUnsafe: async () => 0 } as unknown as Tx;

function makeRelay() {
  const store = new InMemoryOutboxStore();
  const publisher = new InMemoryEventPublisher();
  // 默认上下文故意与指令归属不同，用来验证事件跟着行内租户走而不是进程配置
  const outbox = new OutboxService(store, publisher, { tenantId: "tenant-boot", traceId: "boot", producer: "control" });
  return { store, publisher, outbox, withTransaction: async (run: (tx: Tx) => Promise<unknown>) => await run(fakeTx) };
}

describe("ControlReceiptSweeper 超时收口", () => {
  const nowMs = Date.parse("2026-11-12T02:00:00.000Z");

  it("只收口超过阈值的在途指令，未到阈值与已终态的不动", async () => {
    const repository = new InMemoryControlCommandRepository([
      command({ id: "queued-40", createdAt: new Date(nowMs - 40 * MINUTE).toISOString() }),
      command({ id: "sent-20", status: "SENT", sentAt: new Date(nowMs - 20 * MINUTE).toISOString() }),
      command({ id: "acked-5", status: "ACKED", ackedAt: new Date(nowMs - 5 * MINUTE).toISOString() }),
      command({ id: "done-100", status: "DONE", createdAt: new Date(nowMs - 100 * MINUTE).toISOString(), finishedAt: new Date(nowMs - 90 * MINUTE).toISOString(), version: 3 }),
    ]);
    const sweeper = new ControlReceiptSweeper(repository, { timeoutMin: 15 });

    expect(await sweeper.sweepOnce(nowMs)).toBe(2);

    expect((await repository.find("tenant-demo", "queued-40"))?.status).toBe("FAILED");
    expect((await repository.find("tenant-demo", "sent-20"))?.status).toBe("FAILED");
    expect((await repository.find("tenant-demo", "acked-5"))?.status).toBe("ACKED");
    expect((await repository.find("tenant-demo", "done-100"))?.status).toBe("DONE");
    // 收口写清楚等了多久，人工回填时不用再去翻时间戳
    expect((await repository.find("tenant-demo", "queued-40"))?.receiptMessage).toBe("超过有效回执阈值 15 分钟未收到设备回执（已等待 40 分钟），系统自动收口为失败");
  });

  it("长作业按执行包络延长回执阈值，超过作业时长后才收口", async () => {
    const repository = new InMemoryControlCommandRepository([
      command({
        id: "cmd-long",
        type: "SEEDING",
        parameters: { areaMu: 20, durationMin: 120, plan: { totalDurationMin: 120 } },
        createdAt: new Date(nowMs - 20 * MINUTE).toISOString(),
      }),
    ]);
    const sweeper = new ControlReceiptSweeper(repository, { timeoutMin: 15 });
    expect(await sweeper.sweepOnce(nowMs)).toBe(0);
    expect(await sweeper.sweepOnce(nowMs + 102 * MINUTE)).toBe(1);
    expect((await repository.find("tenant-demo", "cmd-long"))?.receiptMessage).toContain("有效回执阈值 121 分钟");
  });

  it("再扫一轮不重复收口：终态指令不进候选", async () => {
    const repository = new InMemoryControlCommandRepository([
      command({ id: "cmd-once", createdAt: new Date(nowMs - 40 * MINUTE).toISOString() }),
    ]);
    const sweeper = new ControlReceiptSweeper(repository, { timeoutMin: 15 });

    expect(await sweeper.sweepOnce(nowMs)).toBe(1);
    expect(await sweeper.sweepOnce(nowMs + MINUTE)).toBe(0);
    expect((await repository.find("tenant-demo", "cmd-once"))?.version).toBe(2);
  });

  it("batchSize 限制单轮条数，剩下的留到下一轮", async () => {
    const repository = new InMemoryControlCommandRepository(
      ["a", "b", "c"].map((id) => command({ id, createdAt: new Date(nowMs - 40 * MINUTE).toISOString() })),
    );
    const sweeper = new ControlReceiptSweeper(repository, { timeoutMin: 15, batchSize: 2 });

    expect(await sweeper.sweepOnce(nowMs)).toBe(2);
    expect((await repository.listOverdue(15, nowMs, 10)).map((item) => item.id)).toEqual(["c"]);
  });

  it("超时事件的归属、追踪与载荷都取自指令本身，时长现算", async () => {
    const repository = new InMemoryControlCommandRepository([
      command({
        id: "cmd-evt",
        tenantId: "tenant-a",
        status: "ACKED",
        type: "FERTILIZATION",
        plotCode: "511723-000001-01-00002-0000-1",
        deviceId: "device-fert-002",
        ackedAt: new Date(nowMs - 30 * MINUTE).toISOString(),
        version: 3,
      }),
    ]);
    const { store, outbox, withTransaction } = makeRelay();
    const sweeper = new ControlReceiptSweeper(repository, { timeoutMin: 15, outbox, withTransaction });

    expect(await sweeper.sweepOnce(nowMs)).toBe(1);

    const records = store.all();
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.topic).toBe(EventTopic.ControlCommandTimeout);
    expect(record.tenantId).toBe("tenant-a");
    expect(record.traceId).toBe("control-timeout:cmd-evt");
    expect(record.producer).toBe("control");

    const payload = record.payload as CommandTimeoutPayload;
    expect(payload).toEqual({
      commandId: "cmd-evt",
      parcelId: "511723-000001-01-00002-0000-1",
      deviceId: "device-fert-002",
      commandType: "FERTILIZATION",
      pendingMin: 30,
      timeoutMin: 15,
      failedAt: new Date(nowMs).toISOString(),
    });
  });

  it("配置了消息表但缺事务句柄时直接拒绝装配", () => {
    const repository = new InMemoryControlCommandRepository();
    const { outbox } = makeRelay();
    expect(() => new ControlReceiptSweeper(repository, { timeoutMin: 15, outbox })).toThrow(
      "超时收口要推事件时必须配置事务句柄，避免状态与事件分家",
    );
  });

  it("带事务句柄时状态跃迁与事件入队走同一个 tx", async () => {
    const repository = new InMemoryControlCommandRepository([
      command({ id: "cmd-tx", createdAt: new Date(nowMs - 40 * MINUTE).toISOString() }),
    ]);
    const tx = fakeTx;
    const calls: Array<"transition" | "enqueue"> = [];
    const transitionTx: Array<Tx | undefined> = [];
    const stub = {
      listOverdue: async () => await repository.listOverdue(15, nowMs, 10),
      transition: async (tenantId: string, transition: Parameters<ControlCommandRepository["transition"]>[1], inTx?: Tx) => {
        calls.push("transition");
        transitionTx.push(inTx);
        return repository.transition(tenantId, transition);
      },
    } as unknown as ControlCommandRepository;
    const enqueued: unknown[] = [];
    const store = {
      async enqueue(inTx: unknown, record: unknown) {
        calls.push("enqueue");
        expect(inTx).toBe(tx);
        enqueued.push(record);
      },
    };
    const outbox = new OutboxService(store as never, new InMemoryEventPublisher(), { tenantId: "tenant-demo", traceId: "boot", producer: "control" });
    const sweeper = new ControlReceiptSweeper(stub, {
      timeoutMin: 15,
      outbox,
      withTransaction: async (run) => await run(tx),
    });

    expect(await sweeper.sweepOnce(nowMs)).toBe(1);
    expect(calls).toEqual(["transition", "enqueue"]);
    expect(transitionTx[0]).toBe(tx);
    expect(enqueued).toHaveLength(1);
  });

  it("现场回执抢先把状态推到终态时，收口被版本拦住且不留下事件", async () => {
    const repository = new InMemoryControlCommandRepository([
      command({ id: "cmd-race", status: "SENT", sentAt: new Date(nowMs - 40 * MINUTE).toISOString() }),
    ]);
    // 候选是收口任务早先捞到的快照，捞完之后设备 DONE 才姗姗到达
    const stale = (await repository.listOverdue(15, nowMs, 10))[0]!;
    expect(await repository.transition("tenant-demo", { id: stale.id, status: "DONE", at: new Date(nowMs).toISOString(), version: stale.version })).not.toBeNull();

    const { store, outbox, withTransaction } = makeRelay();
    const stub = {
      listOverdue: async () => [stale],
      transition: (tenantId: string, transition: Parameters<ControlCommandRepository["transition"]>[1], tx?: Tx) =>
        repository.transition(tenantId, transition, tx),
    } as unknown as ControlCommandRepository;
    const sweeper = new ControlReceiptSweeper(stub, { timeoutMin: 15, outbox, withTransaction });

    expect(await sweeper.sweepOnce(nowMs)).toBe(0);
    expect(store.all()).toHaveLength(0);
    expect((await repository.find("tenant-demo", "cmd-race"))?.status).toBe("DONE");
  });

  it("拖拉机候选已被现场回执收口时不再创建超时急停", async () => {
    const repository = new InMemoryControlCommandRepository([
      command({
        id: "tractor-stale", type: "SEEDING", status: "SENT",
        sentAt: new Date(nowMs - 40 * MINUTE).toISOString(),
        idempotencyKey: "tractor:job-stale:stage:stage-1",
      }),
    ]);
    const stale = (await repository.listOverdue(15, nowMs, 10))[0]!;
    expect(await repository.transition("tenant-demo", {
      id: stale.id, status: "DONE", at: new Date(nowMs).toISOString(), version: stale.version,
    })).not.toBeNull();
    const create = vi.fn(async (value: ControlCommand) => repository.create(value));
    const stub = {
      listOverdue: async () => [stale],
      find: repository.find.bind(repository),
      findByIdempotencyKey: repository.findByIdempotencyKey.bind(repository),
      create,
    } as unknown as ControlCommandRepository;
    const sweeper = new ControlReceiptSweeper(stub, { timeoutMin: 15 });

    expect(await sweeper.sweepOnce(nowMs)).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect((await repository.page("tenant-demo", { page: 1, size: 10 })).items.filter((item) => item.type === "ESTOP")).toHaveLength(0);
  });

  it("单条收口抛错只影响自己，其余指令照常收口并回调 onError", async () => {
    const repository = new InMemoryControlCommandRepository([
      command({ id: "bad", createdAt: new Date(nowMs - 40 * MINUTE).toISOString() }),
      command({ id: "good", createdAt: new Date(nowMs - 50 * MINUTE).toISOString() }),
    ]);
    const stub = {
      listOverdue: async () => await repository.listOverdue(15, nowMs, 10),
      transition: async (tenantId: string, transition: Parameters<ControlCommandRepository["transition"]>[1]) => {
        if (transition.id === "bad") throw new Error("库连接断了");
        return repository.transition(tenantId, transition);
      },
    } as unknown as ControlCommandRepository;
    const failed: string[] = [];
    const sweeper = new ControlReceiptSweeper(stub, { timeoutMin: 15, onError: (id) => failed.push(id) });

    expect(await sweeper.sweepOnce(nowMs)).toBe(1);
    expect(failed).toEqual(["bad"]);
    expect((await repository.find("tenant-demo", "good"))?.status).toBe("FAILED");
  });

  it("拖拉机超时先建急停，确认停车后才收口原指令", async () => {
    const repository = new InMemoryControlCommandRepository([
      command({
        id: "tractor-timeout",
        type: "SEEDING",
        status: "SENT",
        sentAt: new Date(nowMs - 40 * MINUTE).toISOString(),
        idempotencyKey: "tractor:job-1:stage:stage-1",
      }),
    ]);
    const errors: string[] = [];
    const sweeper = new ControlReceiptSweeper(repository, { timeoutMin: 15, onError: (_id, error) => errors.push(error.message) });

    expect(await sweeper.sweepOnce(nowMs)).toBe(0);
    expect((await repository.find("tenant-demo", "tractor-timeout"))?.status).toBe("SENT");
    const emergencyStop = await repository.findByIdempotencyKey("tenant-demo", "control-timeout-estop:tractor-timeout");
    expect(emergencyStop).toMatchObject({ type: "ESTOP", status: "QUEUED", parameters: { targetCommandId: "tractor-timeout" } });
    expect(await sweeper.sweepOnce(nowMs)).toBe(0);
    expect((await repository.page("tenant-demo", { page: 1, size: 10 })).items.filter((item) => item.type === "ESTOP")).toHaveLength(1);

    expect(await repository.transition("tenant-demo", {
      id: emergencyStop!.id,
      status: "SENT",
      at: new Date(nowMs).toISOString(),
      version: emergencyStop!.version,
    })).not.toBeNull();
    const sentEstop = await repository.find("tenant-demo", emergencyStop!.id);
    expect(await repository.transition("tenant-demo", {
      id: emergencyStop!.id,
      status: "ACKED",
      at: new Date(nowMs).toISOString(),
      version: sentEstop!.version,
    })).not.toBeNull();
    const ackedEstop = await repository.find("tenant-demo", emergencyStop!.id);
    expect(await repository.transition("tenant-demo", {
      id: emergencyStop!.id,
      status: "DONE",
      at: new Date(nowMs).toISOString(),
      version: ackedEstop!.version,
      result: { confirmed: true },
    })).not.toBeNull();
    const closed = await sweeper.sweepOnce(nowMs);
    expect(closed, errors.join("; ")).toBe(1);
    expect(errors).toEqual([]);
    expect((await repository.find("tenant-demo", "tractor-timeout"))?.status).toBe("FAILED");
    expect((await repository.find("tenant-demo", "tractor-timeout"))?.receiptMessage).toContain("已由急停指令");
  });

  it("超时急停失败或未确认时不把拖拉机原指令收口为失败", async () => {
    const repository = new InMemoryControlCommandRepository([
      command({
        id: "tractor-unsafe",
        type: "SEEDING",
        status: "ACKED",
        ackedAt: new Date(nowMs - 40 * MINUTE).toISOString(),
        idempotencyKey: "tractor:job-2:stage:stage-1",
      }),
    ]);
    const errors: string[] = [];
    const sweeper = new ControlReceiptSweeper(repository, { timeoutMin: 15, onError: (id) => errors.push(id) });
    expect(await sweeper.sweepOnce(nowMs)).toBe(0);
    const emergencyStop = await repository.findByIdempotencyKey("tenant-demo", "control-timeout-estop:tractor-unsafe");
    expect(await repository.transition("tenant-demo", {
      id: emergencyStop!.id,
      status: "FAILED",
      at: new Date(nowMs).toISOString(),
      version: emergencyStop!.version,
      message: "设备未确认停车",
    })).not.toBeNull();

    expect(await sweeper.sweepOnce(nowMs + 120 * MINUTE)).toBe(0);
    expect((await repository.find("tenant-demo", "tractor-unsafe"))?.status).toBe("ACKED");
    expect((await repository.find("tenant-demo", emergencyStop!.id))?.status).toBe("FAILED");
    const failedEstop = await repository.find("tenant-demo", emergencyStop!.id);
    const retry = await repository.findByIdempotencyKey("tenant-demo", `control-timeout-estop:tractor-unsafe:retry:${failedEstop!.id}`);
    expect(retry).toMatchObject({ type: "ESTOP", status: "QUEUED" });
    expect(errors).toEqual(["tractor-unsafe"]);

    expect(await sweeper.sweepOnce(nowMs + 240 * MINUTE)).toBe(0);
    expect(errors).toEqual(["tractor-unsafe"]);
    expect((await repository.page("tenant-demo", { page: 1, size: 10 })).items.filter((item) => item.type === "ESTOP")).toHaveLength(2);
  });

  it("失败急停的后续重试按失败指令继续链式编号，最终确认后才收口", async () => {
    const repository = new InMemoryControlCommandRepository([
      command({
        id: "tractor-chain", type: "SEEDING", status: "SENT",
        sentAt: new Date(nowMs - 40 * MINUTE).toISOString(),
        idempotencyKey: "tractor:job-chain:stage:stage-1",
      }),
    ]);
    const sweeper = new ControlReceiptSweeper(repository, { timeoutMin: 15 });
    expect(await sweeper.sweepOnce(nowMs)).toBe(0);
    const first = await repository.findByIdempotencyKey("tenant-demo", "control-timeout-estop:tractor-chain");
    expect(await repository.transition("tenant-demo", {
      id: first!.id, status: "FAILED", at: new Date(nowMs).toISOString(), version: first!.version, message: "失败",
    })).not.toBeNull();

    expect(await sweeper.sweepOnce(nowMs + MINUTE)).toBe(0);
    const secondKey = `control-timeout-estop:tractor-chain:retry:${first!.id}`;
    const second = await repository.findByIdempotencyKey("tenant-demo", secondKey);
    expect(second).toMatchObject({ type: "ESTOP", status: "QUEUED" });
    expect(await repository.transition("tenant-demo", {
      id: second!.id, status: "CANCELLED", at: new Date(nowMs + MINUTE).toISOString(), version: second!.version,
    })).not.toBeNull();

    expect(await sweeper.sweepOnce(nowMs + 2 * MINUTE)).toBe(0);
    const third = await repository.findByIdempotencyKey("tenant-demo", `control-timeout-estop:tractor-chain:retry:${second!.id}`);
    expect(third).toMatchObject({ type: "ESTOP", status: "QUEUED" });
    expect(await repository.transition("tenant-demo", {
      id: third!.id, status: "SENT", at: new Date(nowMs + 2 * MINUTE).toISOString(), version: third!.version,
    })).not.toBeNull();
    const sentThird = await repository.find("tenant-demo", third!.id);
    expect(await repository.transition("tenant-demo", {
      id: third!.id, status: "DONE", at: new Date(nowMs + 2 * MINUTE).toISOString(), version: sentThird!.version, result: { confirmed: true },
    })).not.toBeNull();

    expect(await sweeper.sweepOnce(nowMs + 3 * MINUTE)).toBe(1);
    expect((await repository.find("tenant-demo", "tractor-chain"))?.status).toBe("FAILED");
    expect((await repository.page("tenant-demo", { page: 1, size: 10 })).items.filter((item) => item.type === "ESTOP")).toHaveLength(3);
  });

  it.each([
    ["异设备", { deviceId: "device-other" }],
    ["错误目标", { parameters: { targetCommandId: "other-job" } }],
    ["非急停类型", { type: "SEEDING" }],
    ["人工来源", { origin: "MANUAL", operatorId: "user-admin" }],
  ] as const)("超时急停幂等键被%s伪造时保持原作业未收口", async (_label, overrides) => {
    const repository = new InMemoryControlCommandRepository([
      command({
        id: "tractor-spoof", type: "SEEDING", status: "SENT",
        sentAt: new Date(nowMs - 40 * MINUTE).toISOString(),
        idempotencyKey: "tractor:job-spoof:stage:stage-1",
      }),
      command({
        id: "fake-estop", type: "ESTOP", status: "QUEUED", origin: "EVENT", operatorId: "system-timeout",
        parameters: { targetCommandId: "tractor-spoof" },
        idempotencyKey: "control-timeout-estop:tractor-spoof",
        createdAt: new Date(nowMs - 39 * MINUTE).toISOString(),
        ...overrides,
      }),
    ]);
    const errors: string[] = [];
    const sweeper = new ControlReceiptSweeper(repository, { timeoutMin: 15, onError: (_id, error) => errors.push(error.message) });

    expect(await sweeper.sweepOnce(nowMs)).toBe(0);
    expect((await repository.find("tenant-demo", "tractor-spoof"))?.status).toBe("SENT");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("非预期指令");
  });

  it("已结单但未确认停车的急停不会收口原作业，而是创建下一轮急停", async () => {
    const repository = new InMemoryControlCommandRepository([
      command({
        id: "tractor-unconfirmed", type: "SEEDING", status: "SENT",
        sentAt: new Date(nowMs - 40 * MINUTE).toISOString(),
        idempotencyKey: "tractor:job-unconfirmed:stage:stage-1",
      }),
      command({
        id: "unconfirmed-estop", type: "ESTOP", status: "DONE", origin: "EVENT", operatorId: "system-timeout",
        parameters: { targetCommandId: "tractor-unconfirmed" },
        idempotencyKey: "control-timeout-estop:tractor-unconfirmed",
        result: { stoppedConfirmed: true }, finishedAt: new Date(nowMs - MINUTE).toISOString(),
        createdAt: new Date(nowMs - 39 * MINUTE).toISOString(),
      }),
    ]);
    const sweeper = new ControlReceiptSweeper(repository, { timeoutMin: 15 });

    expect(await sweeper.sweepOnce(nowMs)).toBe(0);
    expect((await repository.find("tenant-demo", "tractor-unconfirmed"))?.status).toBe("SENT");
    expect(await repository.findByIdempotencyKey("tenant-demo", `control-timeout-estop:tractor-unconfirmed:retry:unconfirmed-estop`))
      .toMatchObject({ type: "ESTOP", status: "QUEUED" });
  });

  it("等待急停的旧拖拉机指令不会饿死后续普通超时候选", async () => {
    const repository = new InMemoryControlCommandRepository([
      command({ id: "a-tractor", type: "SEEDING", createdAt: new Date(nowMs - 40 * MINUTE).toISOString(), idempotencyKey: "tractor:job-a:stage:1" }),
      command({ id: "b-tractor", type: "SEEDING", createdAt: new Date(nowMs - 40 * MINUTE).toISOString(), idempotencyKey: "tractor:job-b:stage:1" }),
      command({ id: "z-normal", type: "IRRIGATION", createdAt: new Date(nowMs - 40 * MINUTE).toISOString() }),
    ]);
    const sweeper = new ControlReceiptSweeper(repository, { timeoutMin: 15, batchSize: 2 });

    expect(await sweeper.sweepOnce(nowMs)).toBe(0);
    expect(await sweeper.sweepOnce(nowMs)).toBe(1);
    expect((await repository.find("tenant-demo", "z-normal"))?.status).toBe("FAILED");
    expect((await repository.find("tenant-demo", "a-tractor"))?.status).toBe("QUEUED");
    expect((await repository.find("tenant-demo", "b-tractor"))?.status).toBe("QUEUED");
  });

  it("人工拖拉机安全急停按普通指令收口，不再创建指向急停的急停", async () => {
    const repository = new InMemoryControlCommandRepository([
      command({
        id: "manual-estop",
        type: "ESTOP",
        status: "SENT",
        sentAt: new Date(nowMs - 40 * MINUTE).toISOString(),
        idempotencyKey: "tractor:job-3:safety:ESTOP:attempt-1",
      }),
    ]);
    const sweeper = new ControlReceiptSweeper(repository, { timeoutMin: 15 });

    expect(await sweeper.sweepOnce(nowMs)).toBe(1);
    expect((await repository.find("tenant-demo", "manual-estop"))?.status).toBe("FAILED");
    expect((await repository.page("tenant-demo", { page: 1, size: 10 })).items.filter((item) => item.type === "ESTOP")).toHaveLength(1);
  });

  it("跨租户候选各按行内租户收口，不用进程配置的租户", async () => {
    const repository = new InMemoryControlCommandRepository([
      command({ id: "cmd-t1", tenantId: "tenant-one", createdAt: new Date(nowMs - 40 * MINUTE).toISOString() }),
      command({ id: "cmd-t2", tenantId: "tenant-two", createdAt: new Date(nowMs - 60 * MINUTE).toISOString() }),
    ]);
    const { store, outbox, withTransaction } = makeRelay();
    const sweeper = new ControlReceiptSweeper(repository, { timeoutMin: 15, outbox, withTransaction });

    expect(await sweeper.sweepOnce(nowMs)).toBe(2);
    expect((await repository.find("tenant-one", "cmd-t1"))?.status).toBe("FAILED");
    expect((await repository.find("tenant-two", "cmd-t2"))?.status).toBe("FAILED");
    expect(store.all().map((record) => record.tenantId).sort()).toEqual(["tenant-one", "tenant-two"]);
    // 内存仓储不吃事务句柄，withTransaction 只是满足「消息表 + 事务」成对装配的口径
  });
});
