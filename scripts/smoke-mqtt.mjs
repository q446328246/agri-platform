import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

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
const clients = [];

for (const [name, value] of Object.entries({ MQTT_USERNAME: serviceUsername, MQTT_PASSWORD: servicePassword, MQTT_DEVICE_USERNAME: deviceUsername, MQTT_DEVICE_PASSWORD: devicePassword })) {
  if (!value) throw new Error(`${name} is required; run with node --env-file=.env`);
}
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
  const receivedTelemetry = waitFor(service, "message").then(([topic, payload]) => {
    assert(topic === deviceTelemetryTopic, "Telemetry arrived on an unexpected topic");
    return JSON.parse(String(payload));
  });
  await publish(device, deviceTelemetryTopic, { metric: "soilMoisture", value: 12, runId });
  assert((await receivedTelemetry).runId === runId, "Telemetry payload did not survive relay");

  const commandId = `smoke-${runId}`;
  const receivedCommand = waitFor(device, "message").then(([topic, payload]) => {
    assert(topic === commandTopic, "Command arrived on an unexpected topic");
    return JSON.parse(String(payload));
  });
  await publish(service, commandTopic, { id: commandId, type: "IRRIGATION", status: "SENT" });
  assert((await receivedCommand).id === commandId, "Command payload did not survive relay");

  const receivedReceipt = waitFor(service, "message").then(([topic, payload]) => {
    assert(topic === deviceReceiptTopic, "Receipt arrived on an unexpected topic");
    return JSON.parse(String(payload));
  });
  await publish(device, deviceReceiptTopic, { commandId, status: "ACKED", runId });
  assert((await receivedReceipt).commandId === commandId, "Receipt payload did not survive relay");

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
  console.log("MQTT TLS authentication, device isolation, telemetry, command and receipt smoke passed");
} finally {
  await Promise.all(clients.map((client) => new Promise((resolve) => client.end(true, resolve))));
}
