// Pure helpers for history.html (no DOM), so they can be unit tested.
import { standards } from "./data.js?v=20261106";

// Readings are 30 minutes apart; anything longer than this counts as a gap.
export const GAP_MINUTES = 35;

// Parameters in the order of the chart buttons. `flag` is the sensor-ok field
// that marks a value as unreliable; `standard` links to the threshold band.
export const PARAMETERS = [
  { key: "ph", label: "pH", unit: "", flag: "ph_ok", standard: "ph" },
  { key: "temp_c", label: "Temperature", unit: "°C", flag: "temp_ok", standard: "temperature" },
  { key: "ec_us_cm", label: "Conductivity", unit: "µS/cm", flag: "ec_ok", standard: "conductivity" },
  { key: "do_mg_l", label: "Dissolved oxygen", unit: "mg/L", flag: "do_ok", standard: "dissolvedOxygen" },
  { key: "nh4_reported_mg_l", label: "Ammonium", unit: "mg/L", flag: "nh4_ok", standard: "ammonium" },
  { key: "no3_reported_mg_l", label: "Nitrate", unit: "mg/L", flag: "no3_ok", standard: "nitrate" },
  { key: "depth_m", label: "Depth", unit: "m" },
  { key: "voltage_v", label: "Voltage", unit: "V" },
  { key: "flow_l_min", label: "Flow", unit: "L/min", placeholderFlag: "flow_placeholder" },
];

const FLAG_LABELS = {
  rtc_ok: "RTC",
  ph_ok: "pH",
  temp_ok: "Temp",
  ec_ok: "EC",
  do_ok: "DO",
  nh4_ok: "NH4",
  no3_ok: "NO3",
};

const API_ROOTS = { live: "/cam/api/v1", dev: "/cam/dev/api/v1" };

export function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function readState(search) {
  const params = new URLSearchParams(search);
  const range = params.get("range");
  return {
    source: params.get("source") === "dev" ? "dev" : "live",
    node: params.get("node") || null,
    hours: range === "all" ? null : Number(range) > 0 ? Number(range) : 168,
    param: PARAMETERS.some((p) => p.key === params.get("param")) ? params.get("param") : "ph",
  };
}

export function stateToSearch(state) {
  const params = new URLSearchParams();
  if (state.source === "dev") params.set("source", "dev");
  if (state.node) params.set("node", state.node);
  params.set("range", state.hours == null ? "all" : String(state.hours));
  if (state.param !== "ph") params.set("param", state.param);
  return `?${params.toString()}`;
}

export function historyUrl(state, format = "json") {
  const params = new URLSearchParams();
  if (state.node) params.set("node_id", state.node);
  if (state.hours != null) params.set("hours", String(state.hours));
  if (state.source === "dev") params.set("include_test", "true");
  if (format === "csv") params.set("format", "csv");
  return `${API_ROOTS[state.source]}/history?${params.toString()}`;
}

const minutesBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 60000;

// True when the reading's time came from the device clock. Otherwise only the
// arrival time is known, so it is listed but not plotted or used for gaps.
export function hasDeviceTime(reading) {
  return Boolean(reading.timestampUtc) && reading.rtc_ok !== false;
}

// Gaps between consecutive readings (by observation time) longer than GAP_MINUTES.
export function findGaps(readings, maxMinutes = GAP_MINUTES) {
  const times = readings.filter(hasDeviceTime).map((r) => r.observedAt).sort();
  const gaps = [];
  for (let i = 1; i < times.length; i += 1) {
    const minutes = minutesBetween(times[i - 1], times[i]);
    if (minutes > maxMinutes) gaps.push({ from: times[i - 1], to: times[i], minutes });
  }
  return gaps;
}

// Names of the flags that are off for one reading, e.g. ["DO", "RTC"].
export function failingFlags(reading) {
  return Object.entries(FLAG_LABELS)
    .filter(([field]) => reading[field] === false)
    .map(([, label]) => label);
}

export function uploadDelayMinutes(reading) {
  if (!hasDeviceTime(reading)) return null;
  return Math.round(minutesBetween(reading.timestampUtc, reading.receivedAt));
}

export function summarize(readings) {
  const gaps = findGaps(readings);
  const received = readings.map((r) => r.receivedAt).filter(Boolean).sort();
  const latestVoltage = readings.find((r) => isNumber(r.voltage_v))?.voltage_v ?? null;
  return {
    count: readings.length,
    lastReceived: received.length ? received[received.length - 1] : null,
    gaps: gaps.length,
    longestGapMinutes: gaps.reduce((max, g) => Math.max(max, g.minutes), 0),
    flagged: readings.filter((r) => failingFlags(r).length > 0).length,
    latestVoltage,
  };
}

export function parameterFor(key) {
  return PARAMETERS.find((p) => p.key === key) ?? PARAMETERS[0];
}

// Points for the chart, oldest first. A point is "flagged" when its sensor
// flag is off (or the flow is a placeholder); `breakBefore` starts a new line
// segment after a gap.
export function seriesFor(readings, key) {
  const param = parameterFor(key);
  const points = readings
    .filter((r) => hasDeviceTime(r) && isNumber(r[param.key]))
    .map((r) => ({
      time: Date.parse(r.observedAt),
      observedAt: r.observedAt,
      value: r[param.key],
      flagged: Boolean((param.flag && r[param.flag] === false) || (param.placeholderFlag && r[param.placeholderFlag] === true)),
      testMode: Boolean(r.test_mode),
    }))
    .sort((a, b) => a.time - b.time);
  points.forEach((p, i) => {
    p.breakBefore = i > 0 && (p.time - points[i - 1].time) / 60000 > GAP_MINUTES;
  });
  return points;
}

export function standardFor(key) {
  const param = parameterFor(key);
  return param.standard ? standards[param.standard] ?? null : null;
}

// Rounded axis ticks covering [min, max].
export function niceTicks(min, max, count = 5) {
  if (!isNumber(min) || !isNumber(max)) return [];
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / Math.max(count - 1, 1);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.5; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}
