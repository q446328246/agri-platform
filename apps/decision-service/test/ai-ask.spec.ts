import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";

import { createDecisionHttpServer } from "../src/http.js";
import type { DecisionDependencies } from "../src/http.js";
import { buildAiChatFromEnv, createAiChatClient } from "../src/ai.client.js";
import type { AiChatClient, AiChatMessage } from "../src/ai.client.js";

async function withServer(run: (base: string) => Promise<void>, dependencies: Partial<DecisionDependencies> = {}): Promise<void> {
  const server = createDecisionHttpServer(dependencies);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    await run(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function ask(base: string, question: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}/api/v1/decision/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
  });
  return { status: response.status, body: await response.json() };
}

describe("AI 配置容错解析", () => {
  it("凭据不全返回 undefined，服务降级不启用 AI", () => {
    expect(buildAiChatFromEnv({})).toBeUndefined();
    expect(buildAiChatFromEnv({ AI_API_KEY: "sk-test", AI_MODEL: "m" })).toBeUndefined();
    expect(buildAiChatFromEnv({ AI_API_BASE_URL: "https://example.test/v1", AI_MODEL: "m" })).toBeUndefined();
    expect(buildAiChatFromEnv({ AI_API_BASE_URL: "https://example.test/v1", AI_API_KEY: "sk-test" })).toBeUndefined();
  });

  it("配置齐全时去除 baseUrl 尾斜杠，超时缺省 30s", () => {
    const config = buildAiChatFromEnv({ AI_API_BASE_URL: "https://example.test/v1/", AI_API_KEY: "sk-test", AI_MODEL: "m" });
    expect(config).toEqual({ baseUrl: "https://example.test/v1", apiKey: "sk-test", model: "m", timeoutMs: 30000 });
    const custom = buildAiChatFromEnv({ AI_API_BASE_URL: "https://example.test/v1", AI_API_KEY: "sk-test", AI_MODEL: "m", AI_TIMEOUT_MS: "5000" });
    expect(custom?.timeoutMs).toBe(5000);
    const invalid = buildAiChatFromEnv({ AI_API_BASE_URL: "https://example.test/v1", AI_API_KEY: "sk-test", AI_MODEL: "m", AI_TIMEOUT_MS: "abc" });
    expect(invalid?.timeoutMs).toBe(30000);
  });
});

describe("AI 客户端调用", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("按 OpenAI 兼容口径请求并取回回答", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: " 灌溉定额参考 10–30 毫米/次。 " } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createAiChatClient({ baseUrl: "https://example.test/v1", apiKey: "sk-test", model: "m", timeoutMs: 1000 });
    const answer = await client.chat([{ role: "user", content: "灌溉定额？" }]);
    expect(answer).toBe("灌溉定额参考 10–30 毫米/次。");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.test/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(JSON.parse(String(init.body)).model).toBe("m");
  });

  it("远端错误透传错误信息，空回答视为失败", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 })));
    const client = createAiChatClient({ baseUrl: "https://example.test/v1", apiKey: "sk-bad", model: "m", timeoutMs: 1000 });
    await expect(client.chat([{ role: "user", content: "q" }])).rejects.toThrow("invalid api key");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 })));
    await expect(client.chat([{ role: "user", content: "q" }])).rejects.toThrow("空回答");
  });
});

describe("智能问答 AI 链路与降级", () => {
  it("未配置 AI 时保持规则式回答并标记 mode=rule", async () => {
    await withServer(async (base) => {
      const { status, body } = await ask(base, "灌溉定额是多少");
      expect(status).toBe(200);
      expect(body.data.mode).toBe("rule");
      expect(body.data.answer).toContain("【灌溉定额】");
      expect(body.data.sources).toContain("灌溉定额");
    });
  });

  it("配置 AI 后走 RAG：提示词携带知识条目与规则上下文，回答标记 mode=ai", async () => {
    const chat = vi.fn(async (_messages: AiChatMessage[]) => "依据【灌溉定额】，一般 10–30 毫米/次。");
    const ai: AiChatClient = { model: "test-model", chat };
    await withServer(async (base) => {
      const { status, body } = await ask(base, "灌溉定额是多少");
      expect(status).toBe(200);
      expect(body.data.mode).toBe("ai");
      expect(body.data.answer).toContain("【灌溉定额】");
      expect(body.data.sources).toContain("灌溉定额");
    }, { ai });
    const messages = chat.mock.calls[0][0];
    expect(messages[0].role).toBe("system");
    expect(messages[1].content).toContain("【灌溉定额】");
    expect(messages[1].content).toContain("当前地块最近命中规则");
    expect(messages[1].content).toContain("灌溉定额是多少");
  });

  it("AI 调用失败自动降级规则式回答，问答不中断", async () => {
    const ai: AiChatClient = { model: "test-model", chat: async () => { throw new Error("AI 服务调用失败（HTTP 500）：upstream"); } };
    await withServer(async (base) => {
      const { status, body } = await ask(base, "灌溉定额是多少");
      expect(status).toBe(200);
      expect(body.data.mode).toBe("rule");
      expect(body.data.answer).toContain("【灌溉定额】");
    }, { ai });
  });

  it("未命中知识条目时 AI 仍可基于规则上下文作答", async () => {
    const ai: AiChatClient = { model: "test-model", chat: async () => "请补充地块与作物生育期信息。" };
    await withServer(async (base) => {
      const { status, body } = await ask(base, "今天食堂吃什么");
      expect(status).toBe(200);
      expect(body.data.mode).toBe("ai");
      expect(body.data.answer).toContain("请补充地块");
    }, { ai });
  });
});