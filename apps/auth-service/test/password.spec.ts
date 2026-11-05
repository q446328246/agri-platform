import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hashPassword, needsRehash, verifyPassword } from "../src/password.js";

/**
 * 口令散列测试：固定三个容易退化的约定——
 * 每次散列必须换盐、旧 sha256 散列仍能校验、参数过期要能被识别。
 */

describe("口令散列", () => {
  it("scrypt 散列带随机盐，同一口令两次结果不同但都能校验", () => {
    const first = hashPassword("admin123");
    const second = hashPassword("admin123");

    expect(first.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(first).not.toBe(second);
    expect(verifyPassword("admin123", first)).toBe(true);
    expect(verifyPassword("admin123", second)).toBe(true);
  });

  it("错误口令、空口令与损坏散列一律拒绝", () => {
    const stored = hashPassword("admin123");

    expect(verifyPassword("admin12", stored)).toBe(false);
    expect(verifyPassword("", stored)).toBe(false);
    expect(verifyPassword("admin123", "")).toBe(false);
    expect(verifyPassword("admin123", "scrypt$bad")).toBe(false);
    expect(verifyPassword("admin123", "scrypt$0$8$1$aa$bb")).toBe(false);
    expect(verifyPassword("admin123", "not-a-hash")).toBe(false);
  });

  it("兼容旧的 sha256 散列，并标记为需要重算", () => {
    const legacy = createHash("sha256").update("agri:admin123").digest("hex");

    expect(verifyPassword("admin123", legacy)).toBe(true);
    expect(verifyPassword("wrong", legacy)).toBe(false);
    expect(needsRehash(legacy)).toBe(true);
    expect(needsRehash(hashPassword("admin123"))).toBe(false);
  });
});
