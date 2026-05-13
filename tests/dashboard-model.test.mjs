import assert from "node:assert/strict";
import test from "node:test";
import {
  createDashboardSnapshot,
  getKunerDevicePayloads,
  qualityControlReading,
} from "../assets/src/dashboard-model.js";

test("Kuner payloads expose device IDs without coordinates", () => {
  const payloads = getKunerDevicePayloads();

  assert.ok(payloads.length >= 6);
  for (const payload of payloads) {
    assert.match(payload.deviceId, /^KNR-[A-Z0-9-]+$/);
    assert.equal("latitude" in payload, false);
    assert.equal("longitude" in payload, false);
    assert.equal("location" in payload, false);
  }
});

test("dashboard joins locations from council registry only", () => {
  const snapshot = createDashboardSnapshot();
  const manorafon = snapshot.sites.find((site) => site.name === "Manorafon");

  assert.equal(snapshot.summary.monitoringPoints, 30);
  assert.equal(manorafon.catchment, "Tywi");
  assert.equal(manorafon.locationSource, "Council SharePoint registry");
  assert.equal(manorafon.telemetry, "LoRaWAN");
});

test("quality control flags exposed-at-low-tide readings as invalid", () => {
  const result = qualityControlReading({
    dissolvedOxygen: 14.6,
    flow: 0,
    tideState: "exposed",
    sensorDepthM: 0.03,
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, "Sensor exposed by tide");
  assert.equal(result.colour, "red");
});

test("quality control marks plausible submerged readings as valid", () => {
  const result = qualityControlReading({
    dissolvedOxygen: 8.4,
    flow: 2.2,
    tideState: "submerged",
    sensorDepthM: 0.8,
  });

  assert.equal(result.valid, true);
  assert.equal(result.reason, "Valid");
  assert.equal(result.colour, "green");
});
