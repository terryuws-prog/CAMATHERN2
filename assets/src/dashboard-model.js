import { catchments, kunerPayloads, siteRegistry, standards } from "./data.js";

export function getKunerDevicePayloads() {
  return kunerPayloads.map(({ deviceId, transmittedAt, battery, tideState, sensorDepthM, samples }) => ({
    deviceId,
    transmittedAt,
    battery,
    tideState,
    sensorDepthM,
    samples,
  }));
}

export function qualityControlReading(reading) {
  if (reading.tideState === "exposed" || reading.sensorDepthM < 0.12) {
    return { valid: false, reason: "Sensor exposed by tide", colour: "red" };
  }

  if (reading.flow <= 0 || reading.dissolvedOxygen > 13) {
    return { valid: false, reason: "Out-of-water signature", colour: "red" };
  }

  return { valid: true, reason: "Valid", colour: "green" };
}

function thresholdStatus(samples) {
  const breaches = Object.entries(standards).filter(([key, range]) => {
    const value = samples[key];
    return typeof value === "number" && (value < range.min || value > range.max);
  });

  if (breaches.length >= 3) return "high";
  if (breaches.length > 0) return "watch";
  return "good";
}

function scoreSite(payload) {
  const qc = qualityControlReading({
    dissolvedOxygen: payload.samples.dissolvedOxygen,
    flow: payload.samples.flow,
    tideState: payload.tideState,
    sensorDepthM: payload.sensorDepthM,
  });
  const threshold = thresholdStatus(payload.samples);

  if (!qc.valid) return 84;
  if (threshold === "high") return 76;
  if (threshold === "watch") return 52;
  return 24;
}

export function createDashboardSnapshot() {
  const payloadByDevice = new Map(kunerPayloads.map((payload) => [payload.deviceId, payload]));
  const sites = siteRegistry.map((site) => {
    const payload = payloadByDevice.get(site.deviceId);
    const qc = qualityControlReading({
      dissolvedOxygen: payload.samples.dissolvedOxygen,
      flow: payload.samples.flow,
      tideState: payload.tideState,
      sensorDepthM: payload.sensorDepthM,
    });
    const status = thresholdStatus(payload.samples);

    return {
      ...site,
      transmittedAt: payload.transmittedAt,
      battery: payload.battery,
      samples: payload.samples,
      qc,
      status: qc.valid ? status : "invalid",
      riskScore: scoreSite(payload),
    };
  });

  const validReadings = sites.filter((site) => site.qc.valid).length;
  const invalidReadings = sites.length - validReadings;
  const highAccessRisk = sites.filter((site) => site.accessRisk === "high").length;

  return {
    generatedAt: "2026-05-11T08:20:00Z",
    summary: {
      monitoringPoints: 30,
      visibleSites: sites.length,
      validReadings,
      invalidReadings,
      highAccessRisk,
      transmissionsPerDay: 2,
    },
    catchments,
    sites,
    standards,
  };
}
