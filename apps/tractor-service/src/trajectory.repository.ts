import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp, ulid } from "@agri/shared";

export const TRAJECTORY_SOURCES = ["AUTO", "MANUAL"] as const;
export type TrajectorySource = (typeof TRAJECTORY_SOURCES)[number];

/** 轨迹折点：[经度, 纬度] */
export type TrajectoryPoint = [number, number];

/** 作业带：一条扫描线的两端与里程（仅自动算的轨迹才有） */
export interface TrajectoryLane {
  /** 作业顺序，从 1 开始 */
  index: number;
  /** 同一条扫描线上的第几段 */
  pass: number;
  /** 作业带两端，按行进顺序 */
  coordinates: TrajectoryPoint[];
  lengthM: number;
}

/**
 * 拖拉机作业轨迹。
 *
 * 一次作业一条轨迹，随作业级联删除。轨迹与作业分表，不塞进分步参数：轨迹是可独立
 * 查看、复算、监测的实体，分步参数只带下发用的路径点——MQTT 指令载荷里是路径点，
 * 设备拿不到数据库里的轨迹行。
 */
export interface Trajectory {
  id: string;
  jobId: string;
  tenantId: string;
  plotCode: string;
  /** AUTO 由地块边界自动算（覆盖式牛耕）/ MANUAL 调用方直接传入轨迹点 */
  source: TrajectorySource;
  /** 连续路径折点，拖拉机按此跟随 */
  path: TrajectoryPoint[];
  /** 作业带，仅 AUTO */
  lanes?: TrajectoryLane[];
  /** 作业方向（自正北顺时针），仅 AUTO */
  headingDeg?: number;
  /** 农具幅宽（米），仅 AUTO */
  implementWidthM?: number;
  /** 轨迹总里程（米） */
  totalDistanceM: number;
  /** 按轨迹估算的作业时长（分钟） */
  durationMin: number;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateTrajectoryInput {
  jobId: string;
  tenantId: string;
  plotCode: string;
  source: TrajectorySource;
  path: TrajectoryPoint[];
  lanes?: TrajectoryLane[];
  headingDeg?: number;
  implementWidthM?: number;
  totalDistanceM: number;
  durationMin: number;
  warnings: string[];
}

export interface TrajectoryRepository {
  create(tx: Tx | undefined, input: CreateTrajectoryInput): Promise<Trajectory>;
  findByJob(tenantId: string, jobId: string): Promise<Trajectory | null>;
  listByJob(tenantId: string, jobId: string): Promise<Trajectory[]>;
}

/** 内存实现：仅供测试与降级路径，构造默认空库 */
export class InMemoryTrajectoryRepository implements TrajectoryRepository {
  private readonly trajectories = new Map<string, Trajectory>();

  async create(_tx: Tx | undefined, input: CreateTrajectoryInput): Promise<Trajectory> {
    if ([...this.trajectories.values()].some((trajectory) => trajectory.jobId === input.jobId)) {
      throw new Error("该作业已存在轨迹");
    }
    const now = new Date().toISOString();
    const trajectory: Trajectory = {
      id: ulid(),
      jobId: input.jobId,
      tenantId: input.tenantId,
      plotCode: input.plotCode,
      source: input.source,
      path: input.path.map((point) => [point[0], point[1]]),
      ...(input.lanes === undefined ? {} : { lanes: input.lanes.map((lane) => ({ ...lane, coordinates: lane.coordinates.map((point) => [point[0], point[1]]) })) }),
      ...(input.headingDeg === undefined ? {} : { headingDeg: input.headingDeg }),
      ...(input.implementWidthM === undefined ? {} : { implementWidthM: input.implementWidthM }),
      totalDistanceM: input.totalDistanceM,
      durationMin: input.durationMin,
      warnings: input.warnings,
      createdAt: now,
      updatedAt: now,
    };
    this.trajectories.set(trajectory.id, structuredClone(trajectory));
    return structuredClone(trajectory);
  }

  async findByJob(tenantId: string, jobId: string): Promise<Trajectory | null> {
    const found = [...this.trajectories.values()].find((trajectory) => trajectory.tenantId === tenantId && trajectory.jobId === jobId);
    return found ? structuredClone(found) : null;
  }

  async listByJob(tenantId: string, jobId: string): Promise<Trajectory[]> {
    return [...this.trajectories.values()].filter((trajectory) => trajectory.tenantId === tenantId && trajectory.jobId === jobId).map((trajectory) => structuredClone(trajectory));
  }
}

const columns = "id, job_id, tenant_id, plot_code, source, path, lanes, heading_deg, implement_width_m, total_distance_m, duration_min, warnings, created_at, updated_at";

function fromRow(row: Record<string, unknown>): Trajectory {
  const trajectory: Trajectory = {
    id: String(row.id),
    jobId: String(row.job_id),
    tenantId: String(row.tenant_id),
    plotCode: String(row.plot_code),
    source: row.source as TrajectorySource,
    path: (row.path as TrajectoryPoint[]).map((point) => [Number(point[0]), Number(point[1])]),
    totalDistanceM: Number(row.total_distance_m),
    durationMin: Number(row.duration_min),
    warnings: (row.warnings as string[]) ?? [],
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
  if (row.lanes !== null && row.lanes !== undefined) {
    trajectory.lanes = (row.lanes as TrajectoryLane[]).map((lane) => ({ ...lane, coordinates: lane.coordinates.map((point) => [Number(point[0]), Number(point[1])]) }));
  }
  if (row.heading_deg !== null && row.heading_deg !== undefined) trajectory.headingDeg = Number(row.heading_deg);
  if (row.implement_width_m !== null && row.implement_width_m !== undefined) trajectory.implementWidthM = Number(row.implement_width_m);
  return trajectory;
}

/** SQL 实现：迁移 071 的 tractor_trajectories */
export class SqlTrajectoryRepository implements TrajectoryRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async create(tx: Tx | undefined, input: CreateTrajectoryInput): Promise<Trajectory> {
    const client = tx ?? this.client;
    const parent = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id FROM tractor_jobs WHERE id = $1 AND tenant_id = $2 LIMIT 1`, input.jobId, input.tenantId,
    );
    if (!parent[0]) throw new Error("作业不存在或不属于当前租户");
    const now = new Date();
    const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `INSERT INTO tractor_trajectories (id, job_id, tenant_id, plot_code, source, path, lanes, heading_deg, implement_width_m, total_distance_m, duration_min, warnings, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12::jsonb, $13, $13)
       RETURNING ${columns}`,
      ulid(), input.jobId, input.tenantId, input.plotCode, input.source,
      JSON.stringify(input.path),
      input.lanes === undefined ? null : JSON.stringify(input.lanes),
      input.headingDeg ?? null,
      input.implementWidthM ?? null,
      input.totalDistanceM,
      input.durationMin,
      JSON.stringify(input.warnings),
      now,
    );
    return fromRow(rows[0]!);
  }

  async findByJob(tenantId: string, jobId: string): Promise<Trajectory | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${columns} FROM tractor_trajectories WHERE job_id = $1 AND tenant_id = $2 ORDER BY created_at LIMIT 1`, jobId, tenantId,
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async listByJob(tenantId: string, jobId: string): Promise<Trajectory[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${columns} FROM tractor_trajectories WHERE job_id = $1 AND tenant_id = $2 ORDER BY created_at`, jobId, tenantId,
    );
    return rows.map(fromRow);
  }
}
