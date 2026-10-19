"use strict";

const DEMO = new URLSearchParams(location.search).has("demo");
const BASE = DEMO ? "demo-data/" : "data/";
const FILES = ["summary", "daily", "profile", "effect", "seasons", "forecast", "meta"];
const SVGNS = "http://www.w3.org/2000/svg";

// PM2.5 bands (µg/m³). Thresholds follow WHO 2021 and US EPA breakpoints.
const BANDS = [
  { max: 5, color: "#d5ebe0", label: "Under 5: clean" },
  { max: 15, color: "#a3d0b4", label: "5–15: within WHO daily limit" },
  { max: 35, color: "#ead27a", label: "15–35: above WHO limit" },
  { max: 55, color: "#e8994f", label: "35–55: unhealthy for sensitive groups" },
  { max: 150, color: "#c9503f", label: "55–150: unhealthy" },
  { max: Infinity, color: "#6b2638", label: "Over 150: very unhealthy" },
];
const CATEGORY_COLOR = {
  "Good": "#3e9c6e",
  "Moderate": "#d9b23a",
  "Unhealthy for sensitive groups": "#e0843a",
  "Unhealthy": "#c9483b",
  "Very unhealthy": "#7e3f8f",
  "Hazardous": "#5a1f2a",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const pmColor = (v) => (v == null ? "#e6ebee" : BANDS.find((b) => v < b.max).color);
const fmt = (v, d = 0) => (v == null ? "—" : Number(v).toFixed(d));
const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, parent) {
  const isSvg = ["svg", "rect", "text", "g", "line", "path"].includes(tag);
  const node = isSvg ? document.createElementNS(SVGNS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else if (k === "style") node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  if (parent) parent.appendChild(node);
  return node;
}

function longDate(iso) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS_LONG[m - 1]} ${y}`;
}

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

// ---------- tooltip ----------
const tip = $("tip");
function bindTip(node, html) {
  node.addEventListener("mousemove", (e) => {
    tip.innerHTML = html;
    tip.hidden = false;
    const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${x}px`;
    tip.style.top = `${e.clientY + 14}px`;
  });
  node.addEventListener("mouseleave", () => (tip.hidden = true));
}

// ---------- state ----------
let D = null;
let city = null;

async function load() {
  const entries = await Promise.all(
    FILES.map(async (f) => {
      const r = await fetch(`${BASE}${f}.json`, { cache: "no-cache" });
      if (!r.ok) throw new Error(`${f}.json: HTTP ${r.status}`);
      return [f, await r.json()];
    })
  );
  return Object.fromEntries(entries);
}

function selectCity(id, { push = true } = {}) {
  city = D.summary.find((c) => c.city_id === id) || D.summary[0];
  if (push) history.replaceState(null, "", `${location.search}#${city.city_id}`);
  document.querySelectorAll("#cityTabs button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.city === city.city_id))
  );
  renderHero();
  renderForecast();
  renderCalendar();
  renderProfile();
  renderEffects();
  renderSeasons();
  renderRanking();
}

// ---------- hero ----------
function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

function renderHero() {
  const c = city;
  const pm = c.pm25_24h ?? c.pm25_now;
  const t = Math.max(0, Math.min(1, Math.log(Math.max(pm, 5) / 5) / Math.log(150 / 5)));
  $("haze").setAttribute("opacity", (t * 0.92).toFixed(2));
  $("skyTop").setAttribute("stop-color", mix("#9cc7dd", "#c2b49b", t));
  $("skyBottom").setAttribute("stop-color", mix("#e6f0f4", "#ddd3c2", t));
  document.documentElement.style.setProperty("--state", CATEGORY_COLOR[c.aqi_category_now] || "#888");

  $("cityName").textContent = c.city_name;
  $("pmNow").textContent = fmt(c.pm25_now);
  const ratio = c.pm25_24h / D.meta.guidelines.who_pm25_24h;
  const daily = ratio <= 1
    ? "Over the last 24 hours the air stayed within the WHO daily limit."
    : `Over the last 24 hours the air averaged ${ratio.toFixed(1)}× the WHO daily limit.`;
  $("verdict").textContent = `${c.aqi_category_now} right now. ${daily}`;
  const ts = c.latest_ts_local;
  $("updated").textContent =
    `Latest hour ${ts.slice(11, 16)}, ${longDate(ts)}, local time · refreshed ${ago(D.meta.generated_at)}`;
  document.title = `${c.city_name} Air · ${fmt(c.pm25_now)} µg/m³`;
}

