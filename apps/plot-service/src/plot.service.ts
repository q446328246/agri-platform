import { Injectable } from "@nestjs/common";

import type { GeoPolygon } from "@agri/contracts";
import { EventTopic } from "@agri/contracts";
import type { PlotCreatedPayload } from "@agri/contracts";
import type { PrismaService } from "@agri/db";
import type { OutboxService } from "@agri/mq";
import { ConflictError, NotFoundError, snowflakeId } from "@agri/shared";

import { PlotCodeService } from "./plot-code.service.js";
import type { PlotPatch, PlotRecord, PlotRepository } from "./plot.repository.js";

/**
 * 地块服务。
 *
 * 建档的关键点是「业务数据与事件同事务」：地块记录与待投递事件写入同一事务，
 * 事务提交后由中继任务把事件投递出去。这样即使投递环节短暂失败，事件也不会丢，
 * 代价是可能出现重复投递，因此消费侧必须做幂等。
 */

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

  /**
   * 地块建档。
   * @param input 建档入参
   * @returns 建档后的地块记录
   */
  async registerPlot(input: RegisterPlotInput): Promise<PlotRecord> {
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
