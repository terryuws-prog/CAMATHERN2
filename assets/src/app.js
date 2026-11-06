import { createDashboardSnapshot } from "./dashboard-model.js?v=20261106";
import { translate } from "./i18n.js?v=20261106";
import { REFRESH_INTERVAL_MS, dataSource, fetchDashboard } from "./live-data.js?v=20261106";
import { startWaterFlow } from "./water-flow.js?v=20261106";

const state = {
  language: "en",
  catchment: "all",
  view: "overview",
  officialMap: "tywi",
  source: dataSource(),
  dataStatus: "loading", // loading | ready | error
  snapshot: createDashboardSnapshot(),
};

const formatter = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });
const smallFormatter = new Intl.NumberFormat("en-GB", { maximumSignificantDigits: 2 });
const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/London",
});

const pageCopy = {
  overview: {
    en: {
      kicker: "West Wales monitoring programme",
      title: "Overview",
      lede: "Real-time telemetry and catchment health metrics for river and coastal monitoring.",
    },
    cy: {
      kicker: "Rhaglen fonitro Gorllewin Cymru",
      title: "Trosolwg",
      lede: "Telemetreg amser real a metrigau iechyd dalgylchoedd ar gyfer monitro afonydd ac arfordiroedd.",
    },
  },
  map: {
    en: {
      kicker: "Official geography",
      title: "Environmental Intelligence",
      lede: "Use the official West Wales map layer while keeping operational device locations protected in the registry.",
    },
    cy: {
      kicker: "Daearyddiaeth swyddogol",
      title: "Gweithfan map dalgylchoedd",
      lede: "Defnyddio haen fap swyddogol Gorllewin Cymru tra'n cadw lleoliadau dyfeisiau gweithredol yn y gofrestr.",
    },
  },
  sites: {
    en: {
      kicker: "Council-managed locations",
      title: "Sensor Registry",
      lede: "Register devices, access notes, telemetry type, QC state, and the manually maintained site record in one focused view.",
    },
    cy: {
      kicker: "Lleoliadau a reolir gan y cyngor",
      title: "Cofrestr synwyryddion",
      lede: "Cofrestru dyfeisiau, nodiadau mynediad, math telemetreg, statws QC a chofnod safle wedi'i gynnal â llaw.",
    },
  },
  data: {
    en: {
      kicker: "Analysis workspace",
      title: "Catchment Analysis",
      lede: "Explore environmental parameter trends across monitoring sites.",
    },
    cy: {
      kicker: "Gweithfan dadansoddi",
      title: "Arwyddion ansawdd dwr",
      lede: "Adolygu uwchlwythiadau ddwywaith y dydd, gwiriadau trothwy a hidlo QC ar gyfer amlygiad llanw cyn cyhoeddi data.",
    },
  },
};

const officialMaps = [
  {
    id: "tywi",
    label: "Carmarthen Bay and the Gower",
    labelCy: "Bae Caerfyrddin a Gwyr",
    url: "https://www.ceredigion.gov.uk/public/csr/carmarthen_bay_and_the_gower_map.html",
    catchments: ["Tywi", "Taf", "Milford Haven"],
  },
  {
    id: "cleddau",
    label: "Cleddau and Pembrokeshire Coastal Rivers",
    labelCy: "Cleddau ac Afonydd Arfordirol Sir Benfro",
    url: "https://www.ceredigion.gov.uk/public/csr/cleddau_and_pembrokeshire_coastal_rivers_map.html",
    catchments: ["Cleddau", "Milford Haven"],
  },
  {
    id: "teifi",
    label: "Teifi and North Ceredigion",
    labelCy: "Teifi a Gogledd Ceredigion",
    url: "https://www.ceredigion.gov.uk/public/csr/teifi_and_north_ceredigion_map.html",
    catchments: ["Aber Bay"],
  },
  {
    id: "nnz-lbi",
    label: "Loughor and Burry Inlet",
    labelCy: "Llwchwr a Chilfach Tywyn",
    url: "https://www.ceredigion.gov.uk/public/csr/nnz_loughor_burry_inlet_inner_outer_map.html",
    catchments: ["Milford Haven"],
  },
];

