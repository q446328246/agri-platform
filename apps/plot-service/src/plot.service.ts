import { Injectable } from "@nestjs/common";

import type { GeoPolygon } from "@agri/contracts";
import { EventTopic } from "@agri/contracts";
import type { PlotCreatedPayload } from "@agri/contracts";
import type { PrismaService } from "@agri/db";
import type { OutboxService } from "@agri/mq";
import { ConflictError, NotFoundError, ValidationError, polygonAreaMu, roundAreaMu, snowflakeId, ulid } from "@agri/shared";

import { PlotCodeService } from "./plot-code.service.js";
import type { PlotPatch, PlotRecord, PlotRepository } from "./plot.repository.js";
import { hullPolygon, ringPoints } from "./zone.geometry.js";

/**
 * 地块服务。
 *
 * 建档的关键点是「业务数据与事件同事务」：地块记录与待投递事件写入同一事务，
 * 事务提交后由中继任务把事件投递出去。这样即使投递环节短暂失败，事件也不会丢，
 * 代价是可能出现重复投递，因此消费侧必须做幂等。
 */

/** 地块类型白名单，与迁移 011 的 CHECK 约束、前端 PlotType 枚举同源 */
export const PLOT_TYPES = ["FIELD", "GREENHOUSE", "ORCHARD", "AQUACULTURE"];
/** 地块状态白名单，与迁移 011 的 CHECK 约束、前端 PlotStatus 枚举同源 */
export const PLOT_STATUSES = ["DRAFT", "ACTIVE", "FALLOW", "ARCHIVED"];

/** 建档入参 */
export interface RegisterPlotInput {
  tenantId: string;
  farmId: string;
  region: string;
  farm: string;
  area: string;
  parcel: string;
  parcelName: string;
  /** 面积，单位：亩 */
  areaMu: number;
  soilType?: string;
  /** 建档时直接划入的片区，可选 */
  zoneCode?: string;
  /** 地块类型，缺省为大田 */
  plotType?: string;
  /** 地块状态，缺省为种植中 */
  plotStatus?: string;
  currentCrop?: string;
  ownerName?: string;
  ownerPhone?: string;
  remark?: string;
  /** 边界几何，调用方须保证为 CGCS2000 坐标 */
  geom: GeoPolygon;
  /** 链路标识，贯穿本次请求 */
  traceId: string;
}

/** 合并入参：源地块编码（≥2）与可选的合并后档案字段，未传字段继承首个源地块 */
export interface MergePlotsInput {
  tenantId: string;
  parcelCodes: string[];
  parcelName?: string;
  soilType?: string;
  zoneCode?: string;
  plotType?: string;
  plotStatus?: string;
  currentCrop?: string;
  ownerName?: string;
  ownerPhone?: string;
  remark?: string;
  traceId: string;
}

export interface MergePlotsResult {
  plot: PlotRecord;
  /** 已归档（软删）的源地块编码 */
  sourceCodes: string[];
}

/** 拆分提交的单个子地块：边界必填，档案字段可选覆盖 */
export interface SplitPlotPiece {
  parcelName: string;
  geom: GeoPolygon;
  plotType?: string;
  plotStatus?: string;
}

export interface SplitPlotInput {
  tenantId: string;
  parcelCode: string;
  pieces: SplitPlotPiece[];
  /** 为 true 时保留原地块，仅用于先验证切法的操作节奏，默认删除归档 */
  keepSource?: boolean;
  traceId: string;
}

export interface SplitPlotResult {
  plots: PlotRecord[];
  sourceCode: string;
  sourceRemoved: boolean;
  pieceAreaSum: number;
}

@Injectable()
export class PlotService {
  constructor(
    private readonly repository: PlotRepository,
    private readonly outbox: OutboxService,
    private readonly codeService: PlotCodeService,
    private readonly prisma: PrismaService,
  ) {}

  /** 枚举字段在入层就拦截：非法值报 400，而不是撞库里的 CHECK 约束变成 500 */
  private assertEnum(value: string | null | undefined, allowed: string[], field: string): void {
    if (value !== undefined && value !== null && !allowed.includes(value)) {
      throw new ValidationError(`${field}需为 ${allowed.join("/")}`);
    }
  }

