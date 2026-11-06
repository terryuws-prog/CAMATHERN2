import assert from "node:assert/strict";
import test from "node:test";
import {
  failingFlags,
  findGaps,
  historyUrl,
  niceTicks,
  readState,
  seriesFor,
  standardFor,
  stateToSearch,
  summarize,
  uploadDelayMinutes,
} from "../assets/src/history-model.js";

const reading = (minute, overrides = {}) => ({
  observedAt: new Date(Date.UTC(2026, 10, 5, 0, minute)).toISOString().replace(".000Z", "Z"),
  timestampUtc: new Date(Date.UTC(2026, 10, 5, 0, minute)).toISOString().replace(".000Z", "Z"),
  receivedAt: new Date(Date.UTC(2026, 10, 5, 0, minute + 30)).toISOString().replace(".000Z", "Z"),
  rtc_ok: true, ph: 7.8, ph_ok: true, do_mg_l: 8, do_ok: true, voltage_v: 3.9, flow_l_min: 1, flow_placeholder: true,
  ...overrides,
});

test("URL state round-trips and defaults to 7 days of pH", () => {
  assert.deepEqual(readState(""), { source: "live", node: null, hours: 168, param: "ph" });
  const state = readState("?source=dev&node=node-01&range=all&param=do_mg_l");
  assert.deepEqual(state, { source: "dev", node: "node-01", hours: null, param: "do_mg_l" });
  assert.deepEqual(readState(stateToSearch(state)), state);
  assert.equal(readState("?param=evil").param, "ph");
});

test("history URLs target the right API and include test data on dev", () => {
  assert.equal(historyUrl({ source: "live", node: "node-01", hours: 24 }), "/cam/api/v1/history?node_id=node-01&hours=24");
  assert.equal(historyUrl({ source: "dev", node: "node-01", hours: null }, "csv"),
    "/cam/dev/api/v1/history?node_id=node-01&include_test=true&format=csv");
});

test("gaps longer than 35 minutes are found regardless of order", () => {
  const readings = [reading(150), reading(0), reading(30), reading(60)];
  const gaps = findGaps(readings);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].minutes, 90);
});

test("summary counts readings, gaps, flags and the latest voltage", () => {
  const readings = [reading(150, { voltage_v: 1.59 }), reading(60, { do_ok: false }), reading(30, { rtc_ok: false }), reading(0)];
  const s = summarize(readings);
  assert.equal(s.count, 4);
  assert.equal(s.gaps, 2); // the clock-less reading at 00:30 doesn't fill the gap
  assert.equal(s.flagged, 2);
  assert.equal(s.latestVoltage, 1.59);
  assert.equal(s.lastReceived, readings[0].receivedAt);
});

test("failing flags are named, upload delay needs a valid clock", () => {
  assert.deepEqual(failingFlags(reading(0, { do_ok: false, rtc_ok: false })), ["RTC", "DO"]);
  assert.deepEqual(failingFlags(reading(0)), []);
  assert.equal(uploadDelayMinutes(reading(0)), 30);
  assert.equal(uploadDelayMinutes(reading(0, { rtc_ok: false })), null);
});

test("series are oldest first, mark flagged points and break after gaps", () => {
  const points = seriesFor([reading(150), reading(30, { do_ok: false }), reading(0), reading(60, { do_mg_l: null })], "do_mg_l");
  assert.deepEqual(points.map((p) => p.value), [8, 8, 8]);
  assert.deepEqual(points.map((p) => p.flagged), [false, true, false]);
  assert.deepEqual(points.map((p) => p.breakBefore), [false, false, true]);
  assert.equal(seriesFor([reading(0)], "flow_l_min")[0].flagged, true);
  assert.equal(seriesFor([reading(0, { rtc_ok: false }), reading(30, { timestampUtc: null })], "ph").length, 0);
  assert.equal(findGaps([reading(0), reading(30), reading(200, { rtc_ok: false })]).length, 0);
});

test("standards and axis ticks", () => {
  assert.equal(standardFor("ph").min, 6.5);
  assert.equal(standardFor("voltage_v"), null);
  const ticks = niceTicks(6.88, 12);
  assert.ok(ticks[0] <= 6.88 && ticks[ticks.length - 1] >= 12);
  assert.ok(niceTicks(7.85, 7.85).length >= 2);
});
