import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { translations } from "../assets/src/i18n.js";

test("public dashboard does not show internal pipeline cards", async () => {
  const html = await readFile(new URL("../assets/index.html", import.meta.url), "utf8");
  const visibleCopy = `${html}\n${JSON.stringify(translations)}`;

  assert.equal(html.includes("pipeline"), false);
  assert.equal(visibleCopy.includes("Controller plus sensors"), false);
  assert.equal(visibleCopy.includes("Device upload"), false);
  assert.equal(visibleCopy.includes("University database"), false);
  assert.equal(visibleCopy.includes("Council dashboard"), false);
  assert.equal(visibleCopy.includes("AU DB"), false);
  assert.equal(visibleCopy.includes("Kuner"), false);
});

test("dashboard uses official catchment maps instead of the local fake map", async () => {
  const html = await readFile(new URL("../assets/index.html", import.meta.url), "utf8");

  assert.match(html, /data-view="map"/);
  assert.match(html, /data-official-map/);
  assert.match(html, /carmarthen_bay_and_the_gower_map\.html/);
  assert.equal(html.includes("map-stage"), false);
  assert.equal(html.includes("map-river"), false);
});

test("dashboard is split into focused views", async () => {
  const html = await readFile(new URL("../assets/index.html", import.meta.url), "utf8");

  for (const view of ["overview", "map", "sites", "data"]) {
    assert.match(html, new RegExp(`data-view="${view}"`));
  }
});

test("partner logos include Carmarthenshire without social media strip", async () => {
  const html = await readFile(new URL("../assets/index.html", import.meta.url), "utf8");
  const logo = await readFile(new URL("../assets/carmarthenshire-official-header-logo.png", import.meta.url));
  const visibleCopy = html.toLowerCase();
  const width = logo.readUInt32BE(16);
  const height = logo.readUInt32BE(20);

  assert.match(html, /src="\.\/carmarthenshire-official-header-logo\.png"/);
  assert.match(html, /alt="Carmarthenshire County Council"/);
  assert.equal(html.includes("council-logo-frame"), false);
  assert.ok(logo.length > 1000);
  assert.equal(width, 320);
  assert.equal(height, 96);
  assert.equal(visibleCopy.includes("facebook"), false);
  assert.equal(visibleCopy.includes("twitter"), false);
  assert.equal(visibleCopy.includes("linkedin"), false);
});

test("dashboard adopts the environmental intelligence shell", async () => {
  const html = await readFile(new URL("../assets/index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../assets/src/styles.css", import.meta.url), "utf8");

  assert.match(html, /class="app-shell"/);
  assert.match(html, /class="side-nav"/);
  assert.match(html, /class="top-nav"/);
  assert.match(html, /class="page-header"/);
  assert.match(html, /src="\.\/carmarthenshire-official-header-logo\.png"/);
  assert.match(html, /src="\.\/aberystwyth-logo\.svg"/);
  assert.equal(html.includes("dashboard-head"), false);
  assert.match(css, /--primary-container:\s*#0f172a/);
  assert.match(css, /--secondary:\s*#0d9488/);
  assert.match(css, /grid-template-columns:\s*280px minmax\(0,\s*1fr\)/);
  assert.match(css, /backdrop-filter:\s*blur\(24px\)/);
});

test("dashboard assembles the full page system", async () => {
  const html = await readFile(new URL("../assets/index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../assets/src/styles.css", import.meta.url), "utf8");

  for (const className of [
    "overview-metrics",
    "recent-qc-panel",
    "quick-actions-panel",
    "map-workbench",
    "map-layers",
    "station-drawer",
    "sensor-registry",
    "registry-toolbar",
    "analysis-workspace",
    "filter-bar",
    "parameter-trends",
    "data-quality-panel",
  ]) {
    assert.match(html, new RegExp(`class="[^"]*${className}`));
  }

  for (const attr of ["data-qc-table", "data-registry", "data-page-title", "data-page-lede"]) {
    assert.match(html, new RegExp(attr));
  }

  assert.match(html, /Register Device/);
  assert.match(html, /Export Report/);
  assert.match(html, /Map Layers/);
  assert.match(css, /\.map-workbench/);
  assert.match(css, /\.station-drawer/);
  assert.match(css, /\.sensor-registry/);
});