  /**
   * 地块建档。
   * @param input 建档入参
   * @returns 建档后的地块记录
   */
  async registerPlot(input: RegisterPlotInput): Promise<PlotRecord> {
    this.assertEnum(input.plotType, PLOT_TYPES, "地块类型");
    this.assertEnum(input.plotStatus, PLOT_STATUSES, "地块状态");
    const parcelCode = this.codeService.generate({
      region: input.region,
      farm: input.farm,
      area: input.area,
      parcel: input.parcel,
    });

    const existing = await this.repository.findByCode(undefined, parcelCode);
    if (existing) {
      throw new ConflictError("地块编码已存在，禁止重复建档", "PLOT-409-001");
    }

    const now = new Date().toISOString();
    const record: PlotRecord = {
      parcelId: snowflakeId(),
      parcelCode,
      parcelName: input.parcelName,
      tenantId: input.tenantId,
      farmId: input.farmId,
      areaMu: input.areaMu,
      geom: input.geom,
      createdAt: now,
      updatedAt: now,
    };
    if (input.soilType !== undefined) {
      record.soilType = input.soilType;
    }
    if (input.zoneCode !== undefined && input.zoneCode !== "") {
      record.zoneCode = input.zoneCode;
    }
    // 类型与状态给默认值，避免新增地块又落入空类型；前端建档表单本来就会传值
    record.plotType = input.plotType ?? "FIELD";
    record.plotStatus = input.plotStatus ?? "ACTIVE";
    for (const key of ["currentCrop", "ownerName", "ownerPhone", "remark"] as const) {
      const value = input[key];
      if (typeof value === "string" && value.trim() !== "") record[key] = value.trim();
    }

    const payload: PlotCreatedPayload = {
      parcelId: record.parcelId,
      parcelCode: record.parcelCode,
      parcelName: record.parcelName,
      tenantId: record.tenantId,
      farmId: record.farmId,
      areaMu: record.areaMu,
      geom: record.geom,
    };
    if (record.soilType !== undefined) {
      payload.soilType = record.soilType;
    }

    await this.prisma.withTransaction(async (tx) => {
      await this.repository.create(tx, record);
      await this.outbox.enqueue(tx, EventTopic.PlotCreated, payload, {
        tenantId: input.tenantId,
        traceId: input.traceId,
        producer: "plot",
      });
    });

    return record;
  }

  /**
   * 按编码查询地块。
   * @param parcelCode 地块编码
   */
  async getByCode(parcelCode: string): Promise<PlotRecord> {
    const hit = await this.repository.findByCode(undefined, parcelCode);
    if (!hit) {
      throw new NotFoundError(`地块不存在：${parcelCode}`, "PLOT-404-001");
    }
    return hit;
  }

  /** 地块是否存在（未软删）。供管线归属校验用，parcel_code 全局唯一，无需带租户。 */
  async exists(parcelCode: string): Promise<boolean> {
    return (await this.repository.findByCode(undefined, parcelCode)) !== null;
  }

  /** 按租户列出未删除地块，HTTP 层负责分页与排序。 */
  async listByTenant(tenantId: string): Promise<PlotRecord[]> {
    return this.repository.listByTenant(tenantId);
  }

  async updatePlot(parcelCode: string, input: Omit<PlotPatch, "updatedAt">): Promise<PlotRecord> {
    this.assertEnum(input.plotType, PLOT_TYPES, "地块类型");
    this.assertEnum(input.plotStatus, PLOT_STATUSES, "地块状态");
    const existing = await this.repository.findByCode(undefined, parcelCode);
    if (!existing) throw new NotFoundError(`地块不存在：${parcelCode}`, "PLOT-404-001");
    const updatedAt = new Date().toISOString();
    const updated = await this.prisma.withTransaction((tx) => this.repository.update(tx, parcelCode, { ...input, updatedAt }));
    if (!updated) throw new NotFoundError(`地块不存在：${parcelCode}`, "PLOT-404-001");
    return updated;
  }

  async removePlot(parcelCode: string): Promise<void> {
    const deletedAt = new Date().toISOString();
    const removed = await this.prisma.withTransaction((tx) => this.repository.remove(tx, parcelCode, deletedAt));
    if (!removed) throw new NotFoundError(`地块不存在：${parcelCode}`, "PLOT-404-001");
  }

