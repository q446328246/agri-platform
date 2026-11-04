import { EventTopic } from "@agri/contracts";
import type { DomainEvent } from "@agri/contracts";
import { describe, expect, it } from "vitest";

import {
  buildHandlers,
  EventDispatcher,
  IdempotencyGuard,
  InMemoryEventPublisher,
  InMemoryIdempotencyStore,
  InMemoryOutboxStore,
  OutboxService,
  registerHandler,
} from "../src/index.js";

/**
 * 消息封装的契约测试。
 * 拆分两次来看：一次解决「事件不丢」，一次解决「事件不重」；
 * 前者由本地消息表保证，后者由消费侧幂等保证，两者必须同时成立。
 */

/** 构造一个带信封的示例事件 */
function makeEvent(eventId = "01J0TESTEVENT0000000000"): DomainEvent<{ parcelCode: string }> {
  return {
    eventId,
    topic: EventTopic.PlotCreated,
    version: 1,
    occurredAt: "2026-01-01T00:00:00.000Z",
    producer: "plot",
    tenantId: "tenant-demo",
    traceId: "trace-demo",
    payload: { parcelCode: "511723-000001-01-00001-0000-5" },
  };
}

describe("本地消息表", () => {
  it("事务内入队，中继后标记已投递", async () => {
    const publisher = new InMemoryEventPublisher();
    const store = new InMemoryOutboxStore();
    const outbox = new OutboxService(store, publisher, { tenantId: "t", traceId: "tr", producer: "plot" });

    await outbox.enqueue({}, EventTopic.PlotCreated, { parcelCode: "511723-000001-01-00001-0000-5" });
    expect((await store.listPending(10)).length).toBe(1);

    expect(await outbox.relayOnce()).toBe(1);
    expect(publisher.published).toHaveLength(1);
    expect(store.all()[0]?.publishedAt).toBeDefined();
    expect(await store.listPending(10)).toHaveLength(0);
  });

  it("投递失败时记录原因与次数，等待下一轮重发", async () => {
    const publisher = new InMemoryEventPublisher();
    publisher.failNext = true;
    const store = new InMemoryOutboxStore();
    const outbox = new OutboxService(store, publisher, { tenantId: "t", traceId: "tr", producer: "plot" });

    await outbox.enqueue({}, EventTopic.PlotCreated, {});
    expect(await outbox.relayOnce()).toBe(0);

    const record = store.all()[0];
    expect(record?.retryCount).toBe(1);
    expect(record?.lastError).toBeDefined();
    expect(record?.publishedAt).toBeUndefined();

    // 下一轮应能补投成功
    expect(await outbox.relayOnce()).toBe(1);
  });
});

describe("消费侧幂等与重试", () => {
  it("同一事件第二次到达时被幂等拦下", async () => {
    const guard = new IdempotencyGuard(new InMemoryIdempotencyStore());
    expect(await guard.isDuplicate("event-1")).toBe(false);
    expect(await guard.isDuplicate("event-1")).toBe(true);
  });

  it("处理器失败按策略重试，成功后不再重复执行", async () => {
    let calls = 0;
    const dispatcher = new EventDispatcher({
      idempotency: new IdempotencyGuard(new InMemoryIdempotencyStore()),
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, deadLetterAfterMaxAttempts: true },
    });
    dispatcher.subscribe(EventTopic.PlotCreated, async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("依赖服务暂时不可用");
      }
    });

    const event = makeEvent();
    await dispatcher.dispatch(event);
    expect(calls).toBe(3);

    // 已处理过的事件再次投递不应触发处理器
    await dispatcher.dispatch(event);
    expect(calls).toBe(3);
  });

  it("超过最大尝试次数后转入死信，不阻塞后续事件", async () => {
    const dead: string[] = [];
    const dispatcher = new EventDispatcher({
      idempotency: new IdempotencyGuard(new InMemoryIdempotencyStore()),
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, deadLetterAfterMaxAttempts: true },
      deadLetter: async (event) => {
        dead.push(event.eventId);
      },
    });
    dispatcher.subscribe(EventTopic.PlotCreated, async () => {
      throw new Error("永久失败");
    });

    await dispatcher.dispatch(makeEvent("01J0DEADEVENT0000000000"));
    expect(dead).toEqual(["01J0DEADEVENT0000000000"]);
  });

  it("装饰器登记的处理方法可被组装为订阅", async () => {
    class Consumer {
      handled: string[] = [];

      @registerHandler(EventTopic.PlotCreated)
      async onPlotCreated(event: DomainEvent<{ parcelCode: string }>): Promise<void> {
        this.handled.push(event.payload.parcelCode);
      }
    }

    const consumer = new Consumer();
    const handlers = buildHandlers(consumer);
    expect(handlers).toHaveLength(1);
    const handler = handlers[0];
    expect(handler?.topic).toBe(EventTopic.PlotCreated);
    await handler?.handler(makeEvent());
    expect(consumer.handled).toEqual(["511723-000001-01-00001-0000-5"]);
  });
});
