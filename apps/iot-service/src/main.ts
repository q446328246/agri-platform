import 'reflect-metadata';

import { PgClientAdapter, resolveDatabaseUrl } from '@agri/db';

import { createIotHttpServer } from './http.js';
import { createMqttBroker } from './mqtt-broker.js';
import { createMqttCommandRelay } from './command-relay.js';
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

  // MQTT 接入（A2）：订阅设备遥测/回执 topic 并转发，同时提供指令下发通道；缺省关闭，保留 HTTP 回调链路
  const mqttEnabled = ['1', 'true'].includes((process.env.IOT_MQTT_ENABLED ?? '').toLowerCase());
  const mqttBroker = mqttEnabled
    ? createMqttBroker({
        telemetryUrl: process.env.TELEMETRY_SERVICE_URL,
        controlUrl: process.env.CONTROL_SERVICE_URL,
        deviceToken: process.env.DEVICE_CALLBACK_TOKEN,
      })
    : undefined;
  if (mqttBroker) {
    mqttBroker.start();
    console.log(`iot-service MQTT 接入已启动 -> ${process.env.MQTT_URL ?? 'mqtt://127.0.0.1:1883'}，上报 ${process.env.TELEMETRY_SERVICE_URL ?? 'http://127.0.0.1:3004'}`);
  }

  // MQTT 指令中继（B2）：MQTT 直连设备不经场网关，由本中继按设备轮询控制服务待领取指令并发布，
  // 否则指令停在 QUEUED 无人领取（缺陷 1+2 的下发侧）。只处理 QUEUED：领取后即 SENT，不会重复发布。
  const relayIntervalMs = Number(process.env.IOT_MQTT_RELAY_INTERVAL_MS) || 2000;
  const relay = mqttBroker
    ? createMqttCommandRelay({
        devices,
        controlUrl: process.env.CONTROL_SERVICE_URL,
        tenantId: process.env.TENANT_ID?.trim() || DEFAULT_TENANT,
        deviceToken: process.env.DEVICE_CALLBACK_TOKEN,
        publishCommand: mqttBroker.publishCommand,
        intervalMs: relayIntervalMs,
      })
    : undefined;
  if (relay) {
    relay.start();
    console.log(`iot-service MQTT 指令中继已启动 -> ${process.env.CONTROL_SERVICE_URL ?? 'http://127.0.0.1:3008'}，轮询间隔 ${relayIntervalMs} 毫秒`);
  }

  const gatewayEnabled = ['1', 'true'].includes((process.env.FIELD_GATEWAY_ENABLED ?? '').toLowerCase());
  const gateway = gatewayEnabled ? new FieldGateway({ devices, publishCommand: mqttBroker?.publishCommand }) : undefined;
  if (gateway) {
    gateway.start();
    console.log(`iot-service 现场协议网关已启动 -> ${process.env.CONTROL_SERVICE_URL ?? 'http://127.0.0.1:3008'}`);
  }

  const shutdown = async (): Promise<void> => {
    server.close();
    await gateway?.stop();
    relay?.stop();
    await mqttBroker?.stop();
    await client?.$disconnect();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

await bootstrap();
