// Reality Engine · Light & Color Lab — what colour is that really.
//
// One deliberate camera frame, then arithmetic. Names the colour under the
// crosshair, gives hex/RGB/HSL, shows how brightness varies across the frame, and
// estimates whether the light is warm or cool.
//
// THE REVEAL, which is the actual point of the mode: a shadow you would swear is
// grey is almost always BLUE, because it is lit by the sky rather than the sun.
// And the camera has already decided what "white" is before you ever see the
// pixel — auto white balance moves every number here. So this measures the IMAGE,
// not the world, and it says so rather than pretending to be a colorimeter.
//
// THE RULE: no model produces any number or any name. Colour names come from a
// vendored nearest-neighbour table; everything else is arithmetic on pixels. The
// whole mode works with the bridge switched off.
//
// NO LUX, NO ACCURACY CLAIM. An uncalibrated phone camera with auto-exposure
// cannot measure illuminance, and brightness here is RELATIVE within one frame.

import { nearestColorName, rgbToHex, rgbToHsl, relLuminance, warmCool } from "../services/labTables.js";

let root, svc, store, els = {};
let stream = null, running = false;
let frame = null;              // { w, h, data } from the last capture
let sample = null;             // { r,g,b,hex,hsl,name,lum } under the crosshair
let regions = null;            // 3x3 relative brightness
let light = null;              // warm/cool estimate
let noteMsg = "";
let explainText = "";
const SAMPLE_RADIUS = 6;       // average a small patch, not one noisy pixel

function setNote(t) { noteMsg = t; render(); }