function t(key) {
  return translate(state.language, key);
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatNumber(value) {
  if (!isNumber(value)) return "—";
  return value !== 0 && Math.abs(value) < 0.1 ? smallFormatter.format(value) : formatter.format(value);
}

function formatTime(value) {
  return value ? timeFormatter.format(new Date(value)) : "—";
}

// One table row explaining why a table is empty.
function statusRow(columns) {
  const key = state.dataStatus === "loading" ? "live.loading" : state.dataStatus === "error" ? "live.error" : "live.empty";
  return `<tr class="empty-row"><td colspan="${columns}">${t(key)}</td></tr>`;
}

// Hourly averages across the given sites, oldest first.
function hourlySeries(sites, key) {
  const buckets = new Map();
  for (const site of sites) {
    for (const point of site.history ?? []) {
      if (!isNumber(point[key])) continue;
      const bucket = buckets.get(point.hour) ?? { total: 0, count: 0 };
      bucket.total += point[key];
      bucket.count += 1;
      buckets.set(point.hour, bucket);
    }
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, bucket]) => bucket.total / bucket.count);
}

function trendOf(series) {
  if (series.length < 2 || series[0] === 0) return { text: "—", dir: "stable" };
  const change = ((series[series.length - 1] - series[0]) / Math.abs(series[0])) * 100;
  const dir = Math.abs(change) < 0.5 ? "stable" : change > 0 ? "up" : "down";
  return { text: `${change > 0 ? "+" : ""}${change.toFixed(1)}%`, dir };
}

function sparkHeights(series) {
  const recent = series.slice(-6);
  if (!recent.length) return [];
  const min = Math.min(...recent);
  const max = Math.max(...recent);
  return recent.map((value) => (max === min ? 60 : 20 + ((value - min) / (max - min)) * 80));
}

function siteName(site) {
  return state.language === "cy" ? site.nameCy : site.name;
}

function localText(item, key) {
  return (state.language === "cy" ? item[`${key}Cy`] || item[key] : item[key]) || "";
}

function historyLink(site) {
  const source = state.source === "dev" ? "&source=dev" : "";
  return `./history.html?node=${encodeURIComponent(site.deviceId)}${source}`;
}

function selectedSites() {
  if (state.catchment === "all") return state.snapshot.sites;
  return state.snapshot.sites.filter((site) => site.catchment === state.catchment);
}

function activeOfficialMap() {
  return officialMaps.find((map) => map.id === state.officialMap) ?? officialMaps[0];
}

function officialMapLabel(map) {
  return state.language === "cy" ? map.labelCy : map.label;
}

function officialMapUrl() {
  const url = new URL(activeOfficialMap().url);
  url.searchParams.set("lang", state.language === "cy" ? "cy" : "en");
  return url.toString();
}

function mapSites() {
  const catchments = activeOfficialMap().catchments;
  return state.snapshot.sites.filter((site) => catchments.includes(site.catchment)).slice(0, 6);
}

function metricValue(site, key) {
  return formatNumber(site.samples[key]);
}

// Value with its unit, or just "—" when there is no value.
function metricWithUnit(site, key, unitKey) {
  const value = metricValue(site, key);
  return value === "—" ? value : `${value} <small>${t(unitKey)}</small>`;
}

// Average of the sites that have a value; null when none do.
function average(sites, key) {
  const values = sites.map((site) => site.samples[key]).filter(isNumber);
  if (!values.length) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function setLanguage(language) {
  state.language = language;
  document.documentElement.lang = language;
  document.querySelector("[data-lang-current]").textContent = language === "en" ? "CY" : "EN";
  document.querySelector("[data-lang-toggle]").setAttribute("aria-label", language === "en" ? "Switch to Welsh" : "Newid i Saesneg");
  render();
}

function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  });
}

function renderPageHeader() {
  const copy = pageCopy[state.view][state.language];
  document.querySelector("[data-page-kicker]").textContent = copy.kicker;
  document.querySelector("[data-page-title]").textContent = copy.title;
  document.querySelector("[data-page-lede]").textContent = copy.lede;
  renderSourceNote();
}

function renderSourceNote() {
  const note = document.querySelector("[data-source-note]");
  if (!note) return;

  const parts = [];
  if (state.source === "dev") parts.push(t("live.testSource"));
  if (state.dataStatus === "loading") parts.push(t("live.loading"));
  else if (state.dataStatus === "error") parts.push(t("live.error"));
  else parts.push(`${t(state.source === "dev" ? "live.updatedShort" : "live.updated")} ${formatTime(state.snapshot.generatedAt)}`);

  note.textContent = parts.join(" · ");
  note.hidden = false;
  note.classList.toggle("is-test", state.source === "dev");
  note.classList.toggle("is-error", state.dataStatus === "error");
}

