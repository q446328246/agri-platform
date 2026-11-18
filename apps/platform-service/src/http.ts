import fs from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse } from "@agri/contracts";
import { PERMISSION_CATALOG } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";

import { InMemoryAuditRepository, InMemoryRoleRepository, MIN_AUDIT_RETENTION_DAYS, resolveAuditRetentionDays, seedRoles } from "./role.repository.js";
import type { AuditRecord, AuditRepository, RoleRecord, RoleRepository } from "./role.repository.js";
import { DATA_ASSET_CATEGORIES, InMemoryDataCatalogRepository, seedDataCatalog } from "./data-catalog.repository.js";
import type { DataAsset, DataAssetCategory, DataCatalogRepository, DataDictionaryEntry } from "./data-catalog.repository.js";
import { backupArchive, listBackups, readBackup, readBackupPart, removeBackup, runBackup, runRestore } from "./backup.js";

/**
 * 平台服务 HTTP 接口：租户信息、权限目录、角色管理与审计日志。
 *
 * 角色与审计日志通过仓储注入，有数据库时落 platform_roles /
 * platform_role_permissions / platform_audit_logs，无数据库时使用内存实现。
 */

export interface PlatformHttpOptions {
  roles?: RoleRepository;
  audits?: AuditRepository;
  catalog?: DataCatalogRepository;
}

interface Tenant { id: string; name: string; code: string; status: "ACTIVE" | "DISABLED" }

const tenants: Tenant[] = [{ id: "tenant-demo", name: "达州示范农场", code: "DAZHOU-DEMO", status: "ACTIVE" }];

/** 权限目录：与 @agri/contracts 共用一份，角色页、网关与服务守卫不会漂移 */
const permissionCatalog = PERMISSION_CATALOG;
const permissionCodes = new Set(permissionCatalog.flatMap((group) => group.items.map((item) => item.code)));

/** 服务侧权限守卫：角色与审计接口按权限区分，租户与权限目录仅需登录 */
const PLATFORM_POLICY = {
  read: "system:role",
  write: "system:role",
  publicPaths: ["/api/v1/internal/platform/role-permissions"],
  sessionPaths: ["/api/v1/platform/tenant", "/api/v1/platform/permissions"],
  pathPermissions: [{ prefix: "/api/v1/platform/audit-logs", permission: "system:audit" }, { prefix: "/api/v1/platform/audit-retention", permission: "system:audit" }, { prefix: "/api/v1/platform/backups", permission: "system:backup" }, { prefix: "/api/v1/platform/data-assets", permission: "system:data" }, { prefix: "/api/v1/platform/data-dictionary", permission: "system:data" }],
};

/** 内部接口凭证：网关与管理脚本使用，不经公网暴露 */
function internalToken(): string { return process.env.INTERNAL_TOKEN ?? "agri-internal"; }
function fromGateway(request: IncomingMessage): boolean { return request.headers["x-internal-token"]?.toString() === internalToken(); }

function trace(request: IncomingMessage): string { return request.headers["x-request-id"]?.toString() || randomUUID(); }
function send<T>(response: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void { const body: ApiResponse<T> = { code: status >= 400 ? `PLATFORM-${status}` : "OK", message, data, traceId, timestamp: Date.now() }; response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(body)); }
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象"); return value as Record<string, unknown>; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function tenantOf(request: IncomingMessage): string { return request.headers["x-tenant-id"]?.toString() || "tenant-demo"; }
function operator(request: IncomingMessage): string { return request.headers["x-user-id"]?.toString() || "system"; }
function pageOf(query: URLSearchParams): { page: number; size: number } { return { page: Math.max(1, Number(query.get("page") || 1)), size: Math.min(200, Math.max(1, Number(query.get("size") || 20))) }; }
function parseStatus(value: unknown): "ACTIVE" | "DISABLED" | null { const status = text(value); if (status === "ACTIVE" || status === "DISABLED") return status; return null; }

/** 数据目录入参校验：超长/必填不合法直接抛错，由统一 catch 转 400，与角色接口同一口径 */
function bounded(value: unknown, field: string, max: number, required = false): string {
  const parsed = text(value);
  if (required && !parsed) throw new Error(`${field}不能为空`);
  if (parsed.length > max) throw new Error(`${field}不能超过${max}字`);
  return parsed;
}

