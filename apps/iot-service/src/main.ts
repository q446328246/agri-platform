import 'reflect-metadata';

import { PgClientAdapter, resolveDatabaseUrl } from '@agri/db';

import { createIotHttpServer } from './http.js';
import { FieldGateway } from './field-gateway.js';
import { DEFAULT_TENANT, InMemoryDeviceRepository, SqlDeviceRepository, demoDevices } from './device.repository.js';
import type { DeviceRepository } from './device.repository.js';

/**
 * 设备台账服务启动。
 *
 * 有数据库时台账落 devices 表（演示设备见迁移 014，租户归属见迁移 035），页面新增的设备重启后仍在；
 * 没有数据库时退回内存实现并装载同一批演示设备，保证本地无库调试可用。
 * 内存模式的演示设备跟着 `TENANT_ID` 落位，否则单现场部署配了租户后列表会是空的。
 *
 * 现场协议网关默认不启（`FIELD_GATEWAY_ENABLED=1` 才启）：没配现场凭证就常驻轮询，
 * 只会让 control-service 的日志里刷满未授权的下发失败。
 */

async function bootstrap(): Promise<void> {
  if (process.env.SERVICE_MODE !== 'http') {
    console.log('iot-service service started (demo mode)');
    return;
  }

  const port = Number(process.env.PORT ?? 3003);
  const mode = process.env.IOT_REPOSITORY_MODE === 'memory' || !process.env.DB_URL ? 'memory' : 'sql';

  let client: PgClientAdapter | undefined;
  let devices: DeviceRepository;
  if (mode === 'sql') {
    client = PgClientAdapter.fromUrl(resolveDatabaseUrl(process.env.DB_URL));
    await client.$connect();
    devices = new SqlDeviceRepository(client);
  } else {
    devices = new InMemoryDeviceRepository(demoDevices(process.env.TENANT_ID?.trim() || DEFAULT_TENANT));
  }

  const server = createIotHttpServer({ devices });
  server.listen(port, '127.0.0.1', () => console.log(`iot-service HTTP started on ${port} (${mode})`));

  const gatewayEnabled = ['1', 'true'].includes((process.env.FIELD_GATEWAY_ENABLED ?? '').toLowerCase());
  const gateway = gatewayEnabled ? new FieldGateway({ devices }) : undefined;
  if (gateway) {
    gateway.start();
    console.log(`iot-service 现场协议网关已启动 -> ${process.env.CONTROL_SERVICE_URL ?? 'http://127.0.0.1:3008'}`);
  }

  const shutdown = async (): Promise<void> => {
    server.close();
    await gateway?.stop();
    await client?.$disconnect();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

await bootstrap();
