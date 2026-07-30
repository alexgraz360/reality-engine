// Reality Engine · Navigator — drop a pin, find your way back.
//
// A POINTER, NOT A MAPS APP. It gives a straight-line direction and distance to
// a saved pin. It does not route around buildings, water, fences or one-way
// streets, and it deliberately has NO map tiles or basemap — those need a
// network map provider, which would break the $0/local rule. The little canvas
// here is a blank relative field drawn locally, nothing fetched.
//
// ZERO NETWORK. Nothing in this mode calls out: no tiles, no geocoding, no
// elevation lookup, no reverse-geocode of a pin. Everything is arithmetic on
// coordinates the device already gave us.
//
// HEADING — reusing what Astronomy already learned rather than re-solving it:
//   • iOS gives a TRUE compass heading via `webkitCompassHeading` (0 = north,
//     clockwise), with `webkitCompassAccuracy` in degrees (negative = invalid).
//   • Everywhere else you usually get `alpha`, which is only a true heading when
//     `event.absolute` is set; otherwise it's RELATIVE to wherever the page
//     happened to start, and pointing an arrow with it would be confidently wrong.
// So: a trustworthy heading turns the arrow on; an untrustworthy one turns it
// OFF and we fall back to words ("north-east, 120 m") plus the reason.

import { manualPanelHTML, wireManualPanel, voiceFirstHint } from "../services/manualPanel.js";

const R_EARTH_M = 6371008.8;          // IUGG mean Earth radius
const MAX_PINS = 50;
const STALE_FIX_MS = 60_000;          // a fix older than this stops being "live"
const BAD_ACCURACY_M = 50;            // beyond this we say the fix is poor
const COMPASS_BAD_DEG = 25;           // iOS accuracy worse than this = untrustworthy

let root, svc, store, els = {};
let pins = [];
let selectedId = null;
let pos = null;                       // { lat, lon, accuracy, ts }
let heading = null;                   // degrees true, or null
let headingSource = "none";           // "ios-true" | "absolute-alpha" | "relative-alpha" | "none"
let headingAccuracy = null;           // degrees, iOS only
let offPos = null, offOri = null;
let tracking = false;
let posError = "";
let tickId = 0;

// ---------------------------------------------------------------- geo maths
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

// Great-circle initial bearing, degrees clockwise from true north.
function bearingTo(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2), Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Haversine great-circle distance in metres.
function distanceM(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1), Δλ = toRad(lon2 - lon1);
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

const COMPASS_16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
function compassPoint(deg) { return COMPASS_16[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]; }
function compassWords(deg) {
  return { N: "north", NNE: "north-north-east", NE: "north-east", ENE: "east-north-east",
    E: "east", ESE: "east-south-east", SE: "south-east", SSE: "south-south-east",
    S: "south", SSW: "south-south-west", SW: "south-west", WSW: "west-south-west",
    W: "west", WNW: "west-north-west", NW: "north-west", NNW: "north-north-west" }[compassPoint(deg)];
}

// Relative direction in plain words — what you say when the arrow can't be shown,
// and what rides on the glance card (which is text-only by contract).
function relativeWords(rel) {
  const r = ((rel % 360) + 360) % 360;
  if (r < 15 || r >= 345) return "straight ahead";
  if (r < 60) return "ahead-right";
  if (r < 120) return "to your right";
  if (r < 165) return "behind-right";
  if (r < 195) return "behind you";
  if (r < 240) return "behind-left";
  if (r < 300) return "to your left";
  return "ahead-left";
}

