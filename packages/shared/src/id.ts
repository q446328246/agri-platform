import { randomBytes } from "node:crypto";

/**
 * 标识生成。
 *
 * 分工明确：事件标识、请求标识使用按时间有序的 ULID，便于排序与排查；
 * 业务主键使用雪花算法生成，返回字符串形式以避免超出前端数值安全范围。
 */

/** Crockford Base32 字符集，去除易混淆的 I、L、O、U */
const ULID_CHARSET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 雪花算法起始纪元：2025-01-01T00:00:00Z */
const SNOWFLAKE_EPOCH = 1735689600000;

let lastTimestamp = -1;

let sequence = 0;

/**
 * 生成 ULID：按时间有序、长度固定 26 位。
 * @param time 时间戳，默认当前时间
 * @returns 26 位 ULID 字符串
 */
export function ulid(time: number = Date.now()): string {
  let rest = Math.floor(time);
  let head = "";
  for (let i = 0; i < 10; i += 1) {
    head = ULID_CHARSET.charAt(rest % 32) + head;
    rest = Math.floor(rest / 32);
  }

  // 80 位随机部分切分为 16 个 5 位组，保证分布均匀
  const bytes = randomBytes(10);
  let bits = 0n;
  for (const byte of bytes) {
    bits = (bits << 8n) | BigInt(byte);
  }
  let tail = "";
  for (let i = 0; i < 16; i += 1) {
    tail = ULID_CHARSET.charAt(Number(bits & 31n)) + tail;
    bits >>= 5n;
  }
  return head + tail;
}

/**
 * 生成雪花算法主键。
 * @returns 十进制字符串形式的主键
 */
export function snowflakeId(): string {
  let timestamp = Date.now();
  if (timestamp < lastTimestamp) {
    // 时钟回拨时沿用上一时刻，保证单调递增
    timestamp = lastTimestamp;
  }
  if (timestamp === lastTimestamp) {
    sequence = (sequence + 1) & 0xfff;
    if (sequence === 0) {
      lastTimestamp += 1;
      timestamp = lastTimestamp;
    }
  } else {
    lastTimestamp = timestamp;
    sequence = 0;
  }
  const id = (BigInt(timestamp - SNOWFLAKE_EPOCH) << 22n) | (1n << 17n) | (1n << 12n) | BigInt(sequence);
  return id.toString();
}
