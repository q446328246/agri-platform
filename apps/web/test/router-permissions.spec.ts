import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateTs } from "./view-harness.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const permissionUrl = new URL("../src/utils/permission.ts", import.meta.url);
const permission = evaluateTs(readFileSync(permissionUrl, "utf8"), permissionUrl.pathname, {});

function loadGuard(granted: string[]) {
  let routes: any[] = [];
  let guard: (to: any, from: any, next: (target?: any) => void) => void = () => {};
  const routerUrl = new URL("../src/router/index.ts", import.meta.url);
  evaluateTs(readFileSync(routerUrl, "utf8"), routerUrl.pathname, {
    "vue-router": {
      createWebHistory: () => ({}),
      createRouter: (options: any) => {
        routes = options.routes;
        return { beforeEach: (fn: typeof guard) => { guard = fn; } };
      },
    },
    "@/utils/permission": { ...permission, cachedPermissions: () => granted },
  });
  vi.stubGlobal("document", { title: "" });
  vi.stubGlobal("localStorage", { getItem: (key: string) => key === "token" ? "test-token" : null });
  const device = routes.find((route) => route.path === "/").children.find((route: any) => route.path === "device");
  const irrigation = device.children.find((route: any) => route.path === "irrigation");
  return { irrigation, guard };
}

describe("路由多权限守卫", () => {
  it("灌溉页同时要求 device:read 与 device:control", () => {
    const { irrigation, guard } = loadGuard(["device:read", "device:control"]);
    expect(irrigation.meta.permissions).toEqual(["device:read", "device:control"]);

    const next = vi.fn();
    guard({ meta: irrigation.meta }, {}, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("只具备读或只具备控制都不能进入灌溉页", () => {
    for (const granted of [["device:read"], ["device:control"]]) {
      const { irrigation, guard } = loadGuard(granted);
      const next = vi.fn();
      guard({ meta: irrigation.meta }, {}, next);
      expect(next).toHaveBeenCalledWith({ path: "/403", replace: true });
    }
  });

  it("既有单 permission 路由仍按原规则放行或拒绝", () => {
    const allowed = loadGuard(["dashboard:read"]);
    const allowedNext = vi.fn();
    allowed.guard({ meta: { permission: "dashboard:read" } }, {}, allowedNext);
    expect(allowedNext).toHaveBeenCalledWith();

    const denied = loadGuard([]);
    const deniedNext = vi.fn();
    denied.guard({ meta: { permission: "dashboard:read" } }, {}, deniedNext);
    expect(deniedNext).toHaveBeenCalledWith({ path: "/403", replace: true });
  });
});
