import type { PrismaClientLike } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

export interface FinanceEntry { id: string; plotCode: string; season: string; kind: "INPUT" | "OUTPUT"; category: string; amount: number; unit: string; note: string; createdAt: string }
export interface FinanceSummary { plotCode: string | null; input: number; output: number; profit: number; currency: "CNY" }
/** 按月（东八区）、按类别、按地块三个维度聚合的核算报表 */
export interface FinanceReportMonth { month: string; input: number; output: number; profit: number }
export interface FinanceReportCategory { kind: "INPUT" | "OUTPUT"; category: string; amount: number }
export interface FinanceReportPlot { plotCode: string; input: number; output: number; profit: number }
export interface FinanceReport { months: FinanceReportMonth[]; categories: FinanceReportCategory[]; plots: FinanceReportPlot[] }
export interface FinanceRepository { list(plotCode?: string): Promise<FinanceEntry[]>; create(entry: FinanceEntry): Promise<FinanceEntry>; summary(plotCode?: string): Promise<FinanceSummary>; report(plotCode?: string): Promise<FinanceReport> }

/** 业务月按东八区取 YYYY-MM，与展示层「月份」口径一致 */
function farmMonth(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).formatToParts(new Date(iso));
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  return `${year}-${month}`;
}

/** 由明细行现算报表：月份升序、类别按金额降序、地块按利润降序 */
export function aggregateReport(rows: FinanceEntry[]): FinanceReport {
  const months = new Map<string, FinanceReportMonth>();
  const categories = new Map<string, FinanceReportCategory>();
  const plots = new Map<string, FinanceReportPlot>();
  for (const row of rows) {
    const key = farmMonth(row.createdAt);
    const month = months.get(key) ?? { month: key, input: 0, output: 0, profit: 0 };
    const plot = plots.get(row.plotCode) ?? { plotCode: row.plotCode, input: 0, output: 0, profit: 0 };
    const catKey = `${row.kind}\u0000${row.category}`;
    const category = categories.get(catKey) ?? { kind: row.kind, category: row.category, amount: 0 };
    if (row.kind === "INPUT") { month.input += row.amount; plot.input += row.amount; }
    else { month.output += row.amount; plot.output += row.amount; }
    category.amount += row.amount;
    months.set(key, month);
    plots.set(row.plotCode, plot);
    categories.set(catKey, category);
  }
  for (const month of months.values()) month.profit = month.output - month.input;
  for (const plot of plots.values()) plot.profit = plot.output - plot.input;
  return {
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    categories: [...categories.values()].sort((a, b) => b.amount - a.amount),
    plots: [...plots.values()].sort((a, b) => b.profit - a.profit),
  };
}

export class InMemoryFinanceRepository implements FinanceRepository {
  private readonly entries: FinanceEntry[] = [];
  async list(plotCode?: string): Promise<FinanceEntry[]> { return [...this.entries].filter((entry) => !plotCode || entry.plotCode === plotCode); }
  async create(entry: FinanceEntry): Promise<FinanceEntry> { this.entries.unshift(entry); return entry; }
  async summary(plotCode?: string): Promise<FinanceSummary> { const rows = await this.list(plotCode); const input = rows.filter((row) => row.kind === "INPUT").reduce((sum, row) => sum + row.amount, 0); const output = rows.filter((row) => row.kind === "OUTPUT").reduce((sum, row) => sum + row.amount, 0); return { plotCode: plotCode ?? null, input, output, profit: output - input, currency: "CNY" }; }
  async report(plotCode?: string): Promise<FinanceReport> { return aggregateReport(await this.list(plotCode)); }
}

