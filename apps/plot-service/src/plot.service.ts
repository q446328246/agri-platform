import { Injectable } from "@nestjs/common";

import type { GeoPolygon } from "@agri/contracts";
import { EventTopic } from "@agri/contracts";
import type { PlotCreatedPayload } from "@agri/contracts";
import type { PrismaService } from "@agri/db";
import type { OutboxService } from "@agri/mq";
import { ConflictError, NotFoundError, ValidationError, snowflakeId } from "@agri/shared";

import { PlotCodeService } from "./plot-code.service.js";
import type { PlotPatch, PlotRecord, PlotRepository } from "./plot.repository.js";

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
}
