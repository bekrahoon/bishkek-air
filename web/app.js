"use strict";

const DEMO = new URLSearchParams(location.search).has("demo");
const BASE = DEMO ? "demo-data/" : "data/";
const FILES = ["summary", "daily", "profile", "effect", "seasons", "forecast", "meta"];
const SVGNS = "http://www.w3.org/2000/svg";

// PM2.5 bands (µg/m³). Thresholds follow WHO 2021 and US EPA breakpoints.
const BANDS = [
  { max: 5, color: "#d5ebe0" },
  { max: 15, color: "#a3d0b4" },
  { max: 35, color: "#ead27a" },
  { max: 55, color: "#e8994f" },
  { max: 150, color: "#c9503f" },
  { max: Infinity, color: "#6b2638" },
];
const CATEGORY_COLOR = {
  "Good": "#3e9c6e",
  "Moderate": "#d9b23a",
  "Unhealthy for sensitive groups": "#e0843a",
  "Unhealthy": "#c9483b",
  "Very unhealthy": "#7e3f8f",
  "Hazardous": "#5a1f2a",
};
// ---------- language ----------
const LANGS = ["en", "ru", "ky"];
function initialLang() {
  const q = new URLSearchParams(location.search).get("lang");
  if (LANGS.includes(q)) return q;
  try {
    const saved = localStorage.getItem("lang");
    if (LANGS.includes(saved)) return saved;
  } catch (e) { /* storage unavailable */ }
  const nav = (navigator.language || "en").slice(0, 2).toLowerCase();
  return LANGS.includes(nav) ? nav : "en";
}
let lang = initialLang();
const L = () => window.I18N[lang];
function t(key, params = {}) {
  const s = L()[key] ?? window.I18N.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? ""));
}
const cat = (c) => (c ? L().cat[c] || c : "—");
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const cityName = (c) => L().city[c.city_id] || c.city_name;
const countryName = (c) => L().country[c.country] || c.country;

const pmColor = (v) => (v == null ? "#e6ebee" : BANDS.find((b) => v < b.max).color);
const fmt = (v, d = 0) => (v == null ? "—"
  : Number(v).toLocaleString(lang === "en" ? "en" : "ru", { minimumFractionDigits: d, maximumFractionDigits: d }));
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
  return L().date(d, m - 1, y, L());
}

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return t("ago_min", { n: mins });
  const h = Math.round(mins / 60);
  return h < 48 ? t("ago_h", { n: h }) : t("ago_d", { n: Math.round(h / 24) });
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
  if (push) {
    const url = new URL(location.href);
    url.hash = city.city_id;
    history.replaceState(null, "", url);
  }
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
  const smog = Math.max(0, Math.min(1, Math.log(Math.max(pm, 5) / 5) / Math.log(150 / 5)));
  $("haze").setAttribute("opacity", (smog * 0.92).toFixed(2));
  $("skyTop").setAttribute("stop-color", mix("#9cc7dd", "#c2b49b", smog));
  $("skyBottom").setAttribute("stop-color", mix("#e6f0f4", "#ddd3c2", smog));
  document.documentElement.style.setProperty("--state", CATEGORY_COLOR[c.aqi_category_now] || "#888");

  $("cityName").textContent = cityName(c);
  $("pmNow").textContent = fmt(c.pm25_now);
  const ratio = c.pm25_24h / D.meta.guidelines.who_pm25_24h;
  const daily = ratio <= 1 ? t("verdict_ok") : t("verdict_over", { x: fmt(ratio, 1) });
  $("verdict").textContent = `${t("verdict_now", { cat: cat(c.aqi_category_now) })} ${daily}`;
  const ts = c.latest_ts_local;
  $("updated").textContent = t("updated", { time: ts.slice(11, 16), date: longDate(ts), ago: ago(D.meta.generated_at) });
  document.title = `${cityName(c)} · ${fmt(c.pm25_now)} µg/m³ PM2.5`;
}