// ---------- forecast ----------
function renderForecast() {
  const list = $("forecast");
  list.replaceChildren();
  const days = D.forecast.filter((f) => f.city_id === city.city_id).slice(0, 5);
  if (!days.length) {
    el("li", { class: "empty", text: "No forecast in the latest run." }, list);
    return;
  }
  const today = city.latest_ts_local.slice(0, 10);
  for (const f of days) {
    const li = el("li", { style: `--c:${CATEGORY_COLOR[f.aqi_category] || "#999"}` }, list);
    const d = new Date(f.date_local + "T12:00:00");
    const name = f.date_local === today ? "Today"
      : d.toLocaleDateString("en-GB", { weekday: "long" });
    el("div", { class: "day", text: name }, li);
    el("div", { class: "val", text: fmt(f.pm25_avg) }, li);
    el("div", { class: "cat", text: `µg/m³ avg · ${f.aqi_category}` }, li);
  }
}

// ---------- calendar ----------
function renderLegend() {
  const lg = $("legend");
  lg.replaceChildren();
  for (const b of BANDS) {
    const s = el("span", {}, lg);
    el("i", { style: `background:${b.color}` }, s);
    s.append(b.label);
  }
}

function renderCalendar() {
  const wrap = $("calendar");
  wrap.replaceChildren();
  const rows = D.daily[city.city_id] || [];
  if (!rows.length) return;
  const byDate = new Map(rows.map((r) => [r[0], r]));
  const years = [...new Set(rows.map((r) => r[0].slice(0, 4)))].sort().reverse();
  const S = 13, G = 2, LEFT = 46, TOP = 18, ROW = 7 * S + TOP + 14;
  const W = LEFT + 54 * S;
  const svg = el("svg", { viewBox: `0 0 ${W} ${years.length * ROW}`, role: "img",
    "aria-label": `Daily PM2.5 calendar for ${city.city_name}` }, wrap);

  years.forEach((y, yi) => {
    const g = el("g", { transform: `translate(0 ${yi * ROW})` }, svg);
    el("text", { x: 0, y: TOP + 3 * S + 4, class: "yr", text: y }, g);
    const jan1 = new Date(Date.UTC(+y, 0, 1));
    const offset = (jan1.getUTCDay() + 6) % 7; // Monday-first rows
    for (let m = 0; m < 12; m++) {
      const first = new Date(Date.UTC(+y, m, 1));
      const doy = Math.round((first - jan1) / 864e5);
      el("text", { x: LEFT + Math.floor((doy + offset) / 7) * S, y: 11, text: MONTHS[m] }, g);
    }
    for (let d = new Date(jan1); d.getUTCFullYear() === +y; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      const doy = Math.round((d - jan1) / 864e5);
      const col = Math.floor((doy + offset) / 7);
      const row = (d.getUTCDay() + 6) % 7;
      const r = byDate.get(iso);
      const rect = el("rect", {
        class: "cell", x: LEFT + col * S, y: TOP + row * S, width: S - G, height: S - G, rx: 2,
        fill: r ? pmColor(r[1]) : "#eef1f3",
      }, g);
      if (r) {
        bindTip(rect, `<strong>${longDate(iso)}</strong><br>PM2.5 ${fmt(r[1], 1)} µg/m³` +
          (r[3] != null ? `<br>${fmt(r[3], 1)} °C average` : ""));
      }
    }
  });

  const c = city;
  $("calStats").innerHTML =
    `In the last 12 months <strong>${c.days_over_who_365d} of ${c.days_observed_365d} days</strong> ` +
    `were above the WHO daily limit. The yearly average was <strong>${fmt(c.pm25_365d, 1)} µg/m³</strong>, ` +
    `${fmt(c.times_who_annual, 1)}× the WHO annual guideline. ` +
    `Worst day on record: <strong>${longDate(c.worst_day)}</strong>, ${fmt(c.worst_day_pm25)} µg/m³.`;
}

