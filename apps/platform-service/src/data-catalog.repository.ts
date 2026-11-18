import type { PageResult } from "@agri/contracts";
import type { PrismaClientLike } from "@agri/db";
import { keywordHits, likePattern, toIsoTimestamp } from "@agri/shared";

/**
 * 数据字典与数据资产目录仓储（开发方案 11.4 数据治理）。
 *
 * 资产目录按方案 11.1 五类数据分类，code 取真实表名；字典条目挂在资产下
 * 逐指标登记定义、单位、来源与更新频率，(租户, 资产, 指标) 唯一，杜绝同指标多口径。
 * SQL 侧落 platform_data_assets / platform_data_dictionary（迁移 058），
 * 内存侧同口径双实现；种子与迁移 058 的 INSERT 逐条对齐，只登记真实存在的表与指标。
 */

/** 数据资产五类（方案 11.1）：基础空间 / 设备台账 / 实时感知 / 业务过程 / 统计分析 */
export const DATA_ASSET_CATEGORIES = ["SPATIAL", "DEVICE", "TELEMETRY", "BUSINESS", "STATS"] as const;
export type DataAssetCategory = typeof DATA_ASSET_CATEGORIES[number];

export interface DataAsset {
  id: string;
  tenantId: string;
  /** 资产编码，取真实表名，租户内唯一 */
  code: string;
  name: string;
  category: DataAssetCategory;
  description: string;
  sourceService: string;
  storage: string;
  updateFrequency: string;
  /** 是否携带地块编码归集到地块（方案 11.1「所有数据写入时均携带地块编码」的登记口径） */
  plotLinked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DataDictionaryEntry {
  id: string;
  tenantId: string;
  /** 所属资产编码，须指向在册资产 */
  assetCode: string;
  /** 指标/字段 key，同一资产内唯一 */
  metricKey: string;
  label: string;
  definition: string;
  unit: string;
  dataType: string;
  source: string;
  updateFrequency: string;
  createdAt: string;
  updatedAt: string;
}

export interface DataAssetQuery {
  page: number;
  size: number;
  keyword?: string;
  category?: DataAssetCategory;
}

export interface DataDictionaryQuery {
  page: number;
  size: number;
  keyword?: string;
  assetCode?: string;
}

export interface DataCatalogRepository {
  pageAssets(tenantId: string, query: DataAssetQuery): Promise<PageResult<DataAsset>>;
  findAsset(tenantId: string, id: string): Promise<DataAsset | null>;
  findAssetByCode(tenantId: string, code: string): Promise<DataAsset | null>;
  createAsset(record: DataAsset): Promise<DataAsset>;
  updateAsset(record: DataAsset): Promise<DataAsset>;
  removeAsset(tenantId: string, id: string): Promise<boolean>;
  /** 资产下挂的字典条目数：删除资产前的引用守卫 */
  countDictionaryByAsset(tenantId: string, assetCode: string): Promise<number>;
  pageDictionary(tenantId: string, query: DataDictionaryQuery): Promise<PageResult<DataDictionaryEntry>>;
  findDictionary(tenantId: string, id: string): Promise<DataDictionaryEntry | null>;
  findDictionaryByKey(tenantId: string, assetCode: string, metricKey: string): Promise<DataDictionaryEntry | null>;
  createDictionary(record: DataDictionaryEntry): Promise<DataDictionaryEntry>;
  updateDictionary(record: DataDictionaryEntry): Promise<DataDictionaryEntry>;
  removeDictionary(tenantId: string, id: string): Promise<boolean>;
}

/** 资产种子行：[code, name, category, description, sourceService, storage, updateFrequency, plotLinked] */
const ASSET_SEED: Array<[string, string, DataAssetCategory, string, string, string, string, boolean]> = [
  ["plot_records", "地块台账", "SPATIAL", "地块编码、名称、权属、面积与边界几何，全平台数据归集主线", "plot-service", "PostgreSQL + PostGIS", "低频（建档/边界变更时）", true],
  ["plot_zones", "片区范围", "SPATIAL", "片区台账与成员地块凸包范围", "plot-service", "PostgreSQL + PostGIS", "低频（人工调整时）", true],
  ["infra_lines", "线路与管线", "SPATIAL", "机耕道/管线走向与宽度、限速、适用机型等台账属性", "plot-service", "PostgreSQL + PostGIS", "低频（建档/编辑时）", true],
  ["devices", "设备台账", "DEVICE", "设备类型、型号厂商、安装位置、通信方式与在线状态", "iot-service", "PostgreSQL", "低频（建档/维护时）", true],
  ["telemetry_readings", "墒情与苗情读数", "TELEMETRY", "土壤温度/湿度/EC/pH/养分与苗情长势指标读数", "telemetry-service", "PostgreSQL", "实时（按设备上报周期）", true],
  ["telemetry_pest_events", "虫情事件", "TELEMETRY", "虫情测报与视频 AI 识别归集的害虫事件", "telemetry-service", "PostgreSQL", "实时（上报/识别回调）", true],
  ["telemetry_disasters", "灾情记录", "TELEMETRY", "涝灾/倒伏等灾情上报记录", "telemetry-service", "PostgreSQL", "实时（上报时）", true],
  ["telemetry_alerts", "遥测告警", "TELEMETRY", "阈值越限与 AI 识别统一收口的告警", "telemetry-service", "PostgreSQL", "实时（阈值判定时）", true],
  ["telemetry_quality_logs", "数据质量异常日志", "TELEMETRY", "超量程/连续不变/时间戳异常三类可疑标记日志", "telemetry-service", "PostgreSQL", "实时（接入校验时）", true],
  ["weather_forecasts", "七日天气预报", "TELEMETRY", "日粒度预报：天气现象、温度区间、风力风速、降雨概率与雨量", "weather-service", "PostgreSQL", "每日一次（配和风 Key 后外部同步，未配时本地种子）", false],
  ["weather_forecast_hours", "逐小时天气预报", "TELEMETRY", "未来逐小时天气现象与要素预报", "weather-service", "PostgreSQL", "每日一次（随日预报同步）", false],
  ["weather_alerts", "气象灾害预警", "TELEMETRY", "外部气象预警落库，含级别/类型/有效期", "weather-service", "PostgreSQL", "每日一次（随外部预警同步）", false],
  ["video_ai_events", "视频 AI 识别事件", "TELEMETRY", "摄像机侧算法识别回调，七类事件白名单校验后留记录", "video-service", "PostgreSQL", "实时（识别回调时）", true],
  ["operation_tasks", "农事任务", "BUSINESS", "六类作业任务台账：排程、优先级、执行设备与状态机", "operation-service", "PostgreSQL", "实时（建档/状态跃迁时）", true],
  ["operation_task_change_logs", "任务变更留痕", "BUSINESS", "建档/跃迁/归档追加式留痕，含操作人与 traceId", "operation-service", "PostgreSQL", "实时（随变更同事务追加）", true],
  ["control_commands", "控制指令台账", "BUSINESS", "十一码指令状态机与回执、超时收口留痕", "control-service", "PostgreSQL", "实时（事件驱动/人工下发）", true],
  ["control_authorizations", "指令授权范围", "BUSINESS", "设备/地块通配 + 授权时间窗的范围管控配置", "control-service", "PostgreSQL", "低频（人工维护时）", true],
  ["decision_prescriptions", "决策处方", "BUSINESS", "规则引擎签发的灌溉/施肥/配比调整处方与执行回流", "decision-service", "PostgreSQL", "实时（规则命中签发时）", true],
  ["decision_rules", "阈值与处方规则", "BUSINESS", "遥测越限阈值与处方动作规则配置", "decision-service", "PostgreSQL", "低频（人工维护时）", false],
  ["trace_records", "生产档案", "BUSINESS", "作业结单回流与人工巡田登记的生产链条时间线", "trace-service", "PostgreSQL", "实时（结单/登记时）", true],
  ["plot_change_logs", "地块变更留痕", "BUSINESS", "建档/编辑/合并/拆分/流转追加式留痕", "plot-service", "PostgreSQL", "实时（随变更同事务追加）", true],
  ["crop_seasons", "种植季档案", "BUSINESS", "地块按季登记作物品种与生育期安排", "plot-service", "PostgreSQL", "低频（按季建档时）", true],
  ["ops_messages", "消息中心", "BUSINESS", "事件订阅生成的告警/通知消息与处置留痕", "message-service", "PostgreSQL", "实时（事件消费时）", false],
  ["video_recording_archives", "录像留档档案", "BUSINESS", "告警/识别时刻前后应留片段的档案，片源由流媒体侧回填", "video-service", "PostgreSQL", "实时（AI 事件自动登记/人工补登）", true],
  ["variable_rate_plans", "变量作业方案", "BUSINESS", "覆盖路径逐带速率映射与用量汇总的方案落库", "operation-service", "PostgreSQL", "按需（方案预演生成时）", true],
  ["finance_entries", "投入产出流水", "STATS", "人工记账的投入/产出流水，监管统计报表前端聚合", "finance-service", "PostgreSQL", "低频（人工记账时）", true],
];

/** 字典种子行：[assetCode, metricKey, label, definition, unit, source, updateFrequency]，dataType 均为 number */
const DICT_SEED: Array<[string, string, string, string, string, string, string]> = [
  ["telemetry_readings", "soilTemperature", "土壤温度", "田间传感器上报的土壤温度读数", "°C", "田间设备上报 → telemetry-service", "实时（按设备上报周期）"],
  ["telemetry_readings", "soilMoisture", "土壤湿度", "土壤含水量读数，灌溉阈值判定与自动停灌的依据", "%", "田间设备上报 → telemetry-service", "实时（按设备上报周期）"],
  ["telemetry_readings", "soilEc", "土壤EC", "土壤电导率读数，反映盐分水平，EC/pH 偏离联动配比调整", "μS/cm", "田间设备上报 → telemetry-service", "实时（按设备上报周期）"],
  ["telemetry_readings", "soilPh", "土壤pH", "土壤酸碱度读数，无量纲", "", "田间设备上报 → telemetry-service", "实时（按设备上报周期）"],
  ["telemetry_readings", "soilNitrogen", "氮含量", "土壤氮含量读数", "mg/kg", "田间设备上报 → telemetry-service", "实时（按设备上报周期）"],
  ["telemetry_readings", "soilPhosphorus", "磷含量", "土壤磷含量读数", "mg/kg", "田间设备上报 → telemetry-service", "实时（按设备上报周期）"],
  ["telemetry_readings", "soilPotassium", "钾含量", "土壤钾含量读数", "mg/kg", "田间设备上报 → telemetry-service", "实时（按设备上报周期）"],
  ["telemetry_readings", "soilOrganicMatter", "有机质", "土壤有机质含量读数", "mg/kg", "田间设备上报 → telemetry-service", "实时（按设备上报周期）"],
  ["telemetry_readings", "airTemperature", "空气温度", "田间气象站空气温度读数", "°C", "田间设备上报 → telemetry-service", "实时（按设备上报周期）"],
  ["telemetry_readings", "airHumidity", "空气湿度", "田间气象站空气相对湿度读数", "%", "田间设备上报 → telemetry-service", "实时（按设备上报周期）"],
  ["telemetry_readings", "windSpeed", "风速", "田间气象站风速读数，喷药适宜性判定要素", "m/s", "田间设备上报 → telemetry-service", "实时（按设备上报周期）"],
  ["telemetry_readings", "rainfall", "降雨量", "田间气象站降雨量读数", "mm", "田间设备上报 → telemetry-service", "实时（按设备上报周期）"],
  ["telemetry_readings", "plantHeight", "株高", "苗情长势株高读数", "cm", "田间设备上报 → telemetry-service", "实时（按设备上报周期）"],
  ["telemetry_readings", "leafColor", "叶色", "苗情叶色读数（SPAD 值）", "SPAD", "田间设备上报 → telemetry-service", "实时（按设备上报周期）"],
  ["telemetry_readings", "canopyCoverage", "苗情覆盖度", "冠层覆盖度读数，长势网格热力插值输入之一", "%", "田间设备上报 → telemetry-service", "实时（按设备上报周期）"],
  ["telemetry_readings", "uniformity", "均匀度", "苗情长势均匀度读数", "%", "田间设备上报 → telemetry-service", "实时（按设备上报周期）"],
  ["telemetry_readings", "pestCount", "虫口密度", "害虫虫口密度读数", "头/百株", "虫情测报/视频 AI 识别 → telemetry-service", "实时（上报/识别回调）"],
  ["telemetry_readings", "diseaseIndex", "病情指数", "病害发生程度指数，无量纲", "", "田间设备上报 → telemetry-service", "实时（按设备上报周期）"],
  ["weather_forecasts", "rainProbability", "降雨概率", "日预报降雨概率，灌溉推迟与喷防改期判定要素", "%", "和风天气每日同步 / 本地演示种子", "每日一次"],
  ["weather_forecasts", "rainAmount", "预报雨量", "日预报降水量", "mm", "和风天气每日同步 / 本地演示种子", "每日一次"],
  ["weather_forecasts", "tempMax", "最高温度", "日预报最高气温", "°C", "和风天气每日同步 / 本地演示种子", "每日一次"],
  ["weather_forecasts", "tempMin", "最低温度", "日预报最低气温", "°C", "和风天气每日同步 / 本地演示种子", "每日一次"],
  ["weather_forecasts", "windLevel", "风力等级", "日预报风力等级（级），喷药适宜性判定要素", "级", "和风天气每日同步 / 本地演示种子", "每日一次"],
  ["plot_records", "areaMu", "地块面积", "地块几何面积权威值，PostGIS 现算，不接受请求体自报", "亩", "plot-service 几何现算", "边界变更时现算"],
  ["operation_tasks", "finishedAreaMu", "完成作业面积", "任务完工回执填报的实际作业面积", "亩", "operation-service 任务回执", "任务完工时"],
  ["control_commands", "waterVolume", "灌溉用水量", "灌溉指令结单回执上报的用水量；缺测时由处方定额推算并标注来源", "m³", "control-service 结单回执", "指令 DONE 回执时"],
];

const SEED_AT = "2026-11-18T00:00:00.000Z";
const pad3 = (index: number): string => String(index + 1).padStart(3, "0");

/** 演示种子：与迁移 058 的 INSERT 逐条同口径；构造函数默认不塞，由组合根/服务工厂显式注入 */
export function seedDataCatalog(): { assets: DataAsset[]; dictionary: DataDictionaryEntry[] } {
  return {
    assets: ASSET_SEED.map(([code, name, category, description, sourceService, storage, updateFrequency, plotLinked], index) => ({
      id: `asset-demo-${pad3(index)}`, tenantId: "tenant-demo", code, name, category, description, sourceService, storage, updateFrequency, plotLinked, createdAt: SEED_AT, updatedAt: SEED_AT,
    })),
    dictionary: DICT_SEED.map(([assetCode, metricKey, label, definition, unit, source, updateFrequency], index) => ({
      id: `dict-demo-${pad3(index)}`, tenantId: "tenant-demo", assetCode, metricKey, label, definition, unit, dataType: "number", source, updateFrequency, createdAt: SEED_AT, updatedAt: SEED_AT,
    })),
  };
}

function toPage<T>(items: T[], total: number, page: number, size: number): PageResult<T> {
  return { items, total, page, size, pages: Math.ceil(total / size) };
}

export class InMemoryDataCatalogRepository implements DataCatalogRepository {
  private readonly assets: DataAsset[];
  private readonly dictionary: DataDictionaryEntry[];
  constructor(seed: { assets?: DataAsset[]; dictionary?: DataDictionaryEntry[] } = {}) {
    this.assets = structuredClone(seed.assets ?? []);
    this.dictionary = structuredClone(seed.dictionary ?? []);
  }
  async pageAssets(tenantId: string, query: DataAssetQuery): Promise<PageResult<DataAsset>> {
    const filtered = this.assets.filter((asset) => asset.tenantId === tenantId
      && (!query.category || asset.category === query.category)
      && (!query.keyword || keywordHits(query.keyword, [asset.name, asset.code, asset.description])))
      .sort((a, b) => a.code.localeCompare(b.code));
    return toPage(structuredClone(filtered.slice((query.page - 1) * query.size, query.page * query.size)), filtered.length, query.page, query.size);
  }
  async findAsset(tenantId: string, id: string): Promise<DataAsset | null> {
    const asset = this.assets.find((row) => row.id === id && row.tenantId === tenantId);
    return asset ? structuredClone(asset) : null;
  }
  async findAssetByCode(tenantId: string, code: string): Promise<DataAsset | null> {
    const asset = this.assets.find((row) => row.code === code && row.tenantId === tenantId);
    return asset ? structuredClone(asset) : null;
  }
  async createAsset(record: DataAsset): Promise<DataAsset> {
    this.assets.push(structuredClone(record));
    return structuredClone(record);
  }
  async updateAsset(record: DataAsset): Promise<DataAsset> {
    const index = this.assets.findIndex((row) => row.id === record.id && row.tenantId === record.tenantId);
    if (index >= 0) this.assets[index] = structuredClone(record);
    return structuredClone(record);
  }
  async removeAsset(tenantId: string, id: string): Promise<boolean> {
    const index = this.assets.findIndex((row) => row.id === id && row.tenantId === tenantId);
    if (index < 0) return false;
    this.assets.splice(index, 1);
    return true;
  }
  async countDictionaryByAsset(tenantId: string, assetCode: string): Promise<number> {
    return this.dictionary.filter((row) => row.tenantId === tenantId && row.assetCode === assetCode).length;
  }
  async pageDictionary(tenantId: string, query: DataDictionaryQuery): Promise<PageResult<DataDictionaryEntry>> {
    const filtered = this.dictionary.filter((entry) => entry.tenantId === tenantId
      && (!query.assetCode || entry.assetCode === query.assetCode)
      && (!query.keyword || keywordHits(query.keyword, [entry.label, entry.metricKey, entry.definition])))
      .sort((a, b) => a.assetCode.localeCompare(b.assetCode) || a.metricKey.localeCompare(b.metricKey));
    return toPage(structuredClone(filtered.slice((query.page - 1) * query.size, query.page * query.size)), filtered.length, query.page, query.size);
  }
  async findDictionary(tenantId: string, id: string): Promise<DataDictionaryEntry | null> {
    const entry = this.dictionary.find((row) => row.id === id && row.tenantId === tenantId);
    return entry ? structuredClone(entry) : null;
  }
  async findDictionaryByKey(tenantId: string, assetCode: string, metricKey: string): Promise<DataDictionaryEntry | null> {
    const entry = this.dictionary.find((row) => row.tenantId === tenantId && row.assetCode === assetCode && row.metricKey === metricKey);
    return entry ? structuredClone(entry) : null;
  }
  async createDictionary(record: DataDictionaryEntry): Promise<DataDictionaryEntry> {
    this.dictionary.push(structuredClone(record));
    return structuredClone(record);
  }
  async updateDictionary(record: DataDictionaryEntry): Promise<DataDictionaryEntry> {
    const index = this.dictionary.findIndex((row) => row.id === record.id && row.tenantId === record.tenantId);
    if (index >= 0) this.dictionary[index] = structuredClone(record);
    return structuredClone(record);
  }
  async removeDictionary(tenantId: string, id: string): Promise<boolean> {
    const index = this.dictionary.findIndex((row) => row.id === id && row.tenantId === tenantId);
    if (index < 0) return false;
    this.dictionary.splice(index, 1);
    return true;
  }
}

function fromAssetRow(row: Record<string, unknown>): DataAsset {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), code: String(row.code), name: String(row.name),
    category: row.category as DataAssetCategory, description: String(row.description ?? ""),
    sourceService: String(row.source_service ?? ""), storage: String(row.storage ?? ""), updateFrequency: String(row.update_frequency ?? ""),
    plotLinked: row.plot_linked === true, createdAt: toIsoTimestamp(row.created_at), updatedAt: toIsoTimestamp(row.updated_at),
  };
}