/** 校验角色权限：只接受权限目录里的编码，内置管理员固定为通配符 */
function parsePermissions(value: unknown): { permissions: string[]; error?: string } {
  if (value === undefined) return { permissions: [] };
  if (!Array.isArray(value)) return { permissions: [], error: "权限必须是数组" };
  const permissions = [...new Set(value.map((item) => String(item).trim()).filter((item) => item.length > 0))];
  const unknown = permissions.find((code) => code !== "*" && !permissionCodes.has(code));
  if (unknown) return { permissions: [], error: `未知权限编码：${unknown}` };
  return { permissions };
}

export function createPlatformHttpServer(options: PlatformHttpOptions = {}): Server {
  const roles = options.roles ?? new InMemoryRoleRepository(seedRoles());
  const audits = options.audits ?? new InMemoryAuditRepository();
  const catalog = options.catalog ?? new InMemoryDataCatalogRepository(seedDataCatalog());
  const audit = async (request: IncomingMessage, action: string, resource: string, detail: string): Promise<void> => {
    const record: AuditRecord = { id: `audit-${randomUUID().slice(0, 8)}`, tenantId: tenantOf(request), action, operator: operator(request), resource, detail, createdAt: new Date().toISOString() };
    await audits.create(record);
  };
  return createServer(async (request, response) => { const traceId = trace(request); const url = new URL(request.url ?? "/", "http://localhost"); try {
    if (request.method === "GET" && url.pathname === "/health") { send(response, 200, { status: "ok", service: "platform" }, traceId); return; }
    const denied = authorizeRequest(request, PLATFORM_POLICY);
    if (denied) { send(response, denied.status, null, traceId, denied.message); return; }
    // 内部角色权限：网关把用户的角色编码交回来，换取实际权限
    if (request.method === "POST" && url.pathname === "/api/v1/internal/platform/role-permissions") {
      if (!fromGateway(request)) { send(response, 401, null, traceId, "内部接口凭证无效"); return; }
      const body = await readJson(request);
      const codes = Array.isArray(body.codes) ? body.codes.map((item) => String(item).trim()).filter((item) => item.length > 0) : [];
      const items: Array<{ code: string; permissions: string[] }> = [];
      for (const code of codes) {
        const role = await roles.findByCode(tenantOf(request), code);
        if (role && role.status === "ACTIVE") items.push({ code: role.code, permissions: role.permissions });
      }
      send(response, 200, { items }, traceId);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/platform/tenant") {
      const tenant = tenants.find((item) => item.id === tenantOf(request));
      if (!tenant) { send(response, 404, null, traceId, "租户不存在"); return; }
      send(response, 200, tenant, traceId);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/platform/permissions") { send(response, 200, permissionCatalog, traceId); return; }
    if (request.method === "GET" && url.pathname === "/api/v1/platform/roles") {
      const keyword = text(url.searchParams.get("keyword"));
      send(response, 200, await roles.page({ tenantId: tenantOf(request), ...(keyword ? { keyword } : {}), ...pageOf(url.searchParams) }), traceId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/platform/roles") {
      const body = await readJson(request);
      const name = text(body.name);
      const code = text(body.code);
      if (!name) { send(response, 400, null, traceId, "角色名称不能为空"); return; }
      if (!/^[a-z][a-z0-9_-]{2,31}$/.test(code)) { send(response, 400, null, traceId, "角色编码需以小写字母开头，3~32 位小写字母、数字、下划线或短横线"); return; }
      if (await roles.findByCode(tenantOf(request), code)) { send(response, 409, null, traceId, "角色编码已存在"); return; }
      const parsed = parsePermissions(body.permissions);
      if (parsed.error !== undefined) { send(response, 400, null, traceId, parsed.error); return; }
      if (parsed.permissions.length === 0) { send(response, 400, null, traceId, "至少选择一项权限"); return; }
      const now = new Date().toISOString();
      const record: RoleRecord = { id: `role-${randomUUID().slice(0, 8)}`, tenantId: tenantOf(request), name, code, description: text(body.description), permissions: parsed.permissions, status: parseStatus(body.status) ?? "ACTIVE", createdAt: now, updatedAt: now };
      const created = await roles.create(record);
      await audit(request, "role.create", `role:${record.id}`, `新建角色 ${name}（${code}），权限 ${parsed.permissions.join(",")}`);
      send(response, 201, created, traceId);
      return;
    }
    const roleRoute = url.pathname.match(/^\/api\/v1\/platform\/roles\/([^/]+)$/);
    if (roleRoute) {
      const id = decodeURIComponent(roleRoute[1] ?? "");
      const role = await roles.findById(id);
      if (!role || role.tenantId !== tenantOf(request)) { send(response, 404, null, traceId, "角色不存在"); return; }
      if (request.method === "PUT") {
        const body = await readJson(request);
        const name = text(body.name);
        if (body.name !== undefined && !name) { send(response, 400, null, traceId, "角色名称不能为空"); return; }
        if (body.status !== undefined && parseStatus(body.status) === null) { send(response, 400, null, traceId, "状态取值非法"); return; }
        const parsed = parsePermissions(body.permissions);
        if (parsed.error !== undefined) { send(response, 400, null, traceId, parsed.error); return; }
        if (body.permissions !== undefined && parsed.permissions.length === 0) { send(response, 400, null, traceId, "至少选择一项权限"); return; }
        if (role.code === "admin" && body.permissions !== undefined) { send(response, 400, null, traceId, "内置管理员角色不可修改权限"); return; }
        const next: RoleRecord = {
          ...role,
          name: name || role.name,
          description: body.description !== undefined ? text(body.description) : role.description,
          permissions: body.permissions !== undefined ? parsed.permissions : role.permissions,
          status: parseStatus(body.status) ?? role.status,
          updatedAt: new Date().toISOString(),
        };
        const updated = await roles.update(next);
        await audit(request, "role.update", `role:${role.id}`, `更新角色 ${next.name}，权限 ${next.permissions.join(",")}`);
        send(response, 200, updated, traceId);
        return;
      }
      if (request.method === "DELETE") {
        if (role.code === "admin") { send(response, 409, null, traceId, "内置管理员角色不可删除"); return; }
        await roles.remove(role.id);
        await audit(request, "role.delete", `role:${role.id}`, `删除角色 ${role.name}（${role.code}）`);
        send(response, 200, null, traceId);
        return;
      }
    }
    if (request.method === "GET" && url.pathname === "/api/v1/platform/audit-logs") {
      const keyword = text(url.searchParams.get("keyword"));
      send(response, 200, await audits.page({ tenantId: tenantOf(request), ...(keyword ? { keyword } : {}), ...pageOf(url.searchParams) }), traceId);
      return;
    }
    // 审计留存策略：前端审计页展示「留存 N 天、到期自动清理」，口径与后台清理任务同一个解析函数
    if (request.method === "GET" && url.pathname === "/api/v1/platform/audit-retention") {
      const retentionDays = resolveAuditRetentionDays();
      send(response, 200, { retentionDays, minRetentionDays: MIN_AUDIT_RETENTION_DAYS, purge: "expired-auto", env: "AUDIT_RETENTION_DAYS" }, traceId);
      return;
    }
    // 数据字典与资产目录（方案 11.4）：明确各数据的定义、单位、来源与更新频率，避免同指标多口径
    if (request.method === "GET" && url.pathname === "/api/v1/platform/data-assets") {
      const category = text(url.searchParams.get("category"));
      if (category && !DATA_ASSET_CATEGORIES.includes(category as DataAssetCategory)) { send(response, 400, null, traceId, `资产分类需为 ${DATA_ASSET_CATEGORIES.join("/")}`); return; }
      const keyword = text(url.searchParams.get("keyword"));
      send(response, 200, await catalog.pageAssets(tenantOf(request), { ...pageOf(url.searchParams), ...(keyword ? { keyword } : {}), ...(category ? { category: category as DataAssetCategory } : {}) }), traceId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/platform/data-assets") {
      const body = await readJson(request);
      const code = bounded(body.code, "资产编码", 64, true);
      if (!/^[a-z][a-z0-9_]{2,63}$/.test(code)) { send(response, 400, null, traceId, "资产编码需以小写字母开头，3~64 位小写字母、数字或下划线（建议取真实表名）"); return; }
      const name = bounded(body.name, "资产名称", 100, true);
      const category = text(body.category);
      if (!DATA_ASSET_CATEGORIES.includes(category as DataAssetCategory)) { send(response, 400, null, traceId, `资产分类需为 ${DATA_ASSET_CATEGORIES.join("/")}`); return; }
      if (await catalog.findAssetByCode(tenantOf(request), code)) { send(response, 409, null, traceId, "资产编码已存在"); return; }
      const now = new Date().toISOString();
      const record: DataAsset = { id: `asset-${randomUUID().slice(0, 8)}`, tenantId: tenantOf(request), code, name, category: category as DataAssetCategory, description: bounded(body.description, "资产描述", 500), sourceService: bounded(body.sourceService, "来源服务", 100), storage: bounded(body.storage, "存储介质", 100), updateFrequency: bounded(body.updateFrequency, "更新频率", 100), plotLinked: body.plotLinked === true, createdAt: now, updatedAt: now };
      const created = await catalog.createAsset(record);
      await audit(request, "dataAsset.create", `dataAsset:${record.id}`, `登记数据资产 ${name}（${code}）`);
      send(response, 201, created, traceId);
      return;
    }
    const assetRoute = url.pathname.match(/^\/api\/v1\/platform\/data-assets\/([^/]+)$/);
    if (assetRoute) {
      const id = decodeURIComponent(assetRoute[1] ?? "");
      const asset = await catalog.findAsset(tenantOf(request), id);
      if (!asset) { send(response, 404, null, traceId, "数据资产不存在"); return; }
      if (request.method === "PUT") {
        const body = await readJson(request);
        // 编码不可改：字典条目按 assetCode 引用，改编码会让存量条目悬空
        if (body.code !== undefined && text(body.code) !== asset.code) { send(response, 400, null, traceId, "资产编码不可修改（字典条目按编码引用）"); return; }
        if (body.category !== undefined && !DATA_ASSET_CATEGORIES.includes(text(body.category) as DataAssetCategory)) { send(response, 400, null, traceId, `资产分类需为 ${DATA_ASSET_CATEGORIES.join("/")}`); return; }
        if (body.plotLinked !== undefined && typeof body.plotLinked !== "boolean") { send(response, 400, null, traceId, "地块归集标记需为布尔值"); return; }
        const next: DataAsset = {
          ...asset,
          name: body.name !== undefined ? bounded(body.name, "资产名称", 100, true) : asset.name,
          category: body.category !== undefined ? text(body.category) as DataAssetCategory : asset.category,
          description: body.description !== undefined ? bounded(body.description, "资产描述", 500) : asset.description,
          sourceService: body.sourceService !== undefined ? bounded(body.sourceService, "来源服务", 100) : asset.sourceService,
          storage: body.storage !== undefined ? bounded(body.storage, "存储介质", 100) : asset.storage,
          updateFrequency: body.updateFrequency !== undefined ? bounded(body.updateFrequency, "更新频率", 100) : asset.updateFrequency,
          plotLinked: body.plotLinked !== undefined ? body.plotLinked === true : asset.plotLinked,
          updatedAt: new Date().toISOString(),
        };
        const updated = await catalog.updateAsset(next);
        await audit(request, "dataAsset.update", `dataAsset:${asset.id}`, `更新数据资产 ${next.name}（${asset.code}）`);
        send(response, 200, updated, traceId);
        return;
      }
      if (request.method === "DELETE") {
        // 引用守卫：资产下还挂着字典条目时不允许删，避免条目悬空失去口径归属
        const entries = await catalog.countDictionaryByAsset(tenantOf(request), asset.code);
        if (entries > 0) { send(response, 409, null, traceId, `该资产下仍有 ${entries} 条字典条目，请先清理条目`); return; }
        await catalog.removeAsset(tenantOf(request), asset.id);
        await audit(request, "dataAsset.delete", `dataAsset:${asset.id}`, `删除数据资产 ${asset.name}（${asset.code}）`);
        send(response, 200, null, traceId);
        return;
      }
    }
    if (request.method === "GET" && url.pathname === "/api/v1/platform/data-dictionary") {
      const assetCode = text(url.searchParams.get("assetCode"));
      const keyword = text(url.searchParams.get("keyword"));
      send(response, 200, await catalog.pageDictionary(tenantOf(request), { ...pageOf(url.searchParams), ...(assetCode ? { assetCode } : {}), ...(keyword ? { keyword } : {}) }), traceId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/platform/data-dictionary") {
      const body = await readJson(request);
      const assetCode = bounded(body.assetCode, "所属资产编码", 64, true);
      if (!(await catalog.findAssetByCode(tenantOf(request), assetCode))) { send(response, 404, null, traceId, "数据资产不存在"); return; }
      const metricKey = bounded(body.metricKey, "指标标识", 64, true);
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(metricKey)) { send(response, 400, null, traceId, "指标标识需以字母开头，仅含字母、数字或下划线，不超过 64 位"); return; }
      if (await catalog.findDictionaryByKey(tenantOf(request), assetCode, metricKey)) { send(response, 409, null, traceId, "该资产下指标已存在，同一指标只留一条口径"); return; }
      const now = new Date().toISOString();
      const record: DataDictionaryEntry = { id: `dict-${randomUUID().slice(0, 8)}`, tenantId: tenantOf(request), assetCode, metricKey, label: bounded(body.label, "指标名称", 100, true), definition: bounded(body.definition, "指标定义", 500), unit: bounded(body.unit, "单位", 30), dataType: bounded(body.dataType, "数据类型", 30), source: bounded(body.source, "数据来源", 100), updateFrequency: bounded(body.updateFrequency, "更新频率", 100), createdAt: now, updatedAt: now };
      const created = await catalog.createDictionary(record);
      await audit(request, "dataDictionary.create", `dataDictionary:${record.id}`, `登记字典条目 ${record.label}（${assetCode}.${metricKey}）`);
      send(response, 201, created, traceId);
      return;
    }
    const dictionaryRoute = url.pathname.match(/^\/api\/v1\/platform\/data-dictionary\/([^/]+)$/);
    if (dictionaryRoute) {
      const id = decodeURIComponent(dictionaryRoute[1] ?? "");
      const entry = await catalog.findDictionary(tenantOf(request), id);
      if (!entry) { send(response, 404, null, traceId, "字典条目不存在"); return; }
      if (request.method === "PUT") {
        const body = await readJson(request);
        // 所属资产与指标标识不可改：改了等于另一条口径，应新建而非改写
        if (body.assetCode !== undefined && text(body.assetCode) !== entry.assetCode) { send(response, 400, null, traceId, "所属资产不可修改"); return; }
        if (body.metricKey !== undefined && text(body.metricKey) !== entry.metricKey) { send(response, 400, null, traceId, "指标标识不可修改"); return; }
        const next: DataDictionaryEntry = {
          ...entry,
          label: body.label !== undefined ? bounded(body.label, "指标名称", 100, true) : entry.label,
          definition: body.definition !== undefined ? bounded(body.definition, "指标定义", 500) : entry.definition,
          unit: body.unit !== undefined ? bounded(body.unit, "单位", 30) : entry.unit,
          dataType: body.dataType !== undefined ? bounded(body.dataType, "数据类型", 30) : entry.dataType,
          source: body.source !== undefined ? bounded(body.source, "数据来源", 100) : entry.source,
          updateFrequency: body.updateFrequency !== undefined ? bounded(body.updateFrequency, "更新频率", 100) : entry.updateFrequency,
          updatedAt: new Date().toISOString(),
        };
        const updated = await catalog.updateDictionary(next);
        await audit(request, "dataDictionary.update", `dataDictionary:${entry.id}`, `更新字典条目 ${next.label}（${entry.assetCode}.${entry.metricKey}）`);
        send(response, 200, updated, traceId);
        return;
      }
      if (request.method === "DELETE") {
        await catalog.removeDictionary(tenantOf(request), entry.id);
        await audit(request, "dataDictionary.delete", `dataDictionary:${entry.id}`, `删除字典条目 ${entry.label}（${entry.assetCode}.${entry.metricKey}）`);
        send(response, 200, null, traceId);
        return;
      }
    }
    // 系统备份：清单读取、触发备份/恢复脚本、详情与删除
    if (request.method === "GET" && url.pathname === "/api/v1/platform/backups") {
      send(response, 200, listBackups(), traceId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/platform/backups/run") {
      const body = await readJson(request);
      const result = await runBackup({
        dbOnly: body.dbOnly === true,
        codeOnly: body.codeOnly === true,
        includeSecrets: body.includeSecrets === true,
        ...(typeof body.keep === "number" ? { keep: body.keep } : {}),
      });
      send(response, result.exitCode === 0 ? 200 : 500, result, traceId, result.exitCode === 0 ? "备份已执行" : "备份执行失败");
      return;
    }
    const backupRestore = url.pathname.match(/^\/api\/v1\/platform\/backups\/([^/]+)\/restore$/);
    if (backupRestore && request.method === "POST") {
      const id = decodeURIComponent(backupRestore[1] ?? "");
      const body = await readJson(request);
      const result = await runRestore({
        from: id,
        ...(body.only === "code" || body.only === "db" ? { only: body.only as "code" | "db" } : {}),
        ...(typeof body.target === "string" ? { target: body.target } : {}),
        ...(typeof body.db === "string" ? { db: body.db } : {}),
      });
      send(response, result.exitCode === 0 ? 200 : 500, result, traceId, result.exitCode === 0 ? "恢复已执行" : "恢复执行失败");
      return;
    }
    // 备份下载：整包 tar.gz 或单个分片，均以文件流返回
    const backupDownload = url.pathname.match(/^\/api\/v1\/platform\/backups\/([^/]+)\/download$/);
    if (backupDownload && request.method === "GET") {
      const id = decodeURIComponent(backupDownload[1] ?? "");
      const archive = await backupArchive(id);
      if (!archive.ok) { send(response, archive.reason === "备份不存在" ? 404 : 400, null, traceId, archive.reason ?? "备份不存在"); return; }
      const child = archive.child!;
      const out = child.stdout;
      const err = child.stderr;
      if (!out || !err) { send(response, 500, null, traceId, "整包打包失败"); return; }
      err.on("data", () => { /* tar 告警不写入响应体，避免污染下载流 */ });
      child.on("error", () => { if (!response.headersSent) send(response, 500, null, traceId, "整包打包失败"); else response.destroy(); });
      child.on("close", (code) => { if (code !== 0) response.destroy(); });
      response.writeHead(200, {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${archive.filename}"; filename*=UTF-8''${encodeURIComponent(archive.filename!)}`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      });
      out.pipe(response);
      return;
    }
    const backupDownloadPart = url.pathname.match(/^\/api\/v1\/platform\/backups\/([^/]+)\/download\/([^/]+)$/);
    if (backupDownloadPart && request.method === "GET") {
      const id = decodeURIComponent(backupDownloadPart[1] ?? "");
      const partName = decodeURIComponent(backupDownloadPart[2] ?? "");
      const partFile = readBackupPart(id, partName);
      if (!partFile) { send(response, 404, null, traceId, "备份分片不存在"); return; }
      const stat = fs.statSync(partFile.filePath);
      const encoded = encodeURIComponent(partFile.part.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(stat.size),
        "content-disposition": `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      });
      fs.createReadStream(partFile.filePath).pipe(response);
      return;
    }
    const backupDetail = url.pathname.match(/^\/api\/v1\/platform\/backups\/([^/]+)$/);
    if (backupDetail) {
      const id = decodeURIComponent(backupDetail[1] ?? "");
      if (request.method === "GET") {
        const manifest = readBackup(id);
        if (!manifest) { send(response, 404, null, traceId, "备份不存在"); return; }
        send(response, 200, manifest, traceId);
        return;
      }
      if (request.method === "DELETE") {
        if (!removeBackup(id)) { send(response, 404, null, traceId, "备份不存在"); return; }
        send(response, 200, null, traceId);
        return;
      }
    }
    send(response, 404, null, traceId, "接口不存在");
  } catch (error) { send(response, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败"); } });
}
