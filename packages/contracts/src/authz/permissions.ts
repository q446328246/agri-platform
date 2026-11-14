/**
 * 权限目录与权限判定。
 *
 * 权限是平台级契约：角色页面勾选、网关拦截、服务侧守卫与前端菜单都依赖同一份编码，
 * 因此目录放在契约包，只做纯函数判定，不依赖任何能力包。
 *
 * 命名规则 `<领域>:<动作>`；`*` 代表全部权限，`领域:*` 代表该领域全部动作，
 * 便于后续按领域授予而不必逐个列举。
 */

/** 权限分组，角色页按分组渲染勾选项 */
export interface PermissionGroup {
  group: string;
  items: Array<{ code: string; name: string }>;
}

/** 通配符权限：管理员固定持有 */
export const ALL_PERMISSIONS = "*";

/** 权限目录：新增接口权限时先登记在这里，未知编码会被角色接口拒绝 */
export const PERMISSION_CATALOG: PermissionGroup[] = [
  { group: "一张图", items: [{ code: "dashboard:read", name: "查看一张图看板" }] },
  { group: "地块与基础信息", items: [{ code: "plot:read", name: "查询地块" }, { code: "plot:write", name: "维护地块" }] },
  {
    group: "感知与气象",
    items: [
      { code: "telemetry:read", name: "查询遥测与告警" },
      { code: "telemetry:write", name: "上报遥测与处理告警" },
      { code: "weather:read", name: "查询气象预报" },
      { code: "weather:sync", name: "强制同步和风天气（管理员）" },
    ],
  },
  {
    group: "设备与作业",
    items: [
      { code: "device:read", name: "查询设备" },
      { code: "device:control", name: "下发设备控制指令" },
      { code: "operation:read", name: "查询农事任务" },
      { code: "operation:write", name: "维护农事任务" },
    ],
  },
  { group: "智能决策", items: [{ code: "decision:read", name: "查看规则与处方" }, { code: "decision:write", name: "维护规则与处方" }] },
  {
    group: "核算与溯源",
    items: [
      { code: "finance:read", name: "查询投入产出" },
      { code: "finance:write", name: "登记投入产出" },
      { code: "trace:read", name: "查询溯源档案" },
      { code: "trace:write", name: "写入溯源档案" },
    ],
  },
  { group: "消息中心", items: [{ code: "message:read", name: "查看消息" }, { code: "message:write", name: "发布消息" }] },
  { group: "系统管理", items: [{ code: "system:user", name: "管理用户" }, { code: "system:role", name: "管理角色" }, { code: "system:audit", name: "查看审计日志" }, { code: "system:backup", name: "管理备份与恢复" }] },
];

/** 权限码联合类型 */
export type PermissionCode =
  | "dashboard:read"
  | "plot:read"
  | "plot:write"
  | "telemetry:read"
  | "telemetry:write"
  | "weather:read"
  | "weather:sync"
  | "device:read"
  | "device:control"
  | "operation:read"
  | "operation:write"
  | "decision:read"
  | "decision:write"
  | "finance:read"
  | "finance:write"
  | "trace:read"
  | "trace:write"
  | "message:read"
  | "message:write"
  | "system:user"
  | "system:role"
  | "system:audit"
  | "system:backup";

/** 目录内的全部权限码 */
export const PERMISSION_CODES: string[] = PERMISSION_CATALOG.flatMap((group) => group.items.map((item) => item.code));

/** 判断编码是否在目录内 */
export function isPermissionCode(value: string): value is PermissionCode {
  return PERMISSION_CODES.includes(value);
}

/**
 * 判断持有权限是否覆盖所需权限。
 * 支持 `*` 与 `领域:*` 通配，空列表视为无权限。
 */
export function hasPermission(granted: readonly string[], required: string): boolean {
  if (!required) return true;
  for (const code of granted) {
    if (code === ALL_PERMISSIONS || code === required) return true;
    if (code.endsWith(":*") && required.startsWith(code.slice(0, -1))) return true;
  }
  return false;
}

/** 从网关透传的 `x-permissions` 头解析权限列表 */
export function parsePermissionHeader(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter((item) => item.length > 0))];
}

/** 把权限列表编码为 `x-permissions` 头 */
export function serializePermissions(permissions: readonly string[]): string {
  return [...new Set(permissions)].join(",");
}

/** 合并直接授予与角色权限，去重后保留首次出现的顺序 */
export function mergePermissions(...groups: ReadonlyArray<readonly string[] | undefined>): string[] {
  const merged = new Set<string>();
  for (const group of groups) for (const code of group ?? []) merged.add(code);
  return [...merged];
}