// Rounded honestly — no false precision. A GPS fix good to ±10 m has no business
// printing "127.4 m".
function fmtDistance(m) {
  if (!isFinite(m)) return "—";
  if (m < 10) return `${m.toFixed(1)} m`;
  if (m < 1000) return `${Math.round(m / 5) * 5} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}
function fmtAccuracy(a) { return a == null ? "unknown" : `±${Math.round(a)} m`; }

// ---------------------------------------------------------------- heading
// Trustworthy only when it's a real compass heading. A relative alpha would
// point the arrow confidently in the wrong direction, which is worse than
// showing no arrow at all.
function headingTrustworthy() {
  if (heading == null) return false;
  if (headingSource === "ios-true") {
    return headingAccuracy == null || (headingAccuracy >= 0 && headingAccuracy <= COMPASS_BAD_DEG);
  }
  return headingSource === "absolute-alpha";
}
function headingProblem() {
  if (headingSource === "none" || heading == null) {
    return "No compass reading from this device yet — showing the direction in words instead.";
  }
  if (headingSource === "relative-alpha") {
    return "This browser only reports a relative orientation, not a true compass heading, " +
      "so an arrow would point the wrong way. Showing the direction in words instead.";
  }
  if (headingSource === "ios-true" && headingAccuracy != null && headingAccuracy > COMPASS_BAD_DEG) {
    return `The compass is reporting ±${Math.round(headingAccuracy)}° of error — too noisy to trust. ` +
      "Wave the phone in a figure-8 to recalibrate; showing words meanwhile.";
  }
  return "";
}

function onOrientation(e) {
  // Exactly the rule Astronomy settled on: iOS true heading first, then alpha,
  // and record WHICH so we know whether to trust it.
  if (typeof e.webkitCompassHeading === "number" && !isNaN(e.webkitCompassHeading)) {
    heading = e.webkitCompassHeading;
    headingSource = "ios-true";
    headingAccuracy = (typeof e.webkitCompassAccuracy === "number") ? e.webkitCompassAccuracy : null;
  } else if (e.alpha != null) {
    heading = (360 - e.alpha) % 360;
    headingSource = e.absolute ? "absolute-alpha" : "relative-alpha";
    headingAccuracy = null;
  }
}

// ---------------------------------------------------------------- tracking
async function startTracking() {
  if (tracking) return;
  try {
    // Reuse the shared sensors service — no forked geolocation or listener here.
    await svc.sensors.requestOrientation().catch(() => {});
    offOri = svc.sensors.onOrientation(onOrientation);
    offPos = svc.sensors.watchPosition(
      (p) => {
        pos = { lat: p.coords.latitude, lon: p.coords.longitude,
                accuracy: p.coords.accuracy, ts: p.timestamp || Date.now() };
        posError = "";
        render();
      },
      (err) => {
        posError = err && err.code === 1
          ? "Location permission was denied — Navigator needs it to point anywhere."
          : "Couldn't get a location fix here (indoors and underground are the usual culprits).";
        render();
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
    tracking = true;
    if (!tickId) tickId = setInterval(render, 1000);
  } catch (err) {
    posError = "Location isn't available in this browser.";
  }
  render();
}
function stopTracking() {
  if (offPos) { offPos(); offPos = null; }
  if (offOri) { offOri(); offOri = null; }
  clearInterval(tickId); tickId = 0;
  tracking = false;
  render();
}

// ---------------------------------------------------------------- pins
function persist() { store.set("pins", pins); }
function selected() { return pins.find((p) => p.id === selectedId) || null; }

// A name resolved from speech by the slot layer, consumed by the next drop.
let pendingLabel = "";
function tidyLabel(s) {
  const t = String(s || "").trim().replace(/\s+/g, " ").replace(/[.,!?]+$/, "");
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}

function dropPin(label) {
  if (!pos) return "No location fix yet — wait for GPS before dropping a pin.";
  // An explicit argument wins; otherwise use whatever the utterance named.
  const name = String(label || "").trim() || pendingLabel || defaultLabel();
  pendingLabel = "";
  const pin = { id: "p" + Date.now().toString(36), label: name.slice(0, 40),
    lat: pos.lat, lon: pos.lon, accuracy: pos.accuracy, ts: Date.now() };
  pins.unshift(pin);
  if (pins.length > MAX_PINS) pins.length = MAX_PINS;
  selectedId = pin.id;
  persist(); render();
  return `Dropped “${pin.label}” here, with the fix good to ${fmtAccuracy(pin.accuracy)}.`;
}
function defaultLabel() {
  const used = new Set(pins.map((p) => p.label.toLowerCase()));
  for (const n of ["Car", "Hotel", "Camp", "Tent", "Entrance", "Bike"]) if (!used.has(n.toLowerCase())) return n;
  return `Pin ${pins.length + 1}`;
}
function deletePin(id) {
  pins = pins.filter((p) => p.id !== id);
  if (selectedId === id) selectedId = pins[0] ? pins[0].id : null;
  persist(); render();
}
function renamePin(id, label) {
  const p = pins.find((x) => x.id === id);
  if (!p || !String(label || "").trim()) return;
  p.label = String(label).trim().slice(0, 40);
  persist(); render();
}

// The whole answer for one pin, in one place — used by the UI, the glance card,
// and the voice replies so they can never drift apart.
function solutionFor(pin) {
  if (!pin || !pos) return null;
  const dist = distanceM(pos.lat, pos.lon, pin.lat, pin.lon);
  const brg = bearingTo(pos.lat, pos.lon, pin.lat, pin.lon);
  const trust = headingTrustworthy();
  const rel = trust ? (((brg - heading) % 360) + 360) % 360 : null;
  return {
    pin, dist, bearing: brg, relative: rel, trust,
    distText: fmtDistance(dist),
    compass: compassPoint(brg), words: compassWords(brg),
    relWords: rel == null ? null : relativeWords(rel),
    accuracy: pos.accuracy, problem: trust ? "" : headingProblem(),
    stale: Date.now() - (pos.ts || 0) > STALE_FIX_MS,
  };
}

function spokenFor(pin) {
  const s = solutionFor(pin);
  if (!s) return "No location fix yet.";
  const acc = s.accuracy > BAD_ACCURACY_M ? ` The fix is poor right now, ${fmtAccuracy(s.accuracy)}.` : "";
  if (s.trust) return `${s.pin.label} is ${s.distText} ${s.relWords}, bearing ${s.words}.${acc}`;
  return `${s.pin.label} is ${s.distText} to the ${s.words}.${acc} ${s.problem}`;
}

// ---------------------------------------------------------------- glance card
// TEXT ONLY by contract — direction as words plus a simple glyph, never a drawn
// arrow.
const GLYPH = { "straight ahead": "↑", "ahead-right": "↗", "to your right": "→",
  "behind-right": "↘", "behind you": "↓", "behind-left": "↙",
  "to your left": "←", "ahead-left": "↖" };
function glanceCard() {
  const s = solutionFor(selected());
  if (!s) return null;
  const dirLine = s.trust
    ? `${s.distText} · ${GLYPH[s.relWords] || ""} ${s.relWords}`.trim()
    : `${s.distText} · ${s.words}`;
  const lines = [dirLine, `${s.compass} · GPS ${fmtAccuracy(s.accuracy)}`];
  if (!s.trust) lines.push("no compass — words only");
  return { title: String(s.pin.label).slice(0, 20), lines, spoken: spokenFor(s.pin), holdMs: 8000 };
}

// ---------------------------------------------------------------- rendering
function render() {
  if (!root || !els.wrap) return;
  const s = solutionFor(selected());
  renderPointer(s);
  renderList();
  renderField();
  if (els.trackBtn) els.trackBtn.textContent = tracking ? "⏹ Stop tracking" : "▶ Start tracking";
}

function renderPointer(s) {
  const host = els.pointer;
  if (!host) return;
  if (posError) {
    host.innerHTML = `<div style="color:var(--bad); font-size:13px; line-height:1.5;">${posError}</div>`;
    return;
  }
  if (!tracking) {
    host.innerHTML = `<div style="color:var(--dim); font-size:12.5px; line-height:1.5;">
      Tracking is off. Tap <strong>Start tracking</strong> to get a fix — it's a toggle rather than
      always-on because continuous GPS and compass use real battery.</div>`;
    return;
  }
  if (!pos) { host.innerHTML = '<div style="color:var(--dim); font-size:13px;">Waiting for a GPS fix…</div>'; return; }
  if (!s) {
    host.innerHTML = `<div style="color:var(--dim); font-size:13px; line-height:1.5;">
      Fix acquired, ${fmtAccuracy(pos.accuracy)}. Drop a pin, or pick one below to point at it.</div>`;
    return;
  }
  const poor = s.accuracy > BAD_ACCURACY_M;
  host.innerHTML = `
    <div style="text-align:center;">
      <div style="font-family:var(--mono); font-size:11px; letter-spacing:0.08em; color:var(--accent);">
        POINTING AT ${String(s.pin.label).toUpperCase()}</div>
      ${s.trust ? `
        <div style="font-size:82px; line-height:1; margin:10px 0 4px;
          transform:rotate(${s.relative.toFixed(1)}deg); transition:transform .25s ease-out;">↑</div>
        <div style="font-size:15px; font-weight:600;">${s.relWords}</div>
      ` : `
        <div style="font-size:44px; line-height:1.1; margin:12px 0 6px; font-weight:700;">${s.words}</div>
        <div style="color:var(--warn); font-size:12px; line-height:1.5; max-width:380px; margin:0 auto;">
          ${s.problem}</div>
      `}
      <div style="font-size:34px; font-weight:700; margin-top:10px;">${s.distText}</div>
      <div style="font-family:var(--mono); font-size:11.5px; color:${poor ? "var(--warn)" : "var(--dim)"}; margin-top:6px;">
        bearing ${Math.round(s.bearing)}° ${s.compass} · GPS ${fmtAccuracy(s.accuracy)}${poor ? " — poor fix" : ""}${s.stale ? " · fix is stale" : ""}
      </div>
      <div style="font-size:10.5px; color:var(--dim); margin-top:6px;">
        Straight line, not walking directions — it can point you at a wall.</div>
    </div>`;
}

// A LOCAL canvas: pins plotted relative to you on a blank field. No basemap, no
// tiles, nothing fetched — that's the whole point.
function renderField() {
  const c = els.field;
  if (!c || !pos) return;
  const ctx = c.getContext("2d");
  const w = c.width, h = c.height, cx = w / 2, cy = h / 2;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  for (const r of [40, 80, 120]) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
  ctx.beginPath(); ctx.moveTo(cx, 8); ctx.lineTo(cx, h - 8);
  ctx.moveTo(8, cy); ctx.lineTo(w - 8, cy); ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = "10px ui-monospace, monospace"; ctx.textAlign = "center";
  ctx.fillText(headingTrustworthy() ? "AHEAD" : "N", cx, 18);
  // scale so the furthest pin fits
  let maxD = 1;
  for (const p of pins) maxD = Math.max(maxD, distanceM(pos.lat, pos.lon, p.lat, p.lon));
  const scale = 120 / maxD;
  for (const p of pins) {
    const d = distanceM(pos.lat, pos.lon, p.lat, p.lon);
    const b = bearingTo(pos.lat, pos.lon, p.lat, p.lon);
    // If we have a trustworthy heading the field is ego-relative (up = ahead);
    // otherwise it's north-up, which is honest rather than arbitrary.
    const ang = toRad(headingTrustworthy() ? (((b - heading) % 360) + 360) % 360 : b);
    const r = Math.min(120, d * scale);
    const x = cx + Math.sin(ang) * r, y = cy - Math.cos(ang) * r;
    const on = p.id === selectedId;
    ctx.beginPath(); ctx.arc(x, y, on ? 7 : 5, 0, Math.PI * 2);
    ctx.fillStyle = on ? "#ffd166" : "rgba(120,200,255,0.75)";
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.75)"; ctx.textAlign = "center";
    ctx.fillText(p.label.slice(0, 10), x, y - 10);
  }
  ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#8affc0"; ctx.fill();
}

function renderList() {
  const host = els.list;
  if (!host) return;
  if (!pins.length) { host.innerHTML = '<div class="nrEmpty">No pins yet — tap “Drop a pin here”.</div>'; return; }
  host.innerHTML = "";
  for (const p of pins) {
    const d = pos ? fmtDistance(distanceM(pos.lat, pos.lon, p.lat, p.lon)) : "—";
    const row = document.createElement("div");
    row.style.cssText = `border:1px solid ${p.id === selectedId ? "var(--gold)" : "var(--line)"};
      border-radius:12px; background:var(--panel-solid); padding:10px 12px; margin-bottom:8px;
      display:flex; align-items:center; gap:8px;`;
    row.innerHTML = `
      <button class="nrDel" data-sel="${p.id}" style="flex:1; text-align:left; border:0; background:none; padding:0;">
        <div style="font-weight:600; font-size:13.5px;">${escapeHtml(p.label)}</div>
        <div style="font-family:var(--mono); font-size:10.5px; color:var(--dim); margin-top:2px;">
          ${d} away · dropped ${new Date(p.ts).toLocaleDateString([], { month: "short", day: "numeric" })} · fix ${fmtAccuracy(p.accuracy)}</div>
      </button>
      <button class="nrDel" data-rename="${p.id}">Rename</button>
      <button class="nrDel" data-del="${p.id}">Delete</button>`;
    host.appendChild(row);
  }
  host.querySelectorAll("[data-sel]").forEach((b) => b.addEventListener("click", () => {
    selectedId = b.dataset.sel; render();
    const s = selected(); if (s) svc.speak(spokenFor(s));
  }));
  host.querySelectorAll("[data-rename]").forEach((b) => b.addEventListener("click", () => {
    const p = pins.find((x) => x.id === b.dataset.rename);
    const next = prompt("Rename this pin:", p ? p.label : "");
    if (next !== null) renamePin(b.dataset.rename, next);
  }));
  host.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => deletePin(b.dataset.del)));
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderShell() {
  root.innerHTML = `
    <div style="position:absolute; inset:0; overflow-y:auto; -webkit-overflow-scrolling:touch;
      background:radial-gradient(120% 90% at 50% 0%, #0d1526 0%, var(--bg) 70%); padding:14px 14px 40px;">
      <div data-el="wrap" style="max-width:560px; margin:0 auto;">
        <div style="display:flex; align-items:center; gap:8px; margin:2px 2px 10px;">
          <span style="font-size:22px;">🧭</span>
          <div style="flex:1;">
            <div style="font-weight:700; font-size:17px;">Navigator</div>
            <div style="font-size:11px; color:var(--dim);">A pointer, not a map — straight-line direction and distance to your pins.</div>
          </div>
        </div>

        ${voiceFirstHint(["drop a pin, call it car", "where's my car"])}
        ${manualPanelHTML({ key: "nav", label: "Set manually", inner: `
          <div style="display:flex; gap:8px;">
            <button class="ghostBtn accent" data-el="trackBtn" style="flex:1; padding:11px;">▶ Start tracking</button>
            <button class="bigBtn" data-el="dropBtn" style="flex:1; padding:11px;">📍 Drop a pin here</button>
          </div>` })}

        <div data-el="pointer" style="border:1px solid var(--line); border-radius:16px; background:var(--panel-solid);
          padding:18px 14px; margin-top:10px; min-height:120px; display:flex; align-items:center; justify-content:center;"></div>

        <canvas data-el="field" width="300" height="300"
          style="display:block; width:100%; max-width:300px; margin:10px auto 0; border:1px solid var(--line);
                 border-radius:14px; background:#0a0f1a;"></canvas>
        <div style="font-size:10px; color:var(--dim); text-align:center; margin-top:5px;">
          Relative positions only — there's deliberately no map here.</div>

        <div style="font-weight:700; font-size:13px; margin:16px 2px 8px;">Pins</div>
        <div data-el="list"></div>

        <div style="font-size:10px; color:var(--dim); margin-top:14px; line-height:1.55;">
          <strong>Honest limits.</strong> This points in a <strong>straight line</strong> — it isn't walking
          directions and will happily point you at a wall or across a river. GPS is typically
          <strong>5–20 m</strong> and much worse indoors, in garages and between tall buildings; the live
          accuracy is shown so you can see when the fix is bad. Phone compasses are noisy and drift near cars,
          metal and speakers — a <strong>figure-8 wave</strong> recalibrates them, and if the heading can't be
          trusted you'll get the direction in words instead of a wrong arrow. It works
          <strong>only while this screen is open</strong>, and continuous GPS + compass
          <strong>uses battery</strong>, which is why tracking is a toggle.
        </div>
      </div>
    </div>`;
  for (const el of root.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  wireManualPanel(els, { key: "nav" });
  els.trackBtn.addEventListener("click", () => (tracking ? stopTracking() : startTracking()));
  els.dropBtn.addEventListener("click", () => {
    const label = prompt("Name this pin:", defaultLabel());
    if (label === null) return;
    svc.speak(dropPin(label));
  });
}

// ---------------------------------------------------------------- mode API
export default {
  id: "navigator",
  title: "Navigator · point me back",
  icon: "🧭",
  family: "Live",
  permissions: ["gps"],

  async init(ctx) {
    root = ctx.root; svc = ctx.services;
    store = svc.storage.scope("navigator");
    pins = store.get("pins") || [];
    selectedId = pins[0] ? pins[0].id : null;
    renderShell();
    render();
  },
  async start() {},
  // Foreground-only by nature: a phone web app can't track in the background,
  // so leaving the screen stops the sensors rather than pretending otherwise.
  stop() { stopTracking(); },
  teardown() { stopTracking(); els = {}; root = null; },

  getContext() {
    const s = solutionFor(selected());
    if (!s) return `Navigator — ${pins.length} pin${pins.length === 1 ? "" : "s"} saved${tracking ? ", waiting for a fix" : ", tracking off"}.`;
    return `Navigator — ${s.pin.label} is ${s.distText} to the ${s.words}` +
      (s.trust ? ` (${s.relWords} from where you're facing)` : "") + `, GPS ${fmtAccuracy(s.accuracy)}.`;
  },

  handleCommand(text) {
    const q = String(text || "").toLowerCase().replace(/[.,!?']/g, "").trim();
    const drop = q.match(/^(?:drop a pin|drop pin|mark this spot|save this spot|remember where i parked)(?:\s+(?:here|as)?\s*(.*))?$/);
    if (drop) {
      if (/remember where i parked/.test(q)) return dropPin("Car");
      return dropPin((drop[1] || "").trim());
    }
    const where = q.match(/^(?:wheres|where is|find|point me to|take me to|navigate to)\s+(?:my |the )?(.+)$/);
    if (where) return pointAt(where[1].trim());
    const far = q.match(/^how far (?:is it )?(?:to|from here to)\s+(?:my |the )?(.+)$/);
    if (far) return pointAt(far[1].trim());
    if (/^(start|stop) tracking$/.test(q)) { q.startsWith("start") ? startTracking() : stopTracking(); return `Tracking ${q.startsWith("start") ? "on" : "off"}.`; }
    return null;
  },

  // ---------------------------------------------------------------- slots
  // "Drop a pin, call it car" already names the pin. The label is OPTIONAL on
  // purpose: dropping a pin is time-sensitive (you're walking away from the car),
  // so an unnamed pin gets a sensible default and says which one it used rather
  // than blocking the save behind a question.
  //
  // `pendingLabel` is what dropPin() consumes on the next drop — filling a slot
  // must not itself create a pin, because that would bypass the mode's own flow.
  describeSlots() {
    return [{
      id: "pinLabel", label: "the pin name", required: false,
      sources: ["utterance", "context"],
      parse: (t) => {
        const s = String(t || "").trim();
        // "call it the car" / "name it hotel" / "drop a pin for my tent"
        const m = s.match(/\b(?:call it|name it|label it|called|named|call this)\s+(?:the\s+|my\s+)?([\w' -]{1,40})/i)
          || s.match(/\bdrop a pin\s+(?:for|at|called|named)\s+(?:the\s+|my\s+)?([\w' -]{1,40})/i)
          || s.match(/\b(?:mark|save) (?:this as|it as)\s+(?:the\s+|my\s+)?([\w' -]{1,40})/i);
        if (m) return tidyLabel(m[1]);
        // "remember where I parked" means the car, and people say it constantly.
        if (/\bwhere i parked\b|\bmy car\b/i.test(s)) return "Car";
        return null;
      },
      fromContext: () => null,
      current: () => pendingLabel || null,
      default: null,          // no default: dropPin() already picks a good one
      apply: (v) => { pendingLabel = v; },
      say: (v) => `calling it ${v}`,
    }];
  },

  describeCapabilities() {
    return [
      { id: "nav.drop", label: "Navigator", needsMode: true, sideEffect: true, fillsSlots: true,
        patterns: [/\bdrop a pin\b/i, /\bmark this spot\b/i, /\bremember where i parked\b/i],
        examples: ["drop a pin here", "mark this spot", "remember where I parked"],
        run: (text, ctx) => (ctx.callActiveCommand ? ctx.callActiveCommand(text) : null) },
      { id: "nav.point", label: "Navigator", needsMode: true,
        patterns: [/\bwhere'?s my (car|bike|tent|hotel|camp)\b/i, /\bpoint me (to|back to)\b/i,
                   /\bwhich way (is|to)\b/i],
        examples: ["where's my car", "point me back to the hotel", "which way is the tent"],
        run: (text, ctx) => (ctx.callActiveCommand ? ctx.callActiveCommand(text) : null) },
      { id: "nav.distance", label: "Navigator", needsMode: true,
        patterns: [/\bhow far (is it )?to\b/i, /\bhow far am i from\b/i],
        examples: ["how far to the hotel", "how far am I from the car"],
        run: (text, ctx) => (ctx.callActiveCommand ? ctx.callActiveCommand(text) : null) },
    ];
  },

  getGlanceCard() { return glanceCard(); },

  // verification hooks (#debug)
  _state: () => ({ tracking, pins: pins.slice(), selectedId, pos, heading, headingSource, headingAccuracy,
    trust: headingTrustworthy() }),
  _bearing: (a, b, c, d) => bearingTo(a, b, c, d),
  _distance: (a, b, c, d) => distanceM(a, b, c, d),
  _setPos: (lat, lon, accuracy) => { pos = { lat, lon, accuracy: accuracy == null ? 8 : accuracy, ts: Date.now() }; posError = ""; render(); },
  _setHeading: (deg, source, acc) => { heading = deg; headingSource = source || "ios-true"; headingAccuracy = acc == null ? 5 : acc; render(); },
  _clearHeading: (source) => { heading = source === "relative-alpha" ? 100 : null; headingSource = source || "none"; headingAccuracy = null; render(); },
  _solution: () => solutionFor(selected()),
  _drop: (l) => dropPin(l),
  _select: (id) => { selectedId = id; render(); },
  _rename: (id, l) => renamePin(id, l),
  _delete: (id) => deletePin(id),
  _glance: () => glanceCard(),
  _spoken: () => spokenFor(selected()),
  _relativeWords: (r) => relativeWords(r),
};

// Resolve a spoken pin name to a pin and answer for it.
function pointAt(name) {
  if (!pins.length) return "You haven't dropped any pins yet.";
  const n = String(name).toLowerCase().trim();
  let hit = pins.find((p) => p.label.toLowerCase() === n)
    || pins.find((p) => p.label.toLowerCase().includes(n) || n.includes(p.label.toLowerCase()));
  if (!hit) return `I don't have a pin called “${name}”. You have: ${pins.map((p) => p.label).join(", ")}.`;
  selectedId = hit.id;
  render();
  if (!pos) return `${hit.label} is saved, but there's no GPS fix yet — start tracking and give it a moment.`;
  return spokenFor(hit);
}
