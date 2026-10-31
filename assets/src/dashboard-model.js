import { catchments as catchmentDirectory, siteRegistry, standards } from "./data.js";

// Live devices that are not in the council registry yet are listed here.
export const UNASSIGNED_CATCHMENT = {
  id: "unassigned",
  name: "Unassigned",
  nameCy: "Heb ei neilltuo",
  area: "",
  type: "unknown",
};

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Missing values (null) never fail a check on their own.
export function qualityControlReading(reading) {
  if (reading.tideState === "exposed" || (isNumber(reading.sensorDepthM) && reading.sensorDepthM < 0.12)) {
    return { valid: false, reason: "Sensor exposed by tide", colour: "red" };
  }

  if ((isNumber(reading.flow) && reading.flow <= 0) || (isNumber(reading.dissolvedOxygen) && reading.dissolvedOxygen > 13)) {
    return { valid: false, reason: "Out-of-water signature", colour: "red" };
  }

  return { valid: true, reason: "Valid", colour: "green" };
}

function thresholdStatus(samples) {
  const breaches = Object.entries(standards).filter(([key, range]) => {
    const value = samples[key];
    return isNumber(value) && (value < range.min || value > range.max);
  });

  if (breaches.length >= 3) return "high";
  if (breaches.length > 0) return "watch";
  return "good";
}

function scoreSite(qc, threshold) {
  if (!qc.valid) return 84;
  if (threshold === "high") return 76;
  if (threshold === "watch") return 52;
  return 24;
}

// Device payloads carry an ID only; location and access notes come from the
// council registry (data.js). A device that is not registered yet is still
// shown, under "Unassigned", with its name from the device list.
export function registryEntryFor(node) {
  const entry = siteRegistry.find((site) => site.deviceId === node.deviceId);
  if (entry) return { ...entry, registered: true };

  const label = node.name || node.deviceId;
  return {
    id: node.deviceId,
    deviceId: node.deviceId,
    name: label,
    nameCy: label,
    catchment: UNASSIGNED_CATCHMENT.name,
    latitude: null,
    longitude: null,
    access: "",
    accessCy: "",
    accessRisk: null,
    deployment: "",
    deploymentCy: "",
    telemetry: "Cellular",
    locationSource: null,
    registered: false,
  };
}

function catchmentFor(name) {
  if (name === UNASSIGNED_CATCHMENT.name) return UNASSIGNED_CATCHMENT;
  return catchmentDirectory.find((catchment) => catchment.name === name) ?? { id: name, name, nameCy: name };
}

// `live` is the body of GET /api/v1/dashboard. With no argument the snapshot
// is empty (used while the first request is in flight).
export function createDashboardSnapshot(live = {}) {
  const nodes = Array.isArray(live.nodes) ? live.nodes : [];

  const sites = nodes.map((node) => {
    const site = registryEntryFor(node);
    const samples = node.samples ?? {};
    const qc = qualityControlReading({
      dissolvedOxygen: samples.dissolvedOxygen,
      flow: samples.flow,
      tideState: node.tideState,
      sensorDepthM: node.sensorDepthM,
    });
    const status = thresholdStatus(samples);

    return {
      ...site,
      transmittedAt: node.observedAt ?? node.receivedAt ?? null,
      receivedAt: node.receivedAt ?? null,
      voltageV: node.voltageV ?? null,
      rtcOk: node.rtcOk ?? null,
      testMode: Boolean(node.testMode),
      sensorDepthM: node.sensorDepthM ?? null,
      samples,
      history: Array.isArray(node.history) ? node.history : [],
      qc,
      status: qc.valid ? status : "invalid",
      riskScore: scoreSite(qc, status),
    };
  });

  const validReadings = sites.filter((site) => site.qc.valid).length;
  const catchmentNames = [...new Set(sites.map((site) => site.catchment))];

  return {
    generatedAt: live.generatedAt ?? null,
    summary: {
      monitoringPoints: sites.length,
      visibleSites: sites.length,
      validReadings,
      invalidReadings: sites.length - validReadings,
      highAccessRisk: sites.filter((site) => site.accessRisk === "high").length,
    },
    catchments: catchmentNames.map(catchmentFor),
    sites,
    standards,
  };
}
