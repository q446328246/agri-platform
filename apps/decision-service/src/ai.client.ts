/**
 * AI 问答通道（C4 增强）：OpenAI 兼容 chat/completions 客户端。
 *
 * 凭据不全时 buildAiChatFromEnv 返回 undefined，调用方降级规则式回答，服务照常启动；
 * 调用失败解析并透传远端错误信息，由 /ask 捕获后降级，不中断问答。
 */

export interface AiChatConfig {
  /** OpenAI 兼容根地址（含 /v1），如 https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiChatClient {
  readonly model: string;
  chat(messages: AiChatMessage[]): Promise<string>;
}

/** 从环境变量解析 AI 配置：BASE_URL/KEY/MODEL 缺一即视为未启用 */
export function buildAiChatFromEnv(env: Record<string, string | undefined>): AiChatConfig | undefined {
  const baseUrl = (env.AI_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const apiKey = (env.AI_API_KEY ?? "").trim();
  const model = (env.AI_MODEL ?? "").trim();
  if (!baseUrl || !apiKey || !model) return undefined;
  const timeout = Number(env.AI_TIMEOUT_MS);
  return { baseUrl, apiKey, model, timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.round(timeout) : 30000 };
}

interface ChatCompletionResponse {
  error?: { message?: unknown };
  message?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
}

export function createAiChatClient(config: AiChatConfig): AiChatClient {
  return {
    model: config.model,
    async chat(messages) {
      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, messages, temperature: 0.3, stream: false }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      const text = await res.text();
      let parsed: ChatCompletionResponse | undefined;
      try {
        parsed = JSON.parse(text) as ChatCompletionResponse;
      } catch {
        parsed = undefined;
      }
      if (!res.ok) {
        const detail = typeof parsed?.error?.message === "string" ? parsed.error.message
          : typeof parsed?.message === "string" ? parsed.message
          : text.slice(0, 200);
        throw new Error(`AI 服务调用失败（HTTP ${res.status}）：${detail}`);
      }
      const content = parsed?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") throw new Error("AI 服务返回空回答");
      return content.trim();
    },
  };
}