// ---------- hour × month profile ----------
function renderProfile() {
  const wrap = $("profile");
  wrap.replaceChildren();
  const cells = D.profile[city.city_id] || [];
  const CW = 20, CH = 22, LEFT = 34, TOP = 6, BOTTOM = 26;
  const svg = el("svg", { viewBox: `0 0 ${LEFT + 24 * CW} ${TOP + 12 * CH + BOTTOM}`, role: "img",
    "aria-label": "Average PM2.5 by month and hour" }, wrap);
  for (const [m, h, v] of cells) {
    const rect = el("rect", { class: "cell", x: LEFT + h * CW, y: TOP + (m - 1) * CH,
      width: CW - 1.5, height: CH - 1.5, rx: 2, fill: pmColor(v) }, svg);
    bindTip(rect, `<strong>${MONTHS_LONG[m - 1]}, ${String(h).padStart(2, "0")}:00</strong><br>${fmt(v, 1)} µg/m³ on average`);
  }
  MONTHS.forEach((mn, i) => el("text", { x: 0, y: TOP + i * CH + 15, text: mn }, svg));
  for (let h = 0; h < 24; h += 3) {
    el("text", { x: LEFT + h * CW + 2, y: TOP + 12 * CH + 16, text: `${String(h).padStart(2, "0")}:00` }, svg);
  }
}

// ---------- weather effect ----------
function barChart(wrap, data, { unit, xlabel }) {
  wrap.replaceChildren();
  if (!data || !data.length) return;
  const W = 520, H = 170, LEFT = 30, BOTTOM = 34, TOP = 18;
  const max = Math.max(...data.map((d) => d[1]));
  const bw = (W - LEFT) / data.length;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": xlabel }, wrap);
  data.forEach(([bin, v, n], i) => {
    const h = ((H - BOTTOM - TOP) * v) / max;
    const x = LEFT + i * bw;
    const rect = el("rect", { x: x + 3, y: H - BOTTOM - h, width: bw - 6, height: h, rx: 3, fill: pmColor(v) }, svg);
    bindTip(rect, `<strong>${unit(bin)}</strong><br>${fmt(v, 1)} µg/m³ average<br>${n.toLocaleString("en")} hours`);
    el("text", { x: x + bw / 2, y: H - BOTTOM - h - 5, "text-anchor": "middle", text: fmt(v) }, svg);
    el("text", { x: x + bw / 2, y: H - BOTTOM + 15, "text-anchor": "middle", text: unit(bin, true) }, svg);
  });
  el("text", { x: LEFT, y: H - 3, text: xlabel }, svg);
}

function renderEffects() {
  const e = D.effect[city.city_id] || {};
  barChart($("effectTemp"), e.temperature, {
    unit: (b, short) => (short ? `${b}°` : `${b} to ${b + 5} °C`),
    xlabel: "Outdoor temperature, °C",
  });
  barChart($("effectWind"), e.wind, {
    unit: (b, short) => (short ? (b >= 24 ? "24+" : `${b}`) : b >= 24 ? "24+ km/h" : `${b} to ${b + 3} km/h`),
    xlabel: "Wind speed, km/h",
  });
}