// ---------- forecast ----------
function renderForecast() {
  const list = $("forecast");
  list.replaceChildren();
  const days = D.forecast.filter((f) => f.city_id === city.city_id).slice(0, 5);
  if (!days.length) {
    el("li", { class: "empty", text: t("fc_empty") }, list);
    return;
  }
  const today = city.latest_ts_local.slice(0, 10);
  for (const f of days) {
    const li = el("li", { style: `--c:${CATEGORY_COLOR[f.aqi_category] || "#999"}` }, list);
    const d = new Date(f.date_local + "T12:00:00");
    const name = f.date_local === today ? t("today") : L().weekdays[d.getDay()];
    el("div", { class: "day", text: name }, li);
    el("div", { class: "val", text: fmt(f.pm25_avg) }, li);
    el("div", { class: "cat", text: t("fc_cat", { cat: cat(f.aqi_category) }) }, li);
  }
}

// ---------- calendar ----------
function renderLegend() {
  const lg = $("legend");
  lg.replaceChildren();
  BANDS.forEach((b, i) => {
    const s = el("span", {}, lg);
    el("i", { style: `background:${b.color}` }, s);
    s.append(t(`band_${i}`));
  });
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
    "aria-label": t("cal_aria", { city: cityName(city) }) }, wrap);

  years.forEach((y, yi) => {
    const g = el("g", { transform: `translate(0 ${yi * ROW})` }, svg);
    el("text", { x: 0, y: TOP + 3 * S + 4, class: "yr", text: y }, g);
    const jan1 = new Date(Date.UTC(+y, 0, 1));
    const offset = (jan1.getUTCDay() + 6) % 7; // Monday-first rows
    for (let m = 0; m < 12; m++) {
      const first = new Date(Date.UTC(+y, m, 1));
      const doy = Math.round((first - jan1) / 864e5);
      el("text", { x: LEFT + Math.floor((doy + offset) / 7) * S, y: 11, text: capital(L().months_short[m]) }, g);
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
          (r[3] != null ? `<br>${t("tip_temp", { t: fmt(r[3], 1) })}` : ""));
      }
    }
  });

  const c = city;
  $("calStats").innerHTML = t("cal_stats", {
    over: c.days_over_who_365d, obs: c.days_observed_365d, avg: fmt(c.pm25_365d, 1),
    x: fmt(c.times_who_annual, 1), date: longDate(c.worst_day), worst: fmt(c.worst_day_pm25),
  });
}

// ---------- hour × month profile ----------
function renderProfile() {
  const wrap = $("profile");
  wrap.replaceChildren();
  const cells = D.profile[city.city_id] || [];
  const CW = 20, CH = 22, LEFT = 34, TOP = 6, BOTTOM = 26;
  const svg = el("svg", { viewBox: `0 0 ${LEFT + 24 * CW} ${TOP + 12 * CH + BOTTOM}`, role: "img",
    "aria-label": t("profile_aria") }, wrap);
  for (const [m, h, v] of cells) {
    const rect = el("rect", { class: "cell", x: LEFT + h * CW, y: TOP + (m - 1) * CH,
      width: CW - 1.5, height: CH - 1.5, rx: 2, fill: pmColor(v) }, svg);
    bindTip(rect, `<strong>${capital(L().months[m - 1])}, ${String(h).padStart(2, "0")}:00</strong><br>${t("tip_avg", { v: fmt(v, 1) })}`);
  }
  L().months_short.forEach((mn, i) => el("text", { x: 0, y: TOP + i * CH + 15, text: capital(mn) }, svg));
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
    bindTip(rect, `<strong>${unit(bin)}</strong><br>${t("tip_avg", { v: fmt(v, 1) })}<br>${t("tip_hours", { n: fmt(n) })}`);
    el("text", { x: x + bw / 2, y: H - BOTTOM - h - 5, "text-anchor": "middle", text: fmt(v) }, svg);
    el("text", { x: x + bw / 2, y: H - BOTTOM + 15, "text-anchor": "middle", text: unit(bin, true) }, svg);
  });
  el("text", { x: LEFT, y: H - 3, text: xlabel }, svg);
}

