import {
  PARAMETERS,
  failingFlags,
  historyUrl,
  isNumber,
  niceTicks,
  parameterFor,
  readState,
  seriesFor,
  standardFor,
  stateToSearch,
  summarize,
  uploadDelayMinutes,
} from "./history-model.js?v=20261106";

const REFRESH_MS = 5 * 60 * 1000;
const PAGE_SIZE = 100;

const state = { ...readState(location.search), shown: PAGE_SIZE };
let data = null;
let loadError = null;

const $ = (selector) => document.querySelector(selector);
const numberFormat = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 3 });
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London",
});
const clockFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const fmt = (value) => (isNumber(value) ? numberFormat.format(value) : "—");
const fmtTime = (iso) => (iso ? timeFormat.format(new Date(iso)) : "—");

function fmtDuration(minutes) {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

function fmtAgo(iso) {
  if (!iso) return "—";
  const minutes = (Date.now() - Date.parse(iso)) / 60000;
  if (minutes < 1) return "just now";
  return `${fmtDuration(minutes)} ago`;
}

// ---------- loading ----------

async function load() {
  try {
    const response = await fetch(historyUrl(state), { headers: { Accept: "application/json" }, cache: "no-store" });
    if (response.status === 404 && state.node) {
      state.node = null; // node not found: fall back to the first node with data
      return load();
    }
    if (!response.ok) throw new Error(`History API returned ${response.status}`);
    data = await response.json();
    state.node = data.nodeId;
    loadError = null;
  } catch (error) {
    console.warn("History unavailable:", error);
    loadError = error;
  }
  history.replaceState(null, "", stateToSearch(state));
  render();
}

// ---------- rendering ----------

function render() {
  renderHeader();
  renderControls();
  renderSummary();
  renderParams();
  renderChart();
  renderReadings();
  renderUploads();
}

function renderHeader() {
  $("[data-test-badge]").hidden = state.source !== "dev";
  $("[data-back]").href = state.source === "dev" ? "./?source=dev" : "./";
  const status = $("[data-status]");
  status.classList.toggle("error", Boolean(loadError));
  status.textContent = loadError ? "Couldn't load data. Try again shortly." : data ? `Updated ${clockFormat.format(new Date(data.generatedAt))}` : "Loading…";
}

function renderControls() {
  const select = $("[data-node]");
  const nodes = data?.nodes ?? [];
  select.innerHTML = nodes.length
    ? nodes.map((n) => `<option value="${escapeHtml(n.deviceId)}">${escapeHtml(n.deviceId)}${n.name ? ` · ${escapeHtml(n.name)}` : ""}</option>`).join("")
    : `<option value="">No nodes with data yet</option>`;
  select.value = state.node ?? "";
  $("[data-range]").value = state.hours == null ? "all" : String(state.hours);
  const csv = $("[data-csv]");
  csv.href = historyUrl(state, "csv");
  csv.toggleAttribute("hidden", !state.node);
  $("[data-updated]").textContent = data?.truncated ? "Showing the newest 5000 readings. Pick a shorter range to see older ones." : "";
}

function stat(label, value, note = "", warn = false) {
  return `<div class="stat${warn ? " warn" : ""}"><span>${label}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ""}</div>`;
}

function renderSummary() {
  const target = $("[data-summary]");
  if (!data || !state.node) {
    target.innerHTML = "";
    return;
  }
  const s = summarize(data.readings);
  target.innerHTML = [
    stat("Readings", fmt(s.count), data.truncated ? "newest 5000 shown" : "in this range"),
    stat("Last upload", fmtAgo(s.lastReceived), fmtTime(s.lastReceived)),
    stat("Gaps over 35 min", fmt(s.gaps), s.gaps ? `longest ${fmtDuration(s.longestGapMinutes)}` : "readings are continuous", s.gaps > 0),
    stat("Flagged readings", fmt(s.flagged), "a sensor or RTC flag is off", s.flagged > 0),
    stat("Latest voltage", isNumber(s.latestVoltage) ? `${fmt(s.latestVoltage)} V` : "—"),
  ].join("");
}

function renderParams() {
  $("[data-params]").innerHTML = PARAMETERS.map((p) =>
    `<button type="button" data-param="${p.key}" aria-pressed="${p.key === state.param}">${p.label}</button>`).join("");
}

// SVG time chart for the selected parameter.
const W = 900;
const H = 300;
const M = { top: 14, right: 18, bottom: 30, left: 56 };

function renderChart() {
  const target = $("[data-chart]");
  const param = parameterFor(state.param);
  const points = data && state.node ? seriesFor(data.readings, state.param) : [];
  if (!points.length) {
    const message = loadError ? "Couldn't load data." : !data ? "Loading…" : `No ${param.label.toLowerCase()} readings in this range.`;
    target.innerHTML = `<div class="empty">${message}</div>`;
    return;
  }

  const standard = standardFor(state.param);
  const values = points.map((p) => p.value);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (standard) {
    lo = Math.min(lo, standard.min);
    hi = Math.max(hi, standard.max);
  }
  const ticks = niceTicks(lo, hi);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  let tMin = points[0].time;
  let tMax = points[points.length - 1].time;
  if (tMin === tMax) {
    tMin -= 30 * 60000;
    tMax += 30 * 60000;
  }
  const x = (t) => M.left + ((t - tMin) / (tMax - tMin)) * (W - M.left - M.right);
  const y = (v) => H - M.bottom - ((v - yMin) / (yMax - yMin || 1)) * (H - M.top - M.bottom);

  const spanHours = (tMax - tMin) / 3600000;
  const xTicks = Array.from({ length: 6 }, (_, i) => tMin + ((tMax - tMin) * i) / 5);
  const xLabel = (t) => (spanHours <= 36 ? clockFormat.format(new Date(t)) : dayFormat.format(new Date(t)));

  let path = "";
  points.forEach((p, i) => {
    path += `${i === 0 || p.breakBefore ? "M" : "L"}${x(p.time).toFixed(1)},${y(p.value).toFixed(1)} `;
  });
  const showAllDots = points.length <= 400;
  const dots = points
    .filter((p) => showAllDots || p.flagged)
    .map((p) => `<circle class="dot${p.flagged ? " flagged" : ""}" cx="${x(p.time).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="${p.flagged ? 4 : 3}"></circle>`)
    .join("");

  let band = "";
  if (standard) {
    const top = y(Math.min(standard.max, yMax));
    const bottom = y(Math.max(standard.min, yMin));
    band = `<rect class="band" x="${M.left}" y="${top}" width="${W - M.left - M.right}" height="${Math.max(bottom - top, 0)}"></rect>
      <text class="band-label" x="${M.left + 6}" y="${top + 13}">Standard ${standard.min}–${standard.max} ${escapeHtml(standard.unit)}</text>`;
  }

  target.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${param.label} over time">
      ${band}
      <g class="grid">${ticks.map((v) => `<line x1="${M.left}" x2="${W - M.right}" y1="${y(v)}" y2="${y(v)}"></line>`).join("")}</g>
      <g class="axis">
        ${ticks.map((v) => `<text x="${M.left - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join("")}
        ${xTicks.map((t, i) => `<text x="${x(t)}" y="${H - 8}" text-anchor="${i === 0 ? "start" : i === 5 ? "end" : "middle"}">${xLabel(t)}</text>`).join("")}
        <text x="12" y="${M.top + 4}" transform="rotate(-90 12 ${M.top + 4})" text-anchor="end">${escapeHtml(param.unit || param.label)}</text>
      </g>
      <path class="line" d="${path}"></path>
      ${dots}
      <line class="cursor" data-cursor y1="${M.top}" y2="${H - M.bottom}" x1="-10" x2="-10"></line>
      <rect data-hover x="${M.left}" y="${M.top}" width="${W - M.left - M.right}" height="${H - M.top - M.bottom}" fill="transparent"></rect>
    </svg>
    <div class="tooltip" data-tip hidden></div>`;

  const svg = target.querySelector("svg");
  const tip = target.querySelector("[data-tip]");
  const cursor = target.querySelector("[data-cursor]");
  const hover = target.querySelector("[data-hover]");
  const move = (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    const t = tMin + ((px - M.left) / (W - M.left - M.right)) * (tMax - tMin);
    let best = points[0];
    for (const p of points) if (Math.abs(p.time - t) < Math.abs(best.time - t)) best = p;
    const cx = x(best.time);
    cursor.setAttribute("x1", cx);
    cursor.setAttribute("x2", cx);
    tip.hidden = false;
    tip.style.left = `${(cx / W) * box.width}px`;
    tip.style.top = `${(y(best.value) / H) * box.height}px`;
    tip.textContent = `${fmtTime(best.observedAt)} · ${fmt(best.value)}${param.unit ? ` ${param.unit}` : ""}${best.flagged ? " · flag off" : ""}`;
  };
  hover.addEventListener("mousemove", move);
  hover.addEventListener("mouseleave", () => {
    tip.hidden = true;
    cursor.setAttribute("x1", -10);
    cursor.setAttribute("x2", -10);
  });
}

function valueCell(reading, key, flag) {
  const off = flag && reading[flag] === false;
  return `<td class="num${off ? " off" : ""}"${off ? ' title="Sensor flag off"' : ""}>${fmt(reading[key])}</td>`;
}

function statusRow(columns, message) {
  return `<tr><td class="empty" colspan="${columns}">${message}</td></tr>`;
}

function renderReadings() {
  const target = $("[data-readings]");
  const more = $("[data-more]");
  more.hidden = true;
  if (loadError) return void (target.innerHTML = statusRow(12, "Couldn't load data."));
  if (!data) return void (target.innerHTML = statusRow(12, "Loading…"));
  if (!data.readings.length) return void (target.innerHTML = statusRow(12, "No readings in this range."));

  const rows = data.readings.slice(0, state.shown);
  target.innerHTML = rows.map((r) => {
    const flags = failingFlags(r);
    const delay = uploadDelayMinutes(r);
    const timeNote = r.timestampUtc && r.rtc_ok !== false ? "" : "<small>arrival time</small>";
    return `<tr>
      <td>${fmtTime(r.observedAt)}${timeNote}</td>
      <td class="num">${fmt(r.boot_count)} / ${fmt(r.sample_seq)}</td>
      ${valueCell(r, "ph", "ph_ok")}
      ${valueCell(r, "temp_c", "temp_ok")}
      ${valueCell(r, "ec_us_cm", "ec_ok")}
      ${valueCell(r, "do_mg_l", "do_ok")}
      ${valueCell(r, "nh4_reported_mg_l", "nh4_ok")}
      ${valueCell(r, "no3_reported_mg_l", "no3_ok")}
      ${valueCell(r, "depth_m")}
      ${valueCell(r, "voltage_v")}
      <td>${flags.length ? `<span class="bad">${flags.join(", ")} off</span>` : '<span class="ok">All OK</span>'}${r.test_mode ? '<span class="tag">test</span>' : ""}</td>
      <td>${fmtTime(r.receivedAt)}${delay != null && delay >= 1 ? `<small>+${fmtDuration(delay)}</small>` : ""}<small>batch ${fmt(r.batch_id)}</small></td>
    </tr>`;
  }).join("");
  $("[data-readings-note]").textContent = `Newest first. Showing ${fmt(rows.length)} of ${fmt(data.readings.length)}.`;
  more.hidden = data.readings.length <= state.shown;
}

function renderUploads() {
  const target = $("[data-uploads]");
  if (loadError) return void (target.innerHTML = statusRow(6, "Couldn't load data."));
  if (!data) return void (target.innerHTML = statusRow(6, "Loading…"));
  if (!data.uploads.length) return void (target.innerHTML = statusRow(6, "No uploads in this range."));
  target.innerHTML = data.uploads.map((u) => `<tr>
    <td>${fmtTime(u.receivedAt)}</td>
    <td class="num">${fmt(u.batchId)}</td>
    <td class="num">${fmt(u.records)}</td>
    <td class="num">${fmt(u.inserted)}</td>
    <td class="num">${fmt(u.duplicates)}</td>
    <td class="num${u.rejected ? " bad" : ""}">${fmt(u.rejected)}</td>
  </tr>`).join("");
}

// ---------- events ----------

$("[data-node]").addEventListener("change", (event) => {
  state.node = event.target.value || null;
  state.shown = PAGE_SIZE;
  load();
});

$("[data-range]").addEventListener("change", (event) => {
  state.hours = event.target.value === "all" ? null : Number(event.target.value);
  state.shown = PAGE_SIZE;
  load();
});

$("[data-params]").addEventListener("click", (event) => {
  const button = event.target.closest("[data-param]");
  if (!button) return;
  state.param = button.dataset.param;
  history.replaceState(null, "", stateToSearch(state));
  renderParams();
  renderChart();
});

$("[data-more]").addEventListener("click", () => {
  state.shown += PAGE_SIZE;
  renderReadings();
});

render();
load();
setInterval(load, REFRESH_MS);