function renderSummary() {
  const sites = selectedSites();
  const kpis = [
    { key: "flow", icon: "water_drop", label: t("kpi.flowRate"), unit: t("unit.flow"), glowClass: "glow-teal", sparkClass: "spark-teal" },
    { key: "ph", icon: "science", label: t("kpi.phLevel"), unit: "", glowClass: "glow-teal", sparkClass: "spark-gray" },
    { key: "dissolvedOxygen", icon: "air", label: t("kpi.dissolvedO2"), unit: t("unit.do"), glowClass: "glow-red", sparkClass: "spark-red" },
    { key: "temperature", icon: "thermostat", label: t("kpi.temperature"), unit: t("unit.temp"), glowClass: "glow-teal", sparkClass: "spark-teal" },
  ];
  const cards = kpis.map((kpi) => {
    const series = hourlySeries(sites, kpi.key);
    const trend = trendOf(series);
    return {
      ...kpi,
      value: formatNumber(average(sites, kpi.key)),
      trend: trend.text,
      trendDir: trend.dir,
      heights: sparkHeights(series),
    };
  });

  const trendIcon = { up: "arrow_upward", down: "arrow_downward", stable: "horizontal_rule" };

  document.querySelector("[data-summary]").innerHTML = cards.map((card) => `
    <article class="metric-card">
      <div class="glow ${card.glowClass}"></div>
      <div class="metric-head">
        <span class="metric-label">
          <span class="material-symbols-outlined">${card.icon}</span> ${card.label}
        </span>
        ${card.trend === "—" ? "" : `<span class="metric-trend trend-${card.trendDir}">
          <span class="material-symbols-outlined">${trendIcon[card.trendDir]}</span> ${card.trend}
        </span>`}
      </div>
      <div class="metric-value">
        <strong>${card.value}</strong>${card.unit && card.value !== "—" ? `<em>${card.unit}</em>` : ""}
      </div>
      <div class="sparkline">
        ${card.heights.map((h, i) => `<i class="${i === card.heights.length - 1 ? card.sparkClass + "-active" : card.sparkClass}" style="height:${h}%"></i>`).join("")}
      </div>
    </article>
  `).join("");
}

function renderCatchmentFilter() {
  const filter = document.querySelector("[data-catchment-filter]");
  filter.innerHTML = [
    `<option value="all">${t("filter.all")}</option>`,
    ...state.snapshot.catchments.map((catchment) => {
      const label = state.language === "cy" ? catchment.nameCy : catchment.name;
      return `<option value="${catchment.name}">${label}</option>`;
    }),
  ].join("");
  if (state.catchment !== "all" && !state.snapshot.catchments.some((catchment) => catchment.name === state.catchment)) {
    state.catchment = "all";
  }
  filter.value = state.catchment;
}

function renderQcTable() {
  const target = document.querySelector("[data-qc-table]");
  if (!target) return;

  const sites = selectedSites();
  if (!sites.length) {
    target.innerHTML = statusRow(4);
    return;
  }

  target.innerHTML = sites.slice(0, 6).map((site) => `
    <tr>
      <td>
        <strong>${site.deviceId}</strong>
        <small>${site.telemetry}</small>
      </td>
      <td>${siteName(site)}</td>
      <td>${formatTime(site.transmittedAt)}</td>
      <td>
        <span class="qc-pill ${site.qc.valid ? "valid" : "invalid"}">
          <span class="material-symbols-outlined">${site.qc.valid ? "check_circle" : "warning"}</span>
          ${site.qc.valid ? t("label.valid") : t("label.invalid")}
        </span>
      </td>
    </tr>
  `).join("");
}

function renderMapSelector() {
  const select = document.querySelector("[data-official-map-select]");
  if (!select) return;

  select.innerHTML = officialMaps.map((map) => `
    <option value="${map.id}">${officialMapLabel(map)}</option>
  `).join("");
  select.value = state.officialMap;
}

function renderOfficialMap() {
  const url = officialMapUrl();
  const frame = document.querySelector("[data-official-map]");
  const openLink = document.querySelector("[data-map-open]");
  if (!frame || !openLink) return;

  frame.setAttribute("title", t("map.frameTitle"));
  if (frame.src !== url) frame.src = url;
  openLink.href = url;
}

