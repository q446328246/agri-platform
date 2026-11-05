import { describe, expect, it } from "vitest";
import {
  hasPermission,
  mergePermissions,
  parsePermissionHeader,
  PERMISSION_CATALOG,
  PERMISSION_CODES,
  serializePermissions,
} from "../src/authz/index.js";

describe("权限目录", () => {
  it("权限码唯一且命名规范，目录扁平化与编码清单一致", () => {
    const flattened = PERMISSION_CATALOG.flatMap((group) => group.items.map((item) => item.code));
    expect(new Set(flattened).size).toBe(flattened.length);
    expect(flattened.every((code) => /^[a-z]+:[a-z]+$/.test(code))).toBe(true);
    expect(PERMISSION_CODES).toEqual(flattened);
    expect(PERMISSION_CODES).toContain("system:role");
    expect(PERMISSION_CODES).toContain("device:control");
  });
});

describe("hasPermission", () => {
  it("精确匹配、全量通配与领域通配都放行", () => {
    expect(hasPermission(["plot:read"], "plot:read")).toBe(true);
    expect(hasPermission(["*"], "finance:write")).toBe(true);
    expect(hasPermission(["telemetry:*"], "telemetry:write")).toBe(true);
  });

  it("缺少权限或只通配相邻领域时拒绝", () => {
    expect(hasPermission(["plot:read"], "plot:write")).toBe(false);
    expect(hasPermission(["telemetry:*"], "telemetryx:read")).toBe(false);
    expect(hasPermission([], "plot:read")).toBe(false);
    expect(hasPermission(["plot"], "plot:read")).toBe(false);
  });

  it("未声明所需权限时视为无需校验", () => {
    expect(hasPermission([], "")).toBe(true);
  });
});

describe("权限头编解码", () => {
  it("解析时去空白、去空项并去重", () => {
    expect(parsePermissionHeader(undefined)).toEqual([]);
    expect(parsePermissionHeader("   ")).toEqual([]);
    expect(parsePermissionHeader(" plot:read , device:control,plot:read ")).toEqual(["plot:read", "device:control"]);
  });

  it("序列化去重且保留首次出现顺序", () => {
    expect(serializePermissions(["device:control", "*", "device:control"])).toBe("device:control,*");
    expect(serializePermissions([])).toBe("");
  });

  it("合并多组权限时去重并保留首次出现顺序", () => {
    expect(mergePermissions(["plot:read"], ["plot:read", "device:read"], [])).toEqual(["plot:read", "device:read"]);
    expect(mergePermissions()).toEqual([]);
  });
});