// ---------------------------------------------------------------- capture
async function startCamera() {
  if (running) return "Camera already on.";
  try {
    stream = await svc.sensors.requestCamera({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (err) {
    setNote("Camera unavailable — check the permission and try again.");
    return "I couldn't open the camera.";
  }
  els.cam.srcObject = stream;
  els.cam.style.display = "";
  await els.cam.play();
  running = true;
  render();
  return "Camera on — line up the crosshair and tap Measure.";
}
function stopCamera() {
  running = false;
  if (stream) { svc.sensors.releaseStream(stream); stream = null; }
  if (els.cam) { els.cam.style.display = "none"; els.cam.srcObject = null; }
  render();
}

// One frame, measured. readyState >= 2 or the first frames encode as blank and
// every number below would be a confident description of nothing.
function measure() {
  const v = els.cam;
  if (!running || !v || v.readyState < 2 || !v.videoWidth) {
    setNote("The camera isn't giving a usable frame yet — give it a second.");
    return null;
  }
  const w = 320, h = Math.round((v.videoHeight / v.videoWidth) * 320);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(v, 0, 0, w, h);
  const img = g.getImageData(0, 0, w, h);
  frame = { w, h, data: img.data };

  // Centre patch, averaged — a single pixel is sensor noise.
  const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
  let r = 0, gg = 0, b = 0, n = 0;
  for (let y = cy - SAMPLE_RADIUS; y <= cy + SAMPLE_RADIUS; y++) {
    for (let x = cx - SAMPLE_RADIUS; x <= cx + SAMPLE_RADIUS; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = (y * w + x) * 4;
      r += img.data[i]; gg += img.data[i + 1]; b += img.data[i + 2]; n++;
    }
  }
  r = Math.round(r / n); gg = Math.round(gg / n); b = Math.round(b / n);
  sample = { r, g: gg, b, hex: rgbToHex(r, gg, b), hsl: rgbToHsl(r, gg, b),
    name: nearestColorName(r, gg, b), lum: relLuminance(r, gg, b) };

  // 3x3 relative brightness — where the light actually falls.
  regions = [];
  for (let ry = 0; ry < 3; ry++) {
    const row = [];
    for (let rx = 0; rx < 3; rx++) {
      let s = 0, cnt = 0;
      const x0 = Math.floor((rx * w) / 3), x1 = Math.floor(((rx + 1) * w) / 3);
      const y0 = Math.floor((ry * h) / 3), y1 = Math.floor(((ry + 1) * h) / 3);
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
        const i = (y * w + x) * 4;
        s += relLuminance(img.data[i], img.data[i + 1], img.data[i + 2]); cnt++;
      }
      row.push(cnt ? s / cnt : 0);
    }
    regions.push(row);
  }
  // Whole-frame average drives the warm/cool estimate.
  let ar = 0, ab = 0, cnt2 = 0;
  for (let i = 0; i < img.data.length; i += 16) { ar += img.data[i]; ab += img.data[i + 2]; cnt2++; }
  light = warmCool(ar / cnt2, ab / cnt2);
  noteMsg = "";
  render();
  return sample;
}

// ---------------------------------------------------------------- mode
export default {
  id: "colorlab",
  title: "Light & Color · what colour is that",
  icon: "🎨",
  family: "Learn",
  permissions: ["camera"],

  async init(ctx) {
    root = ctx.root; svc = ctx.services;
    store = svc.storage.scope("colorlab");
    renderShell();
  },
  async start() {},
  stop() { stopCamera(); },
  teardown() { stopCamera(); els = {}; root = null; sample = null; regions = null; explainText = ""; },

  getContext() {
    if (!sample) return "Light & Color Lab — nothing measured yet.";
    const bright = regions ? brightnessSpread() : null;
    return `Light & Color Lab — the centre of the frame reads ${sample.name}, ${sample.hex}, ` +
      `RGB ${sample.r},${sample.g},${sample.b}, HSL ${sample.hsl.h}°/${sample.hsl.s}%/${sample.hsl.l}%. ` +
      (light ? `The light looks ${light.label}. ` : "") +
      (bright ? `Brightness across the frame varies by ${bright}×. ` : "") +
      "These describe the IMAGE after auto white balance and auto exposure, not absolute colour or lux.";
  },

  // The number leads: the hex, not "Color Lab measured something".
  getGlanceCard() {
    if (!sample) return null;
    const wrap = (svc.glasses && svc.glasses.wrap) || ((t) => [String(t).slice(0, 24)]);
    return {
      title: sample.hex,
      lines: [
        sample.name,
        `RGB ${sample.r} ${sample.g} ${sample.b}`,
        ...(light ? wrap(`light: ${light.label}`, 24, 1) : []),
      ].slice(0, 4),
      spoken: `That's ${sample.name}, hex ${sample.hex.replace("#", "")}. The light looks ${light ? light.label : "neutral"}.`,
      holdMs: 9000,
    };
  },

  describeSlots() {
    // Nothing to ask for: the camera supplies everything. Declared explicitly so
    // the contract is visible rather than absent by accident.
    return [];
  },

  describeCapabilities() {
    return [{
      id: "color.measure", label: "Light & Color", needsMode: true, fillsSlots: true,
      patterns: [/\bwhat colou?r is (this|that|it)\b/i, /\bwhat shade is (this|that)\b/i,
                 /\bis (this|that) (really )?(grey|gray|blue|white)\b/i,
                 /\b(open|start) (the )?(colou?r lab|light lab)\b/i,
                 /\bhow bright is (it|this)\b/i],
      examples: ["what colour is this", "how bright is it", "is that really grey", "open the colour lab"],
      run: (text, ctx) => (ctx.callActiveCommand ? ctx.callActiveCommand(text) : null),
    }];
  },

  handleCommand(text) {
    const q = String(text || "").toLowerCase().replace(/[.,!?]/g, "").trim();
    if (/\bwhat colou?r|what shade|how bright|really (grey|gray)\b/.test(q)) {
      if (!running) return startCamera().then(() => "Camera on — point it at what you mean and say it again.");
      const s = measure();
      if (!s) return "The camera isn't ready yet — try again in a second.";
      return `${s.name} — ${s.hex}, RGB ${s.r} ${s.g} ${s.b}. ` +
        (light ? `The light is ${light.label}: ${light.detail}. ` : "") +
        "That's the image after the camera's own white balance, not absolute colour.";
    }
    if (/\b(open|start) (the )?(colou?r lab|light lab)\b|\bturn on the camera\b/.test(q)) return startCamera();
    return null;
  },

  // ---- verification hooks ----
  // Pure: given pixel values, produce the reading. Lets a KNOWN hex swatch be
  // pushed through the real path with no camera and the error reported.
  _measureRGB: (r, g, b) => ({ r, g, b, hex: rgbToHex(r, g, b), hsl: rgbToHsl(r, g, b),
    name: nearestColorName(r, g, b), lum: relLuminance(r, g, b) }),
  _sample: () => sample,
  _measure: () => measure(),
};

function brightnessSpread() {
  const flat = regions.flat();
  const lo = Math.min(...flat), hi = Math.max(...flat);
  return lo > 0.001 ? (hi / lo).toFixed(1) : "a lot";
}

// ---------------------------------------------------------------- rendering
function renderShell() {
  root.innerHTML = `
    <video data-el="cam" playsinline muted autoplay
      style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover; background:#000; display:none;"></video>
    <div data-el="shade" style="position:absolute; inset:0; background:radial-gradient(120% 90% at 50% 0%, #1a1420 0%, var(--bg) 70%);"></div>
    <div data-el="wrap" style="position:absolute; inset:0; overflow-y:auto; -webkit-overflow-scrolling:touch; padding:14px 14px 220px;"></div>`;
  for (const el of root.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  render();
}

function render() {
  if (!els.wrap) return;
  const scroll = els.wrap.scrollTop;
  if (els.shade) els.shade.style.display = running ? "none" : "";
  const s = sample;
  els.wrap.innerHTML = `
    <div style="max-width:560px; margin:0 auto;">
      <h2 style="font-size:20px; margin:2px 2px 4px; ${running ? "text-shadow:0 1px 6px #000;" : ""}">🎨 What colour is that really?</h2>
      <div style="color:${running ? "#ddd" : "var(--dim)"}; font-size:12.5px; line-height:1.5; margin:0 2px 12px;
                  ${running ? "text-shadow:0 1px 6px #000;" : ""}">
        Point the crosshair at something and measure. Try a shadow you'd call grey — it's usually blue.
      </div>

      ${running ? `<div style="position:relative; height:44px; margin-bottom:10px;">
        <div style="position:absolute; left:50%; top:50%; width:26px; height:26px; margin:-13px 0 0 -13px;
                    border:2px solid rgba(255,255,255,0.9); border-radius:50%; box-shadow:0 0 0 2px rgba(0,0,0,0.5);"></div>
      </div>` : ""}

      ${s ? `
      <div style="border:1px solid var(--line); border-radius:16px; background:var(--panel-solid); padding:14px;">
        <div style="display:flex; gap:12px; align-items:center;">
          <div style="width:64px; height:64px; border-radius:12px; flex-shrink:0;
                      background:${s.hex}; border:1px solid rgba(255,255,255,0.25);"></div>
          <div style="min-width:0;">
            <div style="font-family:var(--mono); font-size:26px; font-weight:700;">${s.hex}</div>
            <div style="font-size:15px; font-weight:600; margin-top:2px;">${s.name}</div>
          </div>
        </div>
        <div style="font-family:var(--mono); font-size:12px; color:var(--dim); margin-top:10px; line-height:1.7;">
          RGB ${s.r}, ${s.g}, ${s.b}<br>
          HSL ${s.hsl.h}°, ${s.hsl.s}%, ${s.hsl.l}%<br>
          relative luminance ${(s.lum * 100).toFixed(0)}%
        </div>
        ${light ? `<div style="font-size:12.5px; margin-top:10px; line-height:1.5;">
          <b>Light looks ${light.label}</b> — <span style="color:var(--dim)">${light.detail}</span></div>` : ""}
      </div>

      ${regions ? `<div style="border:1px solid var(--line); border-radius:14px; background:var(--panel-solid);
                    padding:12px; margin-top:10px;">
        <div style="font-weight:700; font-size:13px; margin-bottom:8px;">Brightness across the frame
          <span style="color:var(--dim); font-weight:400;">· varies ${brightnessSpread()}×</span></div>
        <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:4px;">
          ${regions.flat().map((v) => `<div style="aspect-ratio:1.6; border-radius:6px;
             background:rgba(255,255,255,${(0.06 + v * 0.9).toFixed(3)}); display:flex; align-items:center;
             justify-content:center; font-family:var(--mono); font-size:10.5px; color:${v > 0.5 ? "#111" : "#ccc"};">
             ${(v * 100).toFixed(0)}%</div>`).join("")}
        </div>
        <div style="color:var(--dim); font-size:11px; margin-top:8px; line-height:1.45;">
          Relative within this frame only — the camera's auto-exposure has already normalised the whole image.
        </div>
      </div>` : ""}
      ` : ""}

      <div style="display:flex; gap:8px; margin-top:12px;">
        <button class="bigBtn" data-el="camBtn" style="flex:1; padding:13px;">
          ${running ? "📸 Measure" : "📷 Turn on the camera"}</button>
        ${running ? `<button class="ghostBtn" data-el="offBtn">Stop</button>` : ""}
        ${s ? `<button class="ghostBtn" data-el="explainBtn">Explain this</button>` : ""}
      </div>
      <div class="saveNote" data-el="note">${noteMsg}</div>
      ${explainText ? `<div style="border:1px solid var(--line); border-radius:14px; background:var(--panel-solid);
        padding:12px; margin-top:10px; font-size:13px; line-height:1.6;">${escapeHtml(explainText)}</div>` : ""}

      <div style="border:1px solid var(--line); border-radius:14px; background:rgba(255,255,255,0.02);
                  padding:12px; margin-top:12px;">
        <div style="font-weight:700; font-size:13px; margin-bottom:6px;">The thing worth knowing</div>
        <div style="color:var(--dim); font-size:11.5px; line-height:1.6;">
          <b style="color:var(--fg)">The camera already decided what "white" is.</b> Auto white balance shifts every
          colour in the frame before you see it, so these numbers describe the <i>image</i>, not the light in the room.
          Point at the same object under a lamp and by a window and you'll get different hex values for the same paint.
          <br><br>
          <b style="color:var(--fg)">A shadow is not grey.</b> Outdoors, a shadow is lit by the blue sky rather than the
          yellow sun, so it genuinely is blue — your brain corrects it and the camera doesn't. Measuring one is the
          fastest way to see the difference between what you perceive and what's there.
          <br><br>
          <b style="color:var(--fg)">No lux, no colour accuracy.</b> This can't measure illuminance and isn't a
          colorimeter — an uncalibrated sensor with auto-exposure can't do either. Brightness is relative within one
          frame; for real measurements you need a light meter or a colour target.
        </div>
      </div>
      <div style="color:var(--dim); font-size:11px; line-height:1.5; margin:12px 2px 0;">
        Every number here is arithmetic on one frame, on this device — it works with the bridge switched off.
        Colour names come from a small built-in table, not a model. The frame is never uploaded or stored.
      </div>
    </div>`;
  for (const el of els.wrap.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  els.wrap.scrollTop = scroll;
  if (els.camBtn) els.camBtn.onclick = () => (running ? measure() : startCamera().then(setNote));
  if (els.offBtn) els.offBtn.onclick = stopCamera;
  if (els.explainBtn) els.explainBtn.onclick = explain;
}

// Optional, and optional by construction: it explains a measurement that already
// exists. With the bridge down this says so and every number above is unaffected.
async function explain() {
  if (!sample) return;
  explainText = "Asking…"; render();
  const s = sample;
  try {
    const res = await svc.companion.ask(
      `In at most 40 words, explain plainly why a surface might measure as ${s.name} (${s.hex}) ` +
      `and what auto white balance does to that reading. Do not invent numbers.`,
      "", [], { maxTokens: 110, temperature: 0.3 });
    explainText = res.ok ? res.text : "The explanation needs the bridge, which isn't reachable — the measurements above are unaffected.";
  } catch (e) {
    explainText = "The explanation needs the bridge, which isn't reachable — the measurements above are unaffected.";
  }
  render();
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