function renderEffects() {
  const e = D.effect[city.city_id] || {};
  barChart($("effectTemp"), e.temperature, {
    unit: (b, short) => (short ? `${b}°` : t("range_temp", { a: b, b: b + 5 })),
    xlabel: t("axis_temp"),
  });
  barChart($("effectWind"), e.wind, {
    unit: (b, short) => (short ? (b >= 24 ? "24+" : `${b}`) : b >= 24 ? t("wind_max") : t("range_wind", { a: b, b: b + 3 })),
    xlabel: t("axis_wind"),
  });
}

// ---------- heating seasons ----------
function renderSeasons() {
  const wrap = $("seasons");
  wrap.replaceChildren();
  const rows = D.seasons.filter((s) => s.city_id === city.city_id);
  if (!rows.length) {
    el("p", { class: "empty", text: t("season_empty") }, wrap);
    return;
  }
  const max = Math.max(...rows.map((r) => r.pm25_avg));
  const list = el("ol", { class: "season-list" }, wrap);
  for (const r of rows) {
    const li = el("li", {}, list);
    el("span", { class: "season-name", text: r.season }, li);
    const track = el("span", { class: "season-track" }, li);
    const bar = el("span", { class: "bar", style: `width:${(100 * r.pm25_avg) / max}%;--c:${pmColor(r.pm25_avg)}` }, track);
    bindTip(bar, `<strong>${t("season_tip", { s: r.season })}</strong><br>${t("season_worst", { d: longDate(r.worst_day), v: fmt(r.worst_day_pm25) })}`);
    const val = el("span", { class: "season-val" }, li);
    el("strong", { text: `${fmt(r.pm25_avg, 1)} µg/m³` }, val);
    el("small", { text: t("season_days", { over: r.days_over_who, obs: r.days_observed }) }, val);
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
    const name = el("span", { class: "name", text: cityName(r) }, b);
    el("small", { text: countryName(r) }, name);
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
    [t("st_run"), ago(m.generated_at)],
    [t("st_rows"), fmt(m.counts.hourly_rows)],
    [t("st_span"), t("st_span_v", { a: longDate(m.counts.first_day), b: longDate(m.counts.last_day) })],
    [t("st_models"), tests.models ?? "—"],
    [t("st_tests"), tests.tests_pass != null
      ? t("st_tests_v", { p: tests.tests_pass, t: tests.tests_pass + tests.tests_warn + tests.tests_fail }) : "—", !tests.tests_fail],
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
  nav.replaceChildren();
  for (const c of D.summary) {
    const b = el("button", { type: "button", "data-city": c.city_id, text: cityName(c) }, nav);
    b.addEventListener("click", () => selectCity(c.city_id));
  }
}

// Static text in the HTML carries data-i18n (plain text) or data-i18n-html keys.
function applyStaticText() {
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-i18n]").forEach((n) => (n.textContent = t(n.dataset.i18n)));
  document.querySelectorAll("[data-i18n-html]").forEach((n) => (n.innerHTML = t(n.dataset.i18nHtml)));
  document.querySelectorAll("[data-i18n-aria]").forEach((n) => n.setAttribute("aria-label", t(n.dataset.i18nAria)));
  document.querySelectorAll("#langSwitch button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
}

function renderAll() {
  applyStaticText();
  if (!D) return;
  renderTabs();
  renderLegend();
  renderStatus();
  const [y, m] = D.meta.counts.first_day.split("-").map(Number);
  $("calTitle").textContent = t("cal_title", L().month_year(m - 1, y, L()));
  selectCity(city ? city.city_id : location.hash.slice(1) || "bishkek", { push: false });
}

function setLang(next) {
  lang = next;
  try { localStorage.setItem("lang", next); } catch (e) { /* storage unavailable */ }
  const url = new URL(location.href);
  url.searchParams.set("lang", next);
  history.replaceState(null, "", url);
  renderAll();
}

document.querySelectorAll("#langSwitch button").forEach((b) =>
  b.addEventListener("click", () => setLang(b.dataset.lang)));
applyStaticText();

load()
  .then((data) => {
    D = data;
    if (D.meta.synthetic || DEMO) $("demo-banner").hidden = false;
    renderAll();
  })
  .catch((err) => {
    console.error(err);
    document.querySelector(".now-reading").hidden = true;
    $("verdict").dataset.i18n = "empty_state";
    applyStaticText();
  });
