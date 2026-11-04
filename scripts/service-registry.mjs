const defaults = [
  ["auth", 3001, "apps/auth-service/dist/main.js"],
  ["plot", 3002, "apps/plot-service/dist/main.js"],
  ["iot", 3003, "apps/iot-service/dist/main.js"],
  ["telemetry", 3004, "apps/telemetry-service/dist/main.js"],
  ["weather", 3005, "apps/weather-service/dist/main.js"],
  ["decision", 3006, "apps/decision-service/dist/main.js"],
  ["operation", 3007, "apps/operation-service/dist/main.js"],
  ["control", 3008, "apps/control-service/dist/main.js"],
  ["video", 3009, "apps/video-service/dist/main.js"],
  ["finance", 3010, "apps/finance-service/dist/main.js"],
  ["trace", 3011, "apps/trace-service/dist/main.js"],
  ["message", 3012, "apps/message-service/dist/main.js"],
  ["file", 3013, "apps/file-service/dist/main.js"],
  ["platform", 3014, "apps/platform-service/dist/main.js"],
  ["gateway", 8080, "apps/gateway-service/dist/main.js"],
];

export function getServices(env = process.env) {
  return defaults.map(([name, port, entry]) => [name, Number(env[`AGRI_${name.toUpperCase()}_PORT`] ?? port), entry]);
}
