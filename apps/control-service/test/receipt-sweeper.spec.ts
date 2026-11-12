import { describe, expect, it } from "vitest";

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
    expect((await repository.find("tenant-demo", "queued-40"))?.receiptMessage).toBe("超过 15 分钟未收到设备回执（已等待 40 分钟），系统自动收口为失败");
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
