import 'reflect-metadata';

import { PgClientAdapter, resolveDatabaseUrl } from '@agri/db';

import { createFinanceHttpServer } from './http.js';
import { InMemoryFinanceRepository, SqlFinanceRepository } from './repository.js';
import type { FinanceEntry, FinanceRepository } from './repository.js';

/**
 * 核算服务启动。
 *
 * 有数据库时投入产出明细落 finance_entries 表（演示数据见迁移 010），
 * 没有数据库时退回内存实现并装载同一批演示明细，保证核算页有账可看。
 */

const daysAgo = (days: number): string => new Date(Date.now() - days * 86400000).toISOString();

/** 内存模式的演示明细：与迁移 010 的口径一致，只保留主力地块便于本地无库调试 */
function demoEntries(): FinanceEntry[] {
  const east = '511723-000001-01-00001-0000-5';
  const west = '511723-000001-02-00005-0000-C';
  const rows: Array<[string, string, FinanceEntry['kind'], string, number, string, number]> = [
    [east, '2026', 'INPUT', '种子', 941.40, '晶两优534 杂交稻种', 96],
    [east, '2026', 'INPUT', '复合肥', 2067.00, '15-15-15 配方肥 4 袋/亩', 78],
    [east, '2026', 'INPUT', '农机作业', 2496.00, '机耕、机插、机收外包', 42],
    [east, '2026', 'INPUT', '人工', 3072.00, '田间管理与管护用工', 24],
    [east, '2026', 'OUTPUT', '稻谷销售', 21582.00, '按 1.32 元/斤 订单结算', 12],
    [east, '2026', 'OUTPUT', '种粮补贴', 2945.00, '实际种粮农民一次性补贴', 18],
    [west, '2026', 'INPUT', '农药', 1646.40, '戊唑醇、氯虫苯甲酰胺', 30],
    [west, '2026', 'INPUT', '灌溉水电', 1421.00, '水肥一体化首部用电', 21],
    [west, '2026', 'OUTPUT', '稻谷销售', 22028.00, '按 1.32 元/斤 订单结算', 10],
    [west, '2026', 'OUTPUT', '秸秆出售', 1633.50, '打包外运至养殖场', 15],
    [west, '2025', 'INPUT', '复合肥', 1900.80, '上季基肥', 150],
    [west, '2025', 'OUTPUT', '稻谷销售', 19392.00, '上季订单收购', 140],
  ];
  return rows.map(([plotCode, season, kind, category, amount, note, day]) => ({
    id: `fin-demo-${plotCode.slice(-11)}-${kind.slice(0, 3).toLowerCase()}-${category}`,
    plotCode, season, kind, category, amount, unit: '元', note, createdAt: daysAgo(day),
  }));
}

async function bootstrap(): Promise<void> {
  if (process.env.SERVICE_MODE !== 'http') {
    console.log('finance-service service started (demo mode)');
    return;
  }

  const port = Number(process.env.PORT ?? 3010);
  const mode = process.env.FINANCE_REPOSITORY_MODE === 'memory' || !process.env.DB_URL ? 'memory' : 'sql';

  let client: PgClientAdapter | undefined;
  let records: FinanceRepository;
  if (mode === 'sql') {
    client = PgClientAdapter.fromUrl(resolveDatabaseUrl(process.env.DB_URL));
    await client.$connect();
    records = new SqlFinanceRepository(client);
  } else {
    const memory = new InMemoryFinanceRepository();
    for (const entry of demoEntries()) await memory.create(entry);
    records = memory;
  }

  const server = createFinanceHttpServer(records);
  server.listen(port, '127.0.0.1', () =>
    console.log(`finance-service HTTP started on ${port}（${mode === 'sql' ? 'SQL 持久化' : '内存实现'}）`),
  );

  const shutdown = async (): Promise<void> => {
    server.close();
    await client?.$disconnect();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

await bootstrap();