// ---------- heating seasons ----------
function renderSeasons() {
  const wrap = $("seasons");
  wrap.replaceChildren();
  const rows = D.seasons.filter((s) => s.city_id === city.city_id);
  if (!rows.length) {
    el("p", { class: "empty", text: "Not enough winter data yet." }, wrap);
    return;
  }
  const max = Math.max(...rows.map((r) => r.pm25_avg));
  const list = el("ol", { class: "season-list" }, wrap);
  for (const r of rows) {
    const li = el("li", {}, list);
    el("span", { class: "season-name", text: r.season }, li);
    const track = el("span", { class: "season-track" }, li);
    const bar = el("span", { class: "bar", style: `width:${(100 * r.pm25_avg) / max}%;--c:${pmColor(r.pm25_avg)}` }, track);
    bindTip(bar, `<strong>Winter ${r.season}</strong><br>Worst day ${longDate(r.worst_day)}: ${fmt(r.worst_day_pm25)} µg/m³`);
    const val = el("span", { class: "season-val" }, li);
    el("strong", { text: `${fmt(r.pm25_avg, 1)} µg/m³` }, val);
    el("small", { text: `${r.days_over_who} of ${r.days_observed} days over the limit` }, val);
  }
}

// ---------- ranking ----------
function renderRanking() {
  const list = $("ranking");
  list.replaceChildren();
  const rows = [...D.summary].sort((a, b) => b.pm25_30d - a.pm25_30d);
  const max = Math.max(...rows.map((r) => r.pm25_30d));
  for (const r of rows) {
    const li = el("li", {}, list);
    const b = el("button", { type: "button", "data-city": r.city_id,
      "aria-current": String(r.city_id === city.city_id) }, li);
    const name = el("span", { class: "name", text: r.city_name }, b);
    el("small", { text: r.country }, name);
    const track = el("span", {}, b);
    el("span", { class: "bar", style: `width:${(100 * r.pm25_30d) / max}%;--c:${pmColor(r.pm25_30d)}` }, track);
    el("span", { class: "num", text: `${fmt(r.pm25_30d, 1)} µg/m³` }, b);
    b.addEventListener("click", () => {
      selectCity(r.city_id);
      $("hero").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    });
  }
}

// ---------- pipeline status ----------
function renderStatus() {
  const m = D.meta;
  const dl = $("status");
  dl.replaceChildren();
  const tests = m.dbt || {};
  const items = [
    ["Last pipeline run", ago(m.generated_at)],
    ["Hourly rows in the warehouse", m.counts.hourly_rows.toLocaleString("en")],
    ["History covered", `${longDate(m.counts.first_day)} to ${longDate(m.counts.last_day)}`],
    ["dbt models built", tests.models ?? "—"],
    ["Data tests passed", tests.tests_pass != null ? `${tests.tests_pass} of ${tests.tests_pass + tests.tests_warn + tests.tests_fail}` : "—", !tests.tests_fail],
  ];
  for (const [k, v, ok] of items) {
    const d = el("div", {}, dl);
    el("dt", { text: k }, d);
    el("dd", { text: v, class: ok ? "ok" : "" }, d);
  }
}

// ---------- boot ----------
function renderTabs() {
  const nav = $("cityTabs");
  for (const c of D.summary) {
    const b = el("button", { type: "button", "data-city": c.city_id, text: c.city_name }, nav);
    b.addEventListener("click", () => selectCity(c.city_id));
  }
}

load()
  .then((data) => {
    D = data;
    if (D.meta.synthetic || DEMO) $("demo-banner").hidden = false;
    renderTabs();
    renderLegend();
    renderStatus();
    $("calTitle").textContent = `Every day since ${longDate(D.meta.counts.first_day).replace(/^\d+ /, "")}`;
    selectCity(location.hash.slice(1) || "bishkek", { push: false });
  })
  .catch((err) => {
    console.error(err);
    document.querySelector(".now-reading").hidden = true;
    $("verdict").textContent =
      "The pipeline is collecting its first data. It publishes the results automatically — check back in a few minutes.";
  });
