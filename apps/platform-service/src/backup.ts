import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * 系统备份管理：扫描备份目录的 manifest、触发备份/恢复脚本。
 *
 * 备份脚本 scripts/backup-system.mjs 与 scripts/restore-system.mjs 是纯运维脚本，
 * 不参与 tsc -b；本模块只负责在服务侧调用它们并把结果回传给前端。
 * 备份目录与脚本路径可用 BACKUP_DIR / BACKUP_SCRIPT / RESTORE_SCRIPT 覆盖。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * 仓库根：源码位于 <repo>/apps/platform-service/src，运行产物位于
 * <repo>/apps/platform-service/dist（容器内即 /app/apps/platform-service/dist），
 * 两者都要上溯三级才落在仓库根，脚本与默认备份目录都相对仓库根。
 */
const repoRoot = path.resolve(here, "../../..");

export function backupDir(): string {
  return process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(repoRoot, "backups");
}

export function backupScript(): string {
  return process.env.BACKUP_SCRIPT ? path.resolve(process.env.BACKUP_SCRIPT) : path.join(repoRoot, "scripts/backup-system.mjs");
}

export function restoreScript(): string {
  return process.env.RESTORE_SCRIPT ? path.resolve(process.env.RESTORE_SCRIPT) : path.join(repoRoot, "scripts/restore-system.mjs");
}

/** 备份清单里的单个分片 */
export interface BackupPart {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
  secrets?: boolean;
}

/** 备份清单（与 scripts/backup-system.mjs 写出的 manifest.json 对应） */
export interface BackupManifest {
  id: string;
  createdAt: string;
  root: string;
  host: string;
  tag: string;
  commit: string | null;
  branch: string | null;
  dirty: boolean | null;
  includeSecrets: boolean;
  parts: BackupPart[];
  database: { name: string; mode: string } | null;
}

/** 脚本执行结果 */
export interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string;
}

/** 只接受安全目录名，避免路径穿越；首字符不能是点，排除 "." 与 ".." */
function safeId(id: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ? id : null;
}

function readManifest(dir: string): BackupManifest | null {
  const file = path.join(dir, "manifest.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as BackupManifest;
  } catch {
    return null;
  }
}

export function listBackups(): BackupManifest[] {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  const names = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const manifests: BackupManifest[] = [];
  for (const name of names) {
    const manifest = readManifest(path.join(dir, name));
    if (manifest) manifests.push(manifest);
  }
  return manifests;
}

export function readBackup(id: string): BackupManifest | null {
  const safe = safeId(id);
  if (!safe) return null;
  return readManifest(path.join(backupDir(), safe));
}

export function removeBackup(id: string): boolean {
  const safe = safeId(id);
  if (!safe) return false;
  const dir = path.join(backupDir(), safe);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** 备份分片的实际文件（manifest 记录 + 磁盘路径） */
export interface BackupPartFile {
  manifest: BackupManifest;
  part: BackupPart;
  filePath: string;
}

/**
 * 读取备份分片的实际文件。
 *
 * 分片名必须来自该备份 manifest 的 parts，且解析后的路径必须严格落在备份目录内，
 * 拒绝路径穿越、跨备份引用与不存在的文件，避免下载接口被用来读取任意文件。
 */
export function readBackupPart(id: string, partName: string): BackupPartFile | null {
  const idSafe = safeId(id);
  const partSafe = safeId(partName);
  if (!idSafe || !partSafe) return null;
  const manifest = readManifest(path.join(backupDir(), idSafe));
  if (!manifest) return null;
  const part = manifest.parts.find((item) => item.name === partSafe || item.path === partSafe);
  if (!part) return null;
  const dir = path.resolve(backupDir(), idSafe);
  const filePath = path.resolve(dir, partSafe);
  if (filePath !== dir && !filePath.startsWith(dir + path.sep)) return null;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  return { manifest, part, filePath };
}

function runScript(script: string, args: string[], env: Record<string, string> = {}): Promise<ScriptResult> {
  const command = process.execPath + " " + script + (args.length > 0 ? " " + args.join(" ") : "");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ exitCode: -1, stdout, stderr, command: command + "（启动失败：" + error.message + "）" }));
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr, command }));
  });
}

export interface RunBackupOptions {
  dbOnly?: boolean;
  codeOnly?: boolean;
  includeSecrets?: boolean;
  keep?: number;
}

export function runBackup(options: RunBackupOptions = {}): Promise<ScriptResult> {
  const args = ["--"];
  if (options.dbOnly) args.push("--db-only");
  if (options.codeOnly) args.push("--code-only");
  if (options.includeSecrets) args.push("--include-secrets");
  if (options.keep !== undefined) args.push("--keep", String(options.keep));
  return runScript(backupScript(), args);
}

export interface RunRestoreOptions {
  from: string;
  only?: "code" | "db";
  target?: string;
  db?: string;
}

export function runRestore(options: RunRestoreOptions): Promise<ScriptResult> {
  const args = ["--from", options.from];
  if (options.only === "code" || options.only === "db") args.push("--only", options.only);
  if (options.target) args.push("--target", options.target);
  if (options.db) args.push("--db", options.db);
  return runScript(restoreScript(), args);
}

/** 整包打包结果：成功时 child 的 stdout 即 tar.gz 流 */
export interface BackupArchiveResult {
  ok: boolean;
  child?: ChildProcess;
  /** 下载时建议的文件名 */
  filename?: string;
  reason?: string;
}

/** 探测命令是否可用：spawn 无法区分“命令不存在”与“执行失败”，需先做一次预检 */
function commandAvailable(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(command, ["--version"], { cwd: repoRoot, windowsHide: true, stdio: "ignore" });
    probe.on("error", () => resolve(false));
    probe.on("close", (code) => resolve(code === 0));
  });
}

/**
 * 把整个备份目录用 tar 打成 tar.gz 流，供 HTTP 层流式下载。
 *
 * 归档内顶层为 <备份编号>/，包含 manifest.json 与全部分片，与备份目录结构一致。
 * 使用系统 tar（仓库脚本已假定其可用），不可用时返回明确原因。
 */
export async function backupArchive(id: string): Promise<BackupArchiveResult> {
  const safe = safeId(id);
  if (!safe) return { ok: false, reason: "非法备份编号" };
  const dir = path.join(backupDir(), safe);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: false, reason: "备份不存在" };
  if (!(await commandAvailable("tar"))) return { ok: false, reason: "服务器未安装 tar，无法打包整包下载" };
  const child = spawn("tar", ["-czf", "-", "-C", backupDir(), safe], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { ok: true, child, filename: "backup-" + safe + ".tar.gz" };
}
