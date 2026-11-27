const DAY_MS = 24 * 60 * 60_000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60_000;
const REFERENCE_DAY_START_MS = Date.UTC(2026, 0, 1) - SHANGHAI_OFFSET_MS;

const metric = (name, unit, base, amplitude, decimals, min, max, kind = "wave", extra = {}) => ({
  metric: name,
  unit,
  base,
  amplitude,
  decimals,
  min,
  max,
  kind,
  ...extra,
});

const WEATHER_METRICS = [
  metric("airTemperature", "°C", 21, 6, 1, -10, 45, "airTemperature"),
  metric("airHumidity", "%", 68, 16, 1, 20, 100, "airHumidity"),
  metric("windSpeed", "m/s", 2.4, 1.8, 1, 0, 20),
  metric("windDirection", "°", 135, 65, 0, 0, 359, "direction"),
  metric("rainfall", "mm", 0.02, 2.8, 2, 0, 80, "rainfall"),
  metric("lightIntensity", "lux", 42_000, 12_000, 0, 0, 120_000, "light"),
  metric("atmosphericPressure", "hPa", 1008, 0.8, 1, 960, 1060, "pressure"),
];

const SOIL_METRICS = [
  metric("soilMoisture", "%", 34, 3.2, 1, 8, 60, "soilMoisture", { depthCm: 20 }),
  metric("soilTemperature", "°C", 19, 4.5, 1, 0, 45, "soilTemperature", { depthCm: 20 }),
  metric("soilEc", "μS/cm", 1150, 180, 0, 100, 5000, "soilEc", { depthCm: 20 }),
  metric("soilPh", "pH", 6.8, 0.15, 2, 4, 9, "soilPh", { depthCm: 20 }),
];

