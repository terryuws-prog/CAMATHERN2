import assert from "node:assert/strict";
import test from "node:test";
import {
  UNASSIGNED_CATCHMENT,
  createDashboardSnapshot,
  qualityControlReading,
} from "../assets/src/dashboard-model.js";
import { siteRegistry } from "../assets/src/data.js";
import { dashboardUrl, dataSource, fetchDashboard } from "../assets/src/live-data.js";

// Shape of GET /api/v1/dashboard
function liveBody(nodes) {
  return { generatedAt: "2026-10-31T01:00:00Z", hours: 24, includeTest: false, nodes };
}

function node(overrides = {}) {
  return {
    deviceId: "node-01",
    name: "River test node",
    observedAt: "2026-10-31T00:30:00Z",
    receivedAt: "2026-10-31T00:31:00Z",
    rtcOk: true,
    voltageV: 3.9,
    sensorDepthM: 0.4,
    tideState: "unknown",
    testMode: false,
    samples: { ph: 7.2, temperature: 11.5, conductivity: 410, dissolvedOxygen: 9.1, nitrate: 2.2, ammonium: 0.1, flow: null },
    history: [],
    ...overrides,
  };
}

test("no live data means an empty dashboard, not demo data", () => {
  const snapshot = createDashboardSnapshot();

  assert.equal(snapshot.sites.length, 0);
  assert.equal(snapshot.catchments.length, 0);
  assert.equal(snapshot.summary.monitoringPoints, 0);
});

test("live devices not in the registry are shown as unassigned", () => {
  const snapshot = createDashboardSnapshot(liveBody([node()]));
  const [site] = snapshot.sites;

  assert.equal(snapshot.sites.length, 1);
  assert.equal(site.deviceId, "node-01");
  assert.equal(site.name, "River test node");
  assert.equal(site.catchment, UNASSIGNED_CATCHMENT.name);
  assert.equal(site.registered, false);
  assert.equal(site.latitude, null);
  assert.equal(site.transmittedAt, "2026-10-31T00:30:00Z");
  assert.deepEqual(snapshot.catchments, [UNASSIGNED_CATCHMENT]);
});

test("dashboard joins locations from the council registry by device ID", () => {
  const registered = siteRegistry.find((site) => site.name === "Manorafon");
  const snapshot = createDashboardSnapshot(liveBody([node({ deviceId: registered.deviceId })]));
  const [site] = snapshot.sites;

  assert.equal(site.catchment, "Tywi");
  assert.equal(site.locationSource, "Council SharePoint registry");
  assert.equal(site.registered, true);
  assert.equal(snapshot.catchments[0].nameCy, "Tywi");
});

test("live payloads carry no coordinates of their own", () => {
  const snapshot = createDashboardSnapshot(liveBody([node({ latitude: 1, longitude: 2 })]));

  assert.equal(snapshot.sites[0].latitude, null);
  assert.equal(snapshot.sites[0].longitude, null);
});

test("missing values never fail quality control on their own", () => {
  const result = qualityControlReading({ dissolvedOxygen: null, flow: null, tideState: "unknown", sensorDepthM: null });

  assert.equal(result.valid, true);
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

test("quality control flags shallow sensors and out-of-water signatures", () => {
  assert.equal(qualityControlReading({ sensorDepthM: 0.05, tideState: "unknown" }).reason, "Sensor exposed by tide");
  assert.equal(qualityControlReading({ dissolvedOxygen: 14, tideState: "unknown" }).reason, "Out-of-water signature");
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

test("dashboard reads production by default and the test database with ?source=dev", () => {
  assert.equal(dataSource(""), "live");
  assert.equal(dataSource("?source=dev"), "dev");
  assert.equal(dashboardUrl("live"), "/cam/api/v1/dashboard");
  assert.equal(dashboardUrl("dev"), "/cam/dev/api/v1/dashboard?include_test=true");
});

test("fetchDashboard rejects error responses and unexpected bodies", async () => {
  const respond = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });

  assert.equal((await fetchDashboard("live", respond(200, liveBody([node()])))).nodes.length, 1);
  await assert.rejects(fetchDashboard("live", respond(502, {})));
  await assert.rejects(fetchDashboard("live", respond(200, { not: "nodes" })));
});