/** PostgreSQL 适配器。真实表结构由 finance-service 的迁移管理。 */
export class SqlFinanceRepository implements FinanceRepository {
  constructor(private readonly client: PrismaClientLike) {}
  private map(row: Record<string, unknown>): FinanceEntry { return { id: String(row.id), plotCode: String(row.plot_code), season: String(row.season), kind: row.kind === "OUTPUT" ? "OUTPUT" : "INPUT", category: String(row.category), amount: Number(row.amount), unit: String(row.unit), note: String(row.note ?? ""), createdAt: toIsoTimestamp(row.created_at) }; }
  async list(plotCode?: string): Promise<FinanceEntry[]> { const rows = plotCode ? await this.client.$queryRawUnsafe<Record<string, unknown>[]>("SELECT id, plot_code, season, kind, category, amount, unit, note, created_at FROM finance_entries WHERE plot_code = $1 ORDER BY created_at DESC", plotCode) : await this.client.$queryRawUnsafe<Record<string, unknown>[]>("SELECT id, plot_code, season, kind, category, amount, unit, note, created_at FROM finance_entries ORDER BY created_at DESC"); return rows.map((row) => this.map(row)); }
  async create(entry: FinanceEntry): Promise<FinanceEntry> { await this.client.$executeRawUnsafe("INSERT INTO finance_entries (id, plot_code, season, kind, category, amount, unit, note, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", entry.id, entry.plotCode, entry.season, entry.kind, entry.category, entry.amount, entry.unit, entry.note, entry.createdAt); return entry; }
  async summary(plotCode?: string): Promise<FinanceSummary> { const rows = plotCode ? await this.client.$queryRawUnsafe<Array<{ kind: string; total: number }>>("SELECT kind, COALESCE(SUM(amount), 0) AS total FROM finance_entries WHERE plot_code = $1 GROUP BY kind", plotCode) : await this.client.$queryRawUnsafe<Array<{ kind: string; total: number }>>("SELECT kind, COALESCE(SUM(amount), 0) AS total FROM finance_entries GROUP BY kind"); const input = Number(rows.find((row) => row.kind === "INPUT")?.total ?? 0); const output = Number(rows.find((row) => row.kind === "OUTPUT")?.total ?? 0); return { plotCode: plotCode ?? null, input, output, profit: output - input, currency: "CNY" }; }
  /** 真实库报表：月份/类别/地块三组 GROUP BY，金额由数据库聚合，不在服务内重算 */
  async report(plotCode?: string): Promise<FinanceReport> {
    const where = plotCode ? "WHERE plot_code = $1" : "";
    const args = plotCode ? [plotCode] : [];
    const monthRows = await this.client.$queryRawUnsafe<Array<{ month: string; kind: string; total: string | number }>>(
      `SELECT to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM') AS month, kind, COALESCE(SUM(amount), 0) AS total FROM finance_entries ${where} GROUP BY month, kind`, ...args);
    const catRows = await this.client.$queryRawUnsafe<Array<{ kind: string; category: string; total: string | number }>>(
      `SELECT kind, category, COALESCE(SUM(amount), 0) AS total FROM finance_entries ${where} GROUP BY kind, category`, ...args);
    const plotRows = await this.client.$queryRawUnsafe<Array<{ plot_code: string; kind: string; total: string | number }>>(
      `SELECT plot_code, kind, COALESCE(SUM(amount), 0) AS total FROM finance_entries ${where} GROUP BY plot_code, kind`, ...args);
    const months = new Map<string, FinanceReportMonth>();
    for (const row of monthRows) {
      const month = months.get(row.month) ?? { month: row.month, input: 0, output: 0, profit: 0 };
      if (row.kind === "INPUT") month.input = Number(row.total); else month.output = Number(row.total);
      months.set(row.month, month);
    }
    for (const month of months.values()) month.profit = month.output - month.input;
    const plots = new Map<string, FinanceReportPlot>();
    for (const row of plotRows) {
      const plot = plots.get(row.plot_code) ?? { plotCode: row.plot_code, input: 0, output: 0, profit: 0 };
      if (row.kind === "INPUT") plot.input = Number(row.total); else plot.output = Number(row.total);
      plots.set(row.plot_code, plot);
    }
    for (const plot of plots.values()) plot.profit = plot.output - plot.input;
    return {
      months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
      categories: catRows.map((row) => ({ kind: row.kind === "OUTPUT" ? "OUTPUT" as const : "INPUT" as const, category: row.category, amount: Number(row.total) })).sort((a, b) => b.amount - a.amount),
      plots: [...plots.values()].sort((a, b) => b.profit - a.profit),
    };
  }
}
