/**
 * 幂等去重。
 *
 * 本地消息表与消息中间件都只能保证「至少一次」投递，重复消费是必然出现的
 * 正常现象，不是异常。因此把幂等收口到本层统一承担，业务代码不自行判断，
 * 否则每个消费者都要重复实现一遍，且很容易写错。
 */

/** 去重存储契约，生产环境由缓存中间件实现 */
export interface IdempotencyStore {
  /** 判断键是否已存在 */
  has(key: string): Promise<boolean>;
  /** 写入键并设置过期时长 */
  set(key: string, ttlMs: number): Promise<void>;
}

/** 默认保留期：七天，覆盖绝大多数重试与人工补发场景 */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 幂等守卫 */
export class IdempotencyGuard {
  private readonly store: IdempotencyStore;

  private readonly ttlMs: number;

  private readonly prefix: string;

  constructor(store: IdempotencyStore, options: { ttlMs?: number; prefix?: string } = {}) {
    this.store = store;
    this.ttlMs = options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    this.prefix = options.prefix ?? "mq:idem:";
  }

  /**
   * 判断事件是否已处理过；未处理过时同时写入标记，避免并发重复处理。
   * @param eventId 事件标识
   * @returns 已处理过返回 true
   */
  async isDuplicate(eventId: string): Promise<boolean> {
    const key = this.prefix + eventId;
    if (await this.store.has(key)) {
      return true;
    }
    await this.store.set(key, this.ttlMs);
    return false;
  }

  /** 仅写入标记，用于处理成功后补记 */
  async mark(eventId: string): Promise<void> {
    await this.store.set(this.prefix + eventId, this.ttlMs);
  }
}

/** 内存去重存储，用于测试与本地开发 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly keys = new Map<string, number>();

  /** 已写入的键数量，供断言使用 */
  get size(): number {
    return this.keys.size;
  }

  async has(key: string): Promise<boolean> {
    const expiresAt = this.keys.get(key);
    if (expiresAt === undefined) {
      return false;
    }
    if (expiresAt < Date.now()) {
      this.keys.delete(key);
      return false;
    }
    return true;
  }

  async set(key: string, ttlMs: number): Promise<void> {
    this.keys.set(key, Date.now() + ttlMs);
  }

  /** 清空全部键 */
  clear(): void {
    this.keys.clear();
  }
}
