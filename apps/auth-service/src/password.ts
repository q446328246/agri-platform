import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * 口令散列：scrypt + 每口令独立随机盐。
 *
 * 存储格式 `scrypt$N$r$p$saltHex$hashHex`，参数随散列一起保存，
 * 将来提高强度只需改常量，`needsRehash` 会识别旧参数并在登录时重算。
 *
 * 历史数据是 `sha256("agri:" + password)` 的 64 位十六进制，`verifyPassword`
 * 仍然兼容，调用方在登录成功后按 `needsRehash` 触发一次升级，
 * 因此不需要批量改密或停机迁移。
 */

/** CPU/内存代价参数，按 OWASP 建议的 scrypt 下限取值 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
/** scrypt 需要 128 * N * r 字节，默认 maxmem 32MB 刚好卡线，这里放宽到 64MB */
const MAX_MEM = 64 * 1024 * 1024;

/** 开发期 sha256 方案，仅用于兼容校验历史散列 */
function legacyHash(password: string): string {
  return createHash("sha256").update(`agri:${password}`).digest("hex");
}

/** 定长时间比较十六进制串，长度不同直接判否（避免抛错泄露信息） */
function equalsHex(left: string, right: string): boolean {
  if (left.length === 0 || left.length !== right.length) return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function derive(password: string, salt: Buffer, keyLength: number, n: number, r: number, p: number): string {
  return scryptSync(password, salt, keyLength, { N: n, r, p, maxmem: MAX_MEM }).toString("hex");
}

/** 生成带随机盐的强散列，同一口令每次结果不同 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = derive(password, salt, KEY_LENGTH, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${hash}`;
}

/**
 * 校验口令，兼容旧的 sha256 散列。
 * 无法识别的格式一律判否，不抛异常，避免坏数据打断登录流程。
 */
export function verifyPassword(password: string, stored: string): boolean {
  if (!stored) return false;
  if (!stored.startsWith("scrypt$")) return equalsHex(legacyHash(password), stored);
  const parts = stored.split("$");
  if (parts.length !== 6) return false;
  const [, n, r, p, salt, hash] = parts;
  if (!n || !r || !p || !salt || !hash) return false;
  const cost = Number(n);
  const blockSize = Number(r);
  const parallel = Number(p);
  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallel)) return false;
  if (cost <= 0 || blockSize <= 0 || parallel <= 0) return false;
  try {
    return equalsHex(derive(password, Buffer.from(salt, "hex"), hash.length / 2, cost, blockSize, parallel), hash);
  } catch {
    return false;
  }
}

/** 是否为当前强度参数；旧 sha256 与旧参数都返回 true，由登录流程重算 */
export function needsRehash(stored: string): boolean {
  return !stored.startsWith(`scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$`);
}