function renderStationDrawer() {
  const target = document.querySelector("[data-station-drawer]");
  const site = mapSites()[0] ?? state.snapshot.sites[0];
  if (!target || !site) return;

  target.innerHTML = `
    <div class="drawer-status">
      <span class="status-dot ${site.qc.valid ? "" : "invalid"}"></span>
      <strong>${site.qc.valid ? t("label.valid") : t("label.invalid")}</strong>
      <small>${site.deviceId}</small>
    </div>
    <div class="drawer-body">
      <h2>${siteName(site)}</h2>
      <p>${localText(site, "deployment")}</p>
      <div class="drawer-metrics">
        <span><b>${metricValue(site, "flow")}</b> ${t("unit.flow")}</span>
        <span><b>${metricValue(site, "ph")}</b> pH</span>
        <span><b>${metricValue(site, "dissolvedOxygen")}</b> ${t("unit.do")}</span>
      </div>
      <div class="drawer-trend">
        <span class="drawer-trend-label">${t("map.trendLabel")}</span>
        <svg preserveAspectRatio="none" viewBox="0 0 100 40">
          <path d="M0,40 L0,30 C20,30 30,20 50,25 C70,30 80,10 100,5 L100,40 Z" fill="rgba(13,148,136,0.1)" stroke="var(--secondary)" stroke-width="2" vector-effect="non-scaling-stroke"/>
        </svg>
      </div>
      <a class="drawer-detail" href="${historyLink(site)}">${t("label.details")}</a>
    </div>
  `;
}

function renderReadings() {
  const target = document.querySelector("[data-readings]");
  if (!target) return;

  const sites = selectedSites();
  if (!sites.length) {
    target.innerHTML = statusRow(9);
    return;
  }

  target.innerHTML = sites.map((site) => `
    <tr>
      <td>
        <strong>${siteName(site)}</strong>
        <small>${site.deviceId}</small>
      </td>
      <td>
        <span class="qc-pill ${site.qc.valid ? "valid" : "invalid"}">
          <span class="material-symbols-outlined">${site.qc.valid ? "check_circle" : "warning"}</span>
          ${site.qc.valid ? t("label.valid") : t("label.invalid")}
        </span>
      </td>
      <td>${metricWithUnit(site, "flow", "unit.flow")}</td>
      <td>${metricWithUnit(site, "dissolvedOxygen", "unit.do")}</td>
      <td>${metricWithUnit(site, "conductivity", "unit.ec")}</td>
      <td>${metricValue(site, "ph")}</td>
      <td>${metricWithUnit(site, "temperature", "unit.temp")}</td>
      <td>${metricWithUnit(site, "nitrate", "unit.nutrient")}</td>
      <td>${metricWithUnit(site, "ammonium", "unit.nutrient")}</td>
    </tr>
  `).join("");
}

function renderChart() {
  const target = document.querySelector("[data-chart]");
  if (!target) return;

  const sites = selectedSites().filter((site) => isNumber(site.samples.nitrate)).slice(0, 6);
  if (!sites.length) {
    target.innerHTML = `<div class="chart-empty">${state.dataStatus === "ready" ? t("live.noChartData") : t(state.dataStatus === "error" ? "live.error" : "live.loading")}</div>`;
    return;
  }
  const values = sites.map((site) => site.samples.nitrate);
  const maxValue = Math.max(state.snapshot.standards.nitrate.max, ...values);
  const points = values.map((value, index) => {
    const x = 48 + index * (448 / Math.max(values.length - 1, 1));
    const y = 248 - (value / maxValue) * 172;
    return `${x},${y}`;
  });
  const labels = sites.map((site, index) => `
    <span style="left:${8 + index * (84 / Math.max(sites.length - 1, 1))}%">${siteName(site).split(" ")[0]}</span>
  `).join("");

  target.innerHTML = `
    <div class="trend-chart">
      <svg viewBox="0 0 560 300" role="img" aria-label="Nitrate trend across selected sites">
        <defs>
          <linearGradient id="trend-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="#0d9488" stop-opacity="0.26"></stop>
            <stop offset="100%" stop-color="#0d9488" stop-opacity="0"></stop>
          </linearGradient>
        </defs>
        <g class="trend-grid">
          <path d="M48 76H520"></path>
          <path d="M48 134H520"></path>
          <path d="M48 192H520"></path>
          <path d="M48 248H520"></path>
        </g>
        <polygon points="48,248 ${points.join(" ")} 496,248" fill="url(#trend-fill)"></polygon>
        <polyline points="${points.join(" ")}" fill="none" stroke="#006a61" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></polyline>
        ${points.map((point) => `<circle cx="${point.split(",")[0]}" cy="${point.split(",")[1]}" r="8"></circle>`).join("")}
      </svg>
      <div class="trend-labels">${labels}</div>
    </div>
  `;
}

function renderSideMetrics() {
  const sites = selectedSites();
  const avgFlow = document.querySelector("[data-avg-flow]");
  const avgPh = document.querySelector("[data-avg-ph]");
  const flowTrend = document.querySelector("[data-flow-trend]");
  const phTrend = document.querySelector("[data-ph-trend]");

  if (avgFlow) avgFlow.textContent = formatNumber(average(sites, "flow"));
  if (avgPh) avgPh.textContent = formatNumber(average(sites, "ph"));
  if (flowTrend) setSideTrend(flowTrend, trendOf(hourlySeries(sites, "flow")));
  if (phTrend) setSideTrend(phTrend, trendOf(hourlySeries(sites, "ph")));
}