function fromDictionaryRow(row: Record<string, unknown>): DataDictionaryEntry {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), assetCode: String(row.asset_code), metricKey: String(row.metric_key),
    label: String(row.label), definition: String(row.definition ?? ""), unit: String(row.unit ?? ""), dataType: String(row.data_type ?? ""),
    source: String(row.source ?? ""), updateFrequency: String(row.update_frequency ?? ""),
    createdAt: toIsoTimestamp(row.created_at), updatedAt: toIsoTimestamp(row.updated_at),
  };
}

export class SqlDataCatalogRepository implements DataCatalogRepository {
  constructor(private readonly client: PrismaClientLike) {}
  async pageAssets(tenantId: string, query: DataAssetQuery): Promise<PageResult<DataAsset>> {
    const values: unknown[] = [tenantId];
    const where = ["tenant_id = $1"];
    if (query.category) { values.push(query.category); where.push(`category = $${values.length}`); }
    if (query.keyword) { values.push(likePattern(query.keyword)); where.push(`(name ILIKE $${values.length} OR code ILIKE $${values.length} OR description ILIKE $${values.length})`); }
    const filter = where.join(" AND ");
    const counts = await this.client.$queryRawUnsafe<Array<{ total: string }>>(`SELECT count(*) AS total FROM platform_data_assets WHERE ${filter}`, ...values);
    const total = Number(counts[0]?.total ?? 0);
    values.push(query.size, (query.page - 1) * query.size);
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM platform_data_assets WHERE ${filter} ORDER BY code ASC LIMIT $${values.length - 1} OFFSET $${values.length}`, ...values);
    return toPage(rows.map(fromAssetRow), total, query.page, query.size);
  }
  async findAsset(tenantId: string, id: string): Promise<DataAsset | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM platform_data_assets WHERE tenant_id = $1 AND id = $2`, tenantId, id);
    return rows[0] ? fromAssetRow(rows[0]) : null;
  }
  async findAssetByCode(tenantId: string, code: string): Promise<DataAsset | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM platform_data_assets WHERE tenant_id = $1 AND code = $2`, tenantId, code);
    return rows[0] ? fromAssetRow(rows[0]) : null;
  }
  async createAsset(record: DataAsset): Promise<DataAsset> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `INSERT INTO platform_data_assets (id, tenant_id, code, name, category, description, source_service, storage, update_frequency, plot_linked, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12::timestamptz) RETURNING *`,
      record.id, record.tenantId, record.code, record.name, record.category, record.description, record.sourceService, record.storage, record.updateFrequency, record.plotLinked, record.createdAt, record.updatedAt,
    );
    return fromAssetRow(rows[0]!);
  }
  async updateAsset(record: DataAsset): Promise<DataAsset> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `UPDATE platform_data_assets SET name = $3, category = $4, description = $5, source_service = $6, storage = $7, update_frequency = $8, plot_linked = $9, updated_at = $10::timestamptz
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      record.tenantId, record.id, record.name, record.category, record.description, record.sourceService, record.storage, record.updateFrequency, record.plotLinked, record.updatedAt,
    );
    return fromAssetRow(rows[0]!);
  }
  async removeAsset(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.client.$queryRawUnsafe<Array<{ id: string }>>(`DELETE FROM platform_data_assets WHERE tenant_id = $1 AND id = $2 RETURNING id`, tenantId, id);
    return rows.length > 0;
  }
  async countDictionaryByAsset(tenantId: string, assetCode: string): Promise<number> {
    const rows = await this.client.$queryRawUnsafe<Array<{ total: string }>>(`SELECT count(*) AS total FROM platform_data_dictionary WHERE tenant_id = $1 AND asset_code = $2`, tenantId, assetCode);
    return Number(rows[0]?.total ?? 0);
  }
  async pageDictionary(tenantId: string, query: DataDictionaryQuery): Promise<PageResult<DataDictionaryEntry>> {
    const values: unknown[] = [tenantId];
    const where = ["tenant_id = $1"];
    if (query.assetCode) { values.push(query.assetCode); where.push(`asset_code = $${values.length}`); }
    if (query.keyword) { values.push(likePattern(query.keyword)); where.push(`(label ILIKE $${values.length} OR metric_key ILIKE $${values.length} OR definition ILIKE $${values.length})`); }
    const filter = where.join(" AND ");
    const counts = await this.client.$queryRawUnsafe<Array<{ total: string }>>(`SELECT count(*) AS total FROM platform_data_dictionary WHERE ${filter}`, ...values);
    const total = Number(counts[0]?.total ?? 0);
    values.push(query.size, (query.page - 1) * query.size);
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM platform_data_dictionary WHERE ${filter} ORDER BY asset_code ASC, metric_key ASC LIMIT $${values.length - 1} OFFSET $${values.length}`, ...values);
    return toPage(rows.map(fromDictionaryRow), total, query.page, query.size);
  }
  async findDictionary(tenantId: string, id: string): Promise<DataDictionaryEntry | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM platform_data_dictionary WHERE tenant_id = $1 AND id = $2`, tenantId, id);
    return rows[0] ? fromDictionaryRow(rows[0]) : null;
  }
  async findDictionaryByKey(tenantId: string, assetCode: string, metricKey: string): Promise<DataDictionaryEntry | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM platform_data_dictionary WHERE tenant_id = $1 AND asset_code = $2 AND metric_key = $3`, tenantId, assetCode, metricKey);
    return rows[0] ? fromDictionaryRow(rows[0]) : null;
  }
  async createDictionary(record: DataDictionaryEntry): Promise<DataDictionaryEntry> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `INSERT INTO platform_data_dictionary (id, tenant_id, asset_code, metric_key, label, definition, unit, data_type, source, update_frequency, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12::timestamptz) RETURNING *`,
      record.id, record.tenantId, record.assetCode, record.metricKey, record.label, record.definition, record.unit, record.dataType, record.source, record.updateFrequency, record.createdAt, record.updatedAt,
    );
    return fromDictionaryRow(rows[0]!);
  }
  async updateDictionary(record: DataDictionaryEntry): Promise<DataDictionaryEntry> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `UPDATE platform_data_dictionary SET label = $3, definition = $4, unit = $5, data_type = $6, source = $7, update_frequency = $8, updated_at = $9::timestamptz
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      record.tenantId, record.id, record.label, record.definition, record.unit, record.dataType, record.source, record.updateFrequency, record.updatedAt,
    );
    return fromDictionaryRow(rows[0]!);
  }
  async removeDictionary(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.client.$queryRawUnsafe<Array<{ id: string }>>(`DELETE FROM platform_data_dictionary WHERE tenant_id = $1 AND id = $2 RETURNING id`, tenantId, id);
    return rows.length > 0;
  }
}