  /**
   * 在 `样本地块` 的同区/同场/同片区下生成未占用的新编码。
   * 合并与拆分都要落很多块，parcel 段不能用时间戳尾数（同一毫秒会撞车），
   * 取 ulid 尾部并回查，撞了就再生成一个。
   */
  private async ensureUniqueParcelCode(sampleCode: string): Promise<string> {
    const segments = this.codeService.parse(sampleCode);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const parcelCode = this.codeService.generate({
        region: segments.region,
        farm: segments.farm,
        area: segments.area,
        parcel: ulid().slice(-5),
      });
      if (!(await this.repository.findByCode(undefined, parcelCode))) return parcelCode;
    }
    throw new ConflictError("地块编码生成失败，请重试", "PLOT-409-002");
  }

  /** 建档入参里可从源地块继承的可空字段，统一在这里「非空才带」，避免空串污染档案 */
  private assignInherited(target: PlotRecord, source: PlotRecord): void {
    for (const key of ["soilType", "zoneCode", "plotType", "plotStatus", "currentCrop", "ownerName", "ownerPhone", "remark"] as const) {
      const value = source[key];
      if (typeof value === "string" && value !== "") target[key] = value;
    }
  }

  /** 类型与状态为空串时回落默认值；枚举非法在入层就 400 */
  private normalizeTypeStatus(input: { plotType?: string | undefined; plotStatus?: string | undefined }): { plotType: string; plotStatus: string } {
    const plotType = input.plotType && input.plotType !== "" ? input.plotType : "FIELD";
    const plotStatus = input.plotStatus && input.plotStatus !== "" ? input.plotStatus : "ACTIVE";
    this.assertEnum(plotType, PLOT_TYPES, "地块类型");
    this.assertEnum(plotStatus, PLOT_STATUSES, "地块状态");
    return { plotType, plotStatus };
  }

  /**
   * 地块合并：多块并一块。
   *
   * 口径（与片区凸包同源，但有一处关键差异）：
   * - 合并后边界 = 各源地块外环顶点的凸包。相邻共边地块的凸包即真并集；
   *   选中互不相邻的地块会框进中间空地，因此接口不回显面积、留痕列出源编码，
   *   操作人须在合并后到编辑页复核边界。
   * - 面积一律按合并后几何现算（polygonAreaMu → roundAreaMu），不是源面积求和：
   *   台账面积与边界必须逐位一致（迁移 015 起的唯一口径），求和会在凸包
   *   覆盖空地时造出新的漂移。
   * - 源地块整批软删归档，与建档/删除链路一致；挂在其上的管线与种植季
   *   保持指向旧编码（普通删除接口今天也不迁移引用），变更历史可回查去向。
   */
  async mergePlots(input: MergePlotsInput): Promise<MergePlotsResult> {
    const codes = [...new Set((input.parcelCodes ?? []).map((code) => String(code ?? "").trim()).filter((code) => code !== ""))];
    if (codes.length < 2) throw new ValidationError("至少选择两个地块才能合并");
    const sources: PlotRecord[] = [];
    for (const code of codes) {
      const source = await this.repository.findByCode(undefined, code);
      if (!source) throw new NotFoundError(`地块不存在：${code}`, "PLOT-404-001");
      sources.push(source);
    }
    const geom = hullPolygon(sources.flatMap((source) => ringPoints(source.geom)));
    if (!geom) throw new ValidationError("源地块边界顶点不足，无法生成合并边界");
    const ring = geom.coordinates[0] ?? [];
    const areaMu = roundAreaMu(polygonAreaMu(ring));
    if (areaMu <= 0) throw new ValidationError("合并边界面积为 0，请检查源地块边界");

    const first = sources[0]!;
    const parcelCode = await this.ensureUniqueParcelCode(first.parcelCode);
    const now = new Date().toISOString();
    const merged: PlotRecord = {
      parcelId: snowflakeId(),
      parcelCode,
      parcelName: input.parcelName?.trim() !== "" ? input.parcelName!.trim() : first.parcelName,
      tenantId: input.tenantId,
      farmId: first.farmId,
      areaMu,
      geom,
      createdAt: now,
      updatedAt: now,
    };
    // 档案字段以首个地块为底，入参显式传入的覆盖之；类型/状态留空走默认
    this.assignInherited(merged, first);
    const overrides: Partial<Record<"soilType" | "zoneCode" | "currentCrop" | "ownerName" | "ownerPhone" | "remark", string | undefined>> = {
      soilType: input.soilType, zoneCode: input.zoneCode, currentCrop: input.currentCrop,
      ownerName: input.ownerName, ownerPhone: input.ownerPhone, remark: input.remark,
    };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) continue;
      if (value.trim() === "") delete merged[key as keyof PlotRecord];
      else (merged as unknown as Record<string, unknown>)[key] = value.trim();
    }
    const typeStatus = this.normalizeTypeStatus({ plotType: input.plotType ?? first.plotType, plotStatus: input.plotStatus ?? first.plotStatus });
    merged.plotType = typeStatus.plotType;
    merged.plotStatus = typeStatus.plotStatus;

    const payload: PlotCreatedPayload = {
      parcelId: merged.parcelId, parcelCode: merged.parcelCode, parcelName: merged.parcelName,
      tenantId: merged.tenantId, farmId: merged.farmId, areaMu: merged.areaMu, geom: merged.geom,
    };
    if (merged.soilType !== undefined) payload.soilType = merged.soilType;

    const deletedAt = new Date().toISOString();
    await this.prisma.withTransaction(async (tx) => {
      await this.repository.create(tx, merged);
      await this.outbox.enqueue(tx, EventTopic.PlotCreated, payload, {
        tenantId: input.tenantId, traceId: input.traceId, producer: "plot",
      });
      for (const code of codes) await this.repository.remove(tx, code, deletedAt);
    });
    return { plot: merged, sourceCodes: codes };
  }

  /**
   * 地块拆分：一块拆多块。
   *
   * 不在服务端做线切/布尔运算：子地块边界由操作人在地图上逐块绘制后提交，
   * 每块面积同样只认自己的几何。校验：子块 ≥2、顶点 ≥3、面积为正、
   * 单块不得超过原地块面积（分出去的不能比原块还大）。
   * 默认删除（软删归档）原地块；`keepSource` 仅用于先验证切法再归档的操作节奏。
   */
  async splitPlot(input: SplitPlotInput): Promise<SplitPlotResult> {
    const source = await this.repository.findByCode(undefined, input.parcelCode);
    if (!source) throw new NotFoundError(`地块不存在：${input.parcelCode}`, "PLOT-404-001");
    const pieces = input.pieces ?? [];
    if (pieces.length < 2) throw new ValidationError("至少绘制两个子地块才能拆分");

    const prepared: Array<{ piece: SplitPlotPiece; geom: GeoPolygon; areaMu: number }> = [];
    let total = 0;
    for (const [index, piece] of pieces.entries()) {
      const parsed = piece.geom;
      const ring = parsed?.coordinates?.[0];
      if (!parsed || parsed.type !== "Polygon" || !Array.isArray(ring) || ring.length < 3) {
        throw new ValidationError(`第 ${index + 1} 块子地块边界至少需要 3 个顶点`);
      }
      const geom: GeoPolygon = { type: "Polygon", coordinates: parsed.coordinates, srid: Number(parsed.srid ?? 4490) };
      const areaMu = roundAreaMu(polygonAreaMu(ring));
      if (areaMu <= 0) throw new ValidationError(`第 ${index + 1} 块子地块面积为 0，请检查边界是否共线`);
      // 台账与几何两位小数口径下允许 0.01 亩的进位差，再大就是切法有问题
      if (areaMu > source.areaMu + 0.01) {
        throw new ValidationError(`第 ${index + 1} 块子地块面积 ${areaMu} 亩超过原地块 ${source.areaMu} 亩`);
      }
      total += areaMu;
      prepared.push({ piece, geom, areaMu });
    }

    const now = new Date().toISOString();
    const plots: PlotRecord[] = [];
    for (const { piece, geom, areaMu } of prepared) {
      const parcelCode = await this.ensureUniqueParcelCode(source.parcelCode);
      const record: PlotRecord = {
        parcelId: snowflakeId(),
        parcelCode,
        parcelName: piece.parcelName.trim() !== "" ? piece.parcelName.trim() : `${source.parcelName}-${plots.length + 1}`,
        tenantId: input.tenantId,
        farmId: source.farmId,
        areaMu,
        geom,
        createdAt: now,
        updatedAt: now,
      };
      this.assignInherited(record, source);
      if (piece.plotType !== undefined || piece.plotStatus !== undefined) {
        const typeStatus = this.normalizeTypeStatus({ plotType: piece.plotType ?? source.plotType, plotStatus: piece.plotStatus ?? source.plotStatus });
        record.plotType = typeStatus.plotType;
        record.plotStatus = typeStatus.plotStatus;
      }
      plots.push(record);
    }

    const deletedAt = new Date().toISOString();
    const keepSource = input.keepSource === true;
    await this.prisma.withTransaction(async (tx) => {
      for (const record of plots) {
        await this.repository.create(tx, record);
        const payload: PlotCreatedPayload = {
          parcelId: record.parcelId, parcelCode: record.parcelCode, parcelName: record.parcelName,
          tenantId: record.tenantId, farmId: record.farmId, areaMu: record.areaMu, geom: record.geom,
        };
        if (record.soilType !== undefined) payload.soilType = record.soilType;
        await this.outbox.enqueue(tx, EventTopic.PlotCreated, payload, {
          tenantId: input.tenantId, traceId: input.traceId, producer: "plot",
        });
      }
      if (!keepSource) await this.repository.remove(tx, source.parcelCode, deletedAt);
    });
    return { plots, sourceCode: source.parcelCode, sourceRemoved: !keepSource, pieceAreaSum: roundAreaMu(total) };
  }
}