function setSideTrend(node, trend) {
  node.textContent = trend.text === "—" ? "—" : trend.dir === "stable" ? t("label.stable") : `${trend.text} ${t("analysis.last24h")}`;
  node.classList.remove("trend-up", "trend-down", "trend-stable");
  node.classList.add(`trend-${trend.dir === "down" ? "stable" : trend.dir}`);
}

function renderRegistry() {
  const target = document.querySelector("[data-registry]");
  const count = document.querySelector("[data-registry-count]");
  const sites = selectedSites();
  if (!target) return;

  if (count) count.textContent = `${t("sites.showing")} ${sites.length} ${t("sites.entries")}`;
  if (!sites.length) {
    target.innerHTML = statusRow(6);
    return;
  }

  target.innerHTML = sites.map((site) => `
    <tr>
      <td>
        <strong>${site.deviceId}</strong>
        <small>${formatTime(site.receivedAt)}</small>
      </td>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="material-symbols-outlined ${site.qc.valid ? "text-teal" : ""}" style="font-size:18px">${site.qc.valid ? "location_on" : "location_off"}</span>
          <div>
            <strong>${siteName(site)}</strong>
            <small>${localText(site, "access")}</small>
          </div>
        </div>
      </td>
      <td>${site.registered ? site.catchment : localText({ name: site.catchment, nameCy: "Heb ei neilltuo" }, "name")}</td>
      <td>${formatTime(site.transmittedAt)}</td>
      <td>
        <span class="qc-pill ${site.qc.valid ? "valid" : "invalid"}">
          <span class="material-symbols-outlined">${site.qc.valid ? "check_circle" : "cloud_off"}</span>
          ${site.qc.valid ? t("label.valid") : t("label.invalid")}
        </span>
      </td>
      <td><a class="row-action" href="${historyLink(site)}">${t("label.details")}</a></td>
    </tr>
  `).join("");
}

function renderStandards() {
  const target = document.querySelector("[data-standards]");
  if (!target) return;

  target.innerHTML = Object.entries(state.snapshot.standards).map(([key, standard]) => {
    const label = state.language === "cy" ? standard.labelCy : standard.label;
    const manual = key === "phosphateManual" ? `<small>${t("label.manual")}</small>` : "";
    return `
      <article class="standard-item">
        <strong>${label} ${manual}</strong>
        <span class="std-range">${standard.min} – ${standard.max} ${standard.unit}</span>
        <em class="std-framework">${standard.framework}</em>
      </article>
    `;
  }).join("");
}

function renderViewTabs() {
  document.body.dataset.currentView = state.view;

  document.querySelectorAll("[data-view-tab]").forEach((tab) => {
    const isActive = tab.dataset.viewTab === state.view;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-current", isActive ? "page" : "false");
  });

  document.querySelectorAll("[data-view]").forEach((view) => {
    view.classList.toggle("active", view.dataset.view === state.view);
  });
}

function render() {
  applyTranslations();
  renderViewTabs();
  renderPageHeader();
  renderSummary();
  renderCatchmentFilter();
  renderQcTable();
  renderMapSelector();
  renderOfficialMap();
  renderStationDrawer();
  renderReadings();
  renderChart();
  renderSideMetrics();
  renderRegistry();
  renderStandards();
}

document.querySelector("[data-lang-toggle]").addEventListener("click", () => {
  setLanguage(state.language === "en" ? "cy" : "en");
});

document.querySelectorAll("[data-view-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    state.view = tab.dataset.viewTab;
    render();
  });
});

document.querySelector("[data-catchment-filter]").addEventListener("change", (event) => {
  state.catchment = event.target.value;
  render();
});

document.querySelector("[data-official-map-select]").addEventListener("change", (event) => {
  state.officialMap = event.target.value;
  render();
});

async function loadLiveData() {
  try {
    const live = await fetchDashboard(state.source);
    state.snapshot = createDashboardSnapshot(live);
    state.dataStatus = "ready";
  } catch (error) {
    console.warn("Live data unavailable:", error);
    // Keep showing the last good data if a refresh fails.
    if (state.dataStatus !== "ready") state.dataStatus = "error";
  }
  render();
}

startWaterFlow(document.querySelector("#flow-canvas"));
render();
loadLiveData();
setInterval(loadLiveData, REFRESH_INTERVAL_MS);
