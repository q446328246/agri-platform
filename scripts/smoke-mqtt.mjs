import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";

const require = createRequire(new URL("../apps/iot-service/package.json", import.meta.url));
const mqtt = require("mqtt");
const url = process.env.MQTT_URL ?? "mqtts://127.0.0.1:8883";
const caPath = process.env.MQTT_CA_PATH;
const topicPrefix = process.env.MQTT_TOPIC_PREFIX || "agri";
const tenantId = process.env.TENANT_ID || "tenant-demo";
const serviceUsername = process.env.MQTT_USERNAME;
const servicePassword = process.env.MQTT_PASSWORD;
const deviceUsername = process.env.MQTT_DEVICE_USERNAME;
const devicePassword = process.env.MQTT_DEVICE_PASSWORD;
const databaseUrl = process.env.DB_URL;
const clients = [];
let database;
let commandId;
let telemetryKey;

for (const [name, value] of Object.entries({ MQTT_USERNAME: serviceUsername, MQTT_PASSWORD: servicePassword, MQTT_DEVICE_USERNAME: deviceUsername, MQTT_DEVICE_PASSWORD: devicePassword })) {
  if (!value) throw new Error(`${name} is required; run with node --env-file=.env`);
}
if (!databaseUrl) throw new Error("DB_URL is required; run with node --env-file=.env");
for (const [name, value] of Object.entries({ MQTT_USERNAME: serviceUsername, MQTT_DEVICE_USERNAME: deviceUsername, MQTT_TOPIC_PREFIX: topicPrefix, TENANT_ID: tenantId })) {
  if (/[+/#\s]/.test(value)) throw new Error(`${name} contains an invalid MQTT identifier character`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function waitFor(client, event, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for MQTT ${event}`)), timeoutMs);
    client.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

async function waitUntil(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function connect(username, password, label) {
  const client = mqtt.connect(url, {
    clientId: `smoke-${label}-${randomBytes(6).toString("hex")}`,
    username,
    password,
    clean: true,
    protocolVersion: 5,
    reconnectPeriod: 0,
    connectTimeout: 10_000,
    rejectUnauthorized: true,
    servername: "localhost",
    ...(caPath ? { ca: readFileSync(caPath) } : {}),
  });
  clients.push(client);
  return client;
}

async function subscribe(client, topic) {
  const granted = await new Promise((resolve, reject) => {
    client.subscribe(topic, { qos: 1 }, (error, result) => error ? reject(error) : resolve(result?.[0]?.qos));
  });
  assert(granted === 1, `Subscription was not granted at QoS 1: ${topic}`);
}

async function publish(client, topic, payload) {
  await new Promise((resolve, reject) => {
    client.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => error ? reject(error) : resolve());
  });
}

async function rejectConnection(username, password, label) {
  const client = connect(username, password, label);
  try {
    const [error] = await waitFor(client, "error");
    assert(error, "Invalid MQTT credentials were accepted");
  } finally {
    await new Promise((resolve) => client.end(true, resolve));
  }
}

try {
  database = new Client({ connectionString: databaseUrl });
  await database.connect();
  await rejectConnection(serviceUsername, randomBytes(24).toString("base64url"), "bad-auth");
  const service = connect(serviceUsername, servicePassword, "service");
  await waitFor(service, "connect");
  const device = connect(deviceUsername, devicePassword, "device");
  await waitFor(device, "connect");

  const telemetryTopic = `${topicPrefix}/${tenantId}/+/telemetry`;
  const receiptTopic = `${topicPrefix}/${tenantId}/+/receipt`;
  const commandTopic = `${topicPrefix}/${tenantId}/${deviceUsername}/command`;
  const deviceTelemetryTopic = `${topicPrefix}/${tenantId}/${deviceUsername}/telemetry`;
  const deviceReceiptTopic = `${topicPrefix}/${tenantId}/${deviceUsername}/receipt`;
  await subscribe(service, telemetryTopic);
  await subscribe(service, receiptTopic);
  await subscribe(device, commandTopic);

  const runId = randomBytes(8).toString("hex");
  const deviceResult = await database.query(
    "SELECT id FROM devices WHERE tenant_id = $1 AND device_no = $2 LIMIT 1",
    [tenantId, deviceUsername],
  );
  const deviceId = deviceResult.rows[0]?.id;
  assert(deviceId, `MQTT device is not registered: ${deviceUsername}`);
  const receivedTelemetry = waitFor(service, "message").then(([topic, payload]) => {
    assert(topic === deviceTelemetryTopic, "Telemetry arrived on an unexpected topic");
    return JSON.parse(String(payload));
  });
  telemetryKey = {
    deviceId,
    metric: "soilMoisture",
    value: Number((40 + randomBytes(4).readUInt32BE(0) % 200_000 / 10_000).toFixed(4)),
    recordedAt: new Date().toISOString(),
  };
  await publish(device, deviceTelemetryTopic, { ...telemetryKey, runId });
  assert((await receivedTelemetry).runId === runId, "Telemetry payload did not survive relay");
  await waitUntil(
    async () => (await database.query(
      "SELECT 1 FROM telemetry_readings WHERE device_id = $1 AND metric = $2 AND value = $3::numeric AND recorded_at = $4::timestamptz LIMIT 1",
      [telemetryKey.deviceId, telemetryKey.metric, telemetryKey.value, telemetryKey.recordedAt],
    )).rowCount === 1,
    "MQTT telemetry to reach telemetry-service",
  );

  commandId = `smoke-mqtt-${runId}`;
  await database.query(
    `INSERT INTO control_commands (id, tenant_id, device_id, plot_code, operator_id, type, parameters, status, origin, reason, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'QUEUED', 'MANUAL', $8, now())`,
    [commandId, tenantId, "device-tractor-001", "P-SMOKE-MQTT", "smoke-mqtt", "TOOL_SWITCH", JSON.stringify({ implement: "smoke" }), "MQTT 全链路冒烟"],
  );
  const receivedCommand = waitFor(device, "message", 15_000).then(([topic, payload]) => {
    assert(topic === commandTopic, "Command arrived on an unexpected topic");
    return JSON.parse(String(payload));
  });
  assert((await receivedCommand).id === commandId, "Control command did not survive the MQTT relay");

  const receivedReceipt = waitFor(service, "message").then(([topic, payload]) => {
    assert(topic === deviceReceiptTopic, "Receipt arrived on an unexpected topic");
    return JSON.parse(String(payload));
  });
  await publish(device, deviceReceiptTopic, { commandId, status: "ACKED", runId, deviceId: "device-tractor-001" });
  assert((await receivedReceipt).commandId === commandId, "Receipt payload did not survive relay");
  await waitUntil(
    async () => (await database.query("SELECT status FROM control_commands WHERE tenant_id = $1 AND id = $2", [tenantId, commandId])).rows[0]?.status === "ACKED",
    "MQTT receipt to reach control-service",
  );

  const deniedTopic = `${topicPrefix}/other-tenant/${deviceUsername}/telemetry`;
  const denied = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5_000);
    const finish = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    device.once("error", () => finish(true));
    device.once("close", () => finish(true));
    device.publish(deniedTopic, JSON.stringify({ runId }), { qos: 1 }, (error) => finish(Boolean(error)));
  });
  assert(denied, "Cross-tenant publish was not denied");
  console.log("MQTT TLS authentication, device isolation, telemetry, control command and receipt persistence smoke passed");
} finally {
  if (database && telemetryKey) {
    const readings = await database.query(
      "DELETE FROM telemetry_readings WHERE device_id = $1 AND metric = $2 AND value = $3::numeric AND recorded_at = $4::timestamptz RETURNING id",
      [telemetryKey.deviceId, telemetryKey.metric, telemetryKey.value, telemetryKey.recordedAt],
    );
    const readingIds = readings.rows.map((row) => row.id);
    if (readingIds.length > 0) {
      await database.query("DELETE FROM telemetry_quality_logs WHERE reading_id = ANY($1::text[])", [readingIds]);
    }
  }
  if (database && commandId) {
    await database.query("DELETE FROM mqtt_deliveries WHERE payload->>'id' = $1 OR payload->>'commandId' = $1", [commandId]);
    await database.query("DELETE FROM control_commands WHERE tenant_id = $1 AND id = $2", [tenantId, commandId]);
  }
  await Promise.all(clients.map((client) => new Promise((resolve) => client.end(true, resolve))));
  if (database) await database.end();
}