export const DEVICE_TELEMETRY_PROFILES = Object.freeze({
  PLC: [
    metric("voltage", "V", 24, 0.25, 2, 20, 28),
    metric("current", "A", 1.8, 0.35, 2, 0, 8, "current"),
    metric("temperature", "°C", 28, 3, 1, 0, 70, "operationalTemperature"),
    metric("signalStrength", "dBm", -62, 7, 0, -110, -30, "signal"),
    metric("cpuLoad", "%", 38, 14, 1, 0, 100),
  ],
  WEATHER_STATION: WEATHER_METRICS,
  SOIL_SENSOR: [
    metric("soilMoisture", "%", 35, 3, 1, 8, 60, "soilMoisture", { depthCm: 10 }),
    metric("soilMoisture", "%", 32, 3, 1, 8, 60, "soilMoisture", { depthCm: 20 }),
    metric("soilMoisture", "%", 29, 2.8, 1, 8, 60, "soilMoisture", { depthCm: 30 }),
    ...SOIL_METRICS.slice(1),
  ],
  INTEGRATED_STATION: [
    ...WEATHER_METRICS,
    ...SOIL_METRICS,
    metric("co2Concentration", "ppm", 480, 85, 0, 350, 2000, "co2"),
  ],
  REMOTE_SENSE: [
    metric("plantHeight", "cm", 68, 1.8, 1, 0, 200, "growth"),
    metric("leafColor", "SPAD", 38, 1.2, 1, 0, 80, "growth"),
    metric("canopyCoverage", "%", 68, 1.8, 1, 0, 100, "growth"),
    metric("uniformity", "%", 78, 1.6, 1, 0, 100, "growth"),
    metric("ndvi", "", 0.72, 0.025, 3, 0, 1, "growth"),
  ],
  INSECT_LAMP: [
    metric("pestCount", "头/百株", 6, 3, 1, 0, 100, "pest"),
    metric("lampTemperature", "°C", 30, 5, 1, 0, 85, "operationalTemperature", { activeHeat: 22 }),
    metric("batteryLevel", "%", 92, 1, 1, 10, 100, "battery"),
    metric("voltage", "V", 12.6, 0.35, 2, 10, 14),
    metric("signalStrength", "dBm", -68, 6, 0, -115, -35, "signal"),
  ],
  FERTILIZER_VALVE: [
    metric("flowRate", "m³/h", 8, 1.2, 2, 0, 30, "flow", { flowFactor: 0.8 }),
    metric("valveOpening", "%", 72, 10, 1, 0, 100, "opening"),
    metric("linePressure", "MPa", 0.24, 0.025, 4, 0, 1, "operationalPressure"),
    metric("soilEc", "μS/cm", 1450, 160, 0, 200, 5000, "soilEc"),
    metric("solutionLevel", "%", 74, 2.5, 1, 0, 100, "solutionLevel"),
    metric("motorCurrent", "A", 3.8, 0.5, 2, 0, 15, "current"),
    metric("water_meter", "m³", 0, 0, 2, 0, Number.MAX_SAFE_INTEGER, "waterMeter"),
  ],
  IRRIGATION_VALVE: [
    metric("flowRate", "m³/h", 9, 1.4, 2, 0, 35, "flow", { flowFactor: 0.9 }),
    metric("valveOpening", "%", 76, 10, 1, 0, 100, "opening"),
    metric("linePressure", "MPa", 0.22, 0.025, 4, 0, 1, "operationalPressure"),
    metric("soilMoisture", "%", 32, 2.8, 1, 8, 60, "soilMoisture"),
    metric("water_meter", "m³", 0, 0, 2, 0, Number.MAX_SAFE_INTEGER, "waterMeter"),
  ],
  IRRIGATION_PUMP: [
    metric("water_meter", "m³", 0, 0, 2, 0, Number.MAX_SAFE_INTEGER, "waterMeter"),
    metric("flowRate", "m³/h", 10, 1.1, 2, 0, 50, "flow"),
    metric("outletPressure", "MPa", 0.32, 0.03, 4, 0, 1.2, "operationalPressure"),
    metric("motorCurrent", "A", 11.5, 1.1, 2, 0, 40, "current"),
    metric("voltage", "V", 380, 3.5, 1, 340, 420),
    metric("motorTemperature", "°C", 32, 4, 1, 0, 95, "operationalTemperature", { activeHeat: 24 }),
    metric("vibration", "mm/s", 1.15, 0.28, 3, 0, 10, "vibration"),
    metric("pumpSpeed", "rpm", 1450, 35, 0, 0, 3000, "pumpSpeed"),
  ],
  AGRICULTURAL_DRONE: [
    metric("batteryLevel", "%", 92, 1, 1, 10, 100, "battery"),
    metric("voltage", "V", 24.8, 0.45, 2, 18, 26),
    metric("flightSpeed", "m/s", 7.5, 1.4, 1, 0, 20, "flightSpeed"),
    metric("altitude", "m", 18, 2.5, 1, 0, 120, "altitude"),
    metric("heading", "°", 120, 75, 0, 0, 359, "direction"),
    metric("signalStrength", "dBm", -64, 7, 0, -115, -35, "signal"),
    metric("motorTemperature", "°C", 34, 4, 1, 0, 95, "operationalTemperature", { activeHeat: 18 }),
  ],
  AUTO_TRACTOR: [
    metric("engineSpeed", "rpm", 1450, 180, 0, 0, 2500, "engineSpeed"),
    metric("vehicleSpeed", "km/h", 5.5, 1.2, 1, 0, 30, "vehicleSpeed"),
    metric("fuelLevel", "%", 82, 1, 1, 5, 100, "fuel"),
    metric("engineTemperature", "°C", 72, 5, 1, 0, 120, "operationalTemperature", { activeHeat: 12 }),
    metric("hydraulicPressure", "MPa", 16, 1.5, 1, 0, 25, "operationalPressure", { standbyFactor: 0.35 }),
    metric("workingArea", "ha", 0, 0, 3, 0, Number.MAX_SAFE_INTEGER, "workingArea"),
    metric("signalStrength", "dBm", -61, 6, 0, -115, -35, "signal"),
  ],
});

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomAt(seed) {
  let value = (seed + 0x6d2b79f5) >>> 0;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function noise(state, definition, atMs, salt = 0) {
  const seed = hashText(`${state.fixture.deviceNo}|${definition.metric}|${definition.depthCm ?? ""}|${Math.floor(atMs / 1000)}|${salt}`);
  return randomAt(seed) * 2 - 1;
}

function localDay(atMs) {
  const date = new Date(atMs + SHANGHAI_OFFSET_MS);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const startMs = Date.UTC(year, month, day) - SHANGHAI_OFFSET_MS;
  const minute = (atMs - startMs) / 60_000;
  return { year, month, day, startMs, minute, hour: minute / 60 };
}

function dailyWave(hour, peakHour) {
  return Math.cos((2 * Math.PI * (hour - peakHour)) / 24);
}

function scheduleFor(state) {
  const seed = randomAt(hashText(`${state.fixture.deviceNo}|schedule`));
  const type = state.fixture.type;
  if (["IRRIGATION_PUMP", "IRRIGATION_VALVE", "FERTILIZER_VALVE"].includes(type)) {
    return [
      { start: 6.25 + seed * 0.75, duration: 1.5 + seed * 0.8 },
      { start: 15.5 + seed * 0.5, duration: 1.2 + seed * 0.7 },
    ];
  }
  if (type === "INSECT_LAMP") return [{ start: 19, duration: 10 }];
  if (type === "AGRICULTURAL_DRONE" || type === "AUTO_TRACTOR") {
    return [{ start: 8 + seed * 1.5, duration: 3 + seed * 1.5 }];
  }
  return [];
}

function activeMinutesBefore(state, atMs) {
  const day = localDay(atMs);
  return scheduleFor(state).reduce((total, window) => {
    const overlap = Math.max(0, Math.min(day.minute, (window.start + window.duration) * 60) - window.start * 60);
    return total + overlap;
  }, 0);
}

export function meterM3At(state, atMs) {
  const day = localDay(atMs);
  const dayIndex = Math.max(0, Math.floor((day.startMs - REFERENCE_DAY_START_MS) / DAY_MS));
  const dailyMinutes = scheduleFor(state).reduce((total, window) => total + window.duration * 60, 0);
  const volume = state.flowM3h * (dayIndex * dailyMinutes + activeMinutesBefore(state, atMs)) / 60;
  return Number(volume.toFixed(3));
}

function runningAt(state, atMs) {
  if (atMs >= state.startedAt) return state.switchOn && !state.faulted;
  const day = localDay(atMs);
  const hour = day.hour;
  return scheduleFor(state).some((window) => hour >= window.start && hour < window.start + window.duration);
}

function operationalValue(state, definition, atMs, jitter) {
  const running = runningAt(state, atMs);
  const ambient = definition.base + definition.amplitude * dailyWave(localDay(atMs).hour, 15) * 0.25;
  switch (definition.kind) {
    case "flow":
      return running ? state.flowM3h * (definition.flowFactor ?? 1) * (0.94 + jitter * 0.06) : 0;
    case "opening":
      return running ? definition.base + definition.amplitude * jitter : 0;
    case "operationalPressure":
      return running ? definition.base + definition.amplitude * jitter : definition.base * (definition.standbyFactor ?? 0.16) * (0.96 + jitter * 0.04);
    case "current":
      return running ? definition.base + definition.amplitude * jitter : definition.base * (0.06 + Math.abs(jitter) * 0.015);
    case "operationalTemperature":
      return ambient + (running ? definition.activeHeat ?? 12 : 0) + definition.amplitude * jitter * 0.25 + (state.faulted ? 8 : 0);
    case "vibration":
      return running ? definition.base + definition.amplitude * jitter : 0.05 + jitter * 0.04;
    case "pumpSpeed":
    case "engineSpeed":
      return running ? definition.base + definition.amplitude * jitter : 0;
    case "flightSpeed":
    case "vehicleSpeed":
      return running ? definition.base + definition.amplitude * jitter : 0;
    case "altitude":
      return running ? definition.base + definition.amplitude * jitter : 0;
    default:
      return ambient + definition.amplitude * jitter;
  }
}

function valueOf(state, definition, atMs) {
  const day = localDay(atMs);
  const jitter = noise(state, definition, atMs);
  const slow = Math.sin(atMs / (6.5 * 60 * 60_000) + randomAt(hashText(`${state.fixture.deviceNo}|phase`)) * Math.PI * 2);
  let value;
  switch (definition.kind) {
    case "waterMeter":
      value = atMs >= state.startedAt ? state.counts * state.scale : meterM3At(state, atMs);
      break;
    case "workingArea": {
      const dayIndex = Math.max(0, Math.floor((day.startMs - REFERENCE_DAY_START_MS) / DAY_MS));
      const dailyMinutes = scheduleFor(state).reduce((total, window) => total + window.duration * 60, 0);
      value = (dayIndex * dailyMinutes + activeMinutesBefore(state, atMs)) / 60 * 0.42;
      break;
    }
    case "airTemperature":
      value = definition.base + definition.amplitude * dailyWave(day.hour, 15) + slow * 0.8 + jitter * 0.45;
      break;
    case "airHumidity":
      value = definition.base - definition.amplitude * dailyWave(day.hour, 15) * 0.75 - slow * 2 + jitter * 1.2;
      break;
    case "soilTemperature":
      value = definition.base + definition.amplitude * dailyWave(day.hour, 16) * 0.65 + slow * 0.5 + jitter * 0.25;
      break;
    case "soilMoisture":
      value = definition.base - (definition.depthCm ?? 20) * 0.08 + slow * definition.amplitude * 0.55 + jitter * 0.65;
      break;
    case "soilEc":
      value = definition.base + slow * definition.amplitude * 0.6 + jitter * 25;
      break;
    case "soilPh":
      value = definition.base + slow * definition.amplitude * 0.35 + jitter * 0.025;
      break;
    case "rainfall": {
      const pulse = Math.sin((2 * Math.PI * (day.hour - 16)) / 24 + randomAt(hashText(`${state.fixture.deviceNo}|rain`)) * 0.8);
      value = pulse > 0.93 ? definition.amplitude * (0.5 + Math.abs(jitter)) : 0.01 + Math.abs(jitter) * 0.035;
      break;
    }
    case "light":
      value = Math.max(0, Math.sin((Math.PI * (day.hour - 6)) / 12)) * (definition.base + jitter * definition.amplitude);
      break;
    case "pressure":
      value = definition.base + slow * definition.amplitude + jitter * 0.06;
      break;
    case "co2":
      value = definition.base + slow * definition.amplitude * 0.6 + jitter * 12 - Math.max(0, dailyWave(day.hour, 15)) * 25;
      break;
    case "direction":
      value = (definition.base + definition.amplitude * dailyWave(day.hour, 9) + jitter * 24 + 360) % 360;
      break;
    case "growth":
      value = definition.base + slow * definition.amplitude * 0.45 + jitter * definition.amplitude * 0.18;
      break;
    case "pest":
      value = Math.max(0, definition.base + slow * definition.amplitude * 0.55 + jitter * 1.8);
      break;
    case "battery":
      value = Math.min(100, definition.base - day.minute * 0.012 + jitter * 0.35);
      break;
    case "fuel":
      value = Math.max(5, definition.base - day.minute * 0.006 + jitter * 0.2);
      break;
    case "solutionLevel":
      value = Math.max(0, definition.base - day.minute * 0.008 + slow * definition.amplitude * 0.25 + jitter * 0.3);
      break;
    case "signal":
      value = definition.base + jitter * definition.amplitude;
      break;
    case "flow":
    case "opening":
    case "operationalPressure":
    case "current":
    case "operationalTemperature":
    case "vibration":
    case "pumpSpeed":
    case "engineSpeed":
    case "flightSpeed":
    case "vehicleSpeed":
    case "altitude":
      value = operationalValue(state, definition, atMs, jitter);
      break;
    default:
      value = operationalValue(state, definition, atMs, jitter) + slow * definition.amplitude * 0.08;
  }
  const rounded = Number(value.toFixed(definition.decimals));
  return Math.min(definition.max, Math.max(definition.min, Object.is(rounded, -0) ? 0 : rounded));
}

export function telemetryReadings(state, atMs) {
  const profile = DEVICE_TELEMETRY_PROFILES[state.fixture.type];
  if (!profile) throw new Error(`设备类型 ${state.fixture.type} 尚未配置遥测模拟剖面`);
  return profile.map((definition) => ({
    deviceId: state.fixture.deviceId,
    metric: definition.metric,
    value: valueOf(state, definition, atMs),
    unit: definition.unit,
    recordedAt: new Date(atMs).toISOString(),
    ...(definition.depthCm === undefined ? {} : { depthCm: definition.depthCm }),
  }));
}

export function historyTimestamps(nowMs, hours, intervalMinutes) {
  const intervalMs = intervalMinutes * 60_000;
  const fromMs = Math.floor((nowMs - hours * 60 * 60_000) / intervalMs) * intervalMs;
  const toMs = Math.floor(nowMs / intervalMs) * intervalMs;
  const timestamps = [];
  for (let at = fromMs; at <= toMs; at += intervalMs) timestamps.push(at);
  return timestamps;
}
