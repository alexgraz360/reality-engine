// Astronomy — grounded native mode via EMBED (gradual migration, no fork).
// Mounts the live astronomy app in an iframe and listens for the compact
// context messages its re-context-bridge publishes, so the global ✦ companion
// knows what the user is looking at ("why is Jupiter so bright tonight?").
//
// Read-only grounding: this mode never drives the astronomy app; deeper
// two-way control (companion telling astronomy to fly somewhere) is a later
// handoff. Security: postMessage origin is validated in BOTH directions and
// the location in the message is pre-rounded (~2 dp) by the publisher.

const ASTRO_ORIGIN = "https://alexgraz360.github.io";
const ASTRO_URL = ASTRO_ORIGIN + "/astronomy-glasses/phase1/";
const STALE_MS = 60_000; // context older than this is treated as gone

let root = null;
let iframe = null;
let onMessage = null;
let lastCtx = null;     // latest RE_ASTRO_CONTEXT payload
let lastCtxAt = 0;

function compass(az) {
  const dirs = ["north", "NE", "east", "SE", "south", "SW", "west", "NW"];
  return dirs[Math.round(((az % 360) + 360) % 360 / 45) % 8];
}

function requestFresh() {
  if (iframe && iframe.contentWindow) {
    try { iframe.contentWindow.postMessage({ type: "RE_ASTRO_REQUEST" }, ASTRO_ORIGIN); } catch (e) {}
  }
}

function mount() {
  if (iframe || !root) return;
  iframe = document.createElement("iframe");
  iframe.src = ASTRO_URL;
  // Delegate the device permissions the AR sky needs (prompts still fire
  // inside the iframe on user gestures, as iOS requires).
  iframe.setAttribute("allow",
    "camera; gyroscope; accelerometer; magnetometer; geolocation; xr-spatial-tracking; fullscreen");
  iframe.style.cssText = "position:absolute; inset:0; width:100%; height:100%; border:0; background:#06080f;";
  iframe.addEventListener("load", requestFresh);
  root.appendChild(iframe);
}

function unmount() {
  // Removing the iframe is what releases the camera/sensors it holds.
  if (iframe) { iframe.remove(); iframe = null; }
}

export default {
  id: "astronomy",
  title: "Astronomy",
  icon: "🔭",
  family: "Learn",
  permissions: ["camera", "motion", "orientation", "geolocation"],

  async init(ctx) {
    root = ctx.root;
    lastCtx = null;
    lastCtxAt = 0;
    onMessage = (e) => {
      if (e.origin !== ASTRO_ORIGIN) return; // ignore every other origin
      if (e.data && e.data.type === "RE_ASTRO_CONTEXT") {
        lastCtx = e.data;
        lastCtxAt = Date.now();
      }
    };
    window.addEventListener("message", onMessage);
  },

  async start() { mount(); },

  stop() { unmount(); },

  teardown() {
    unmount();
    if (onMessage) { window.removeEventListener("message", onMessage); onMessage = null; }
    lastCtx = null;
    root = null;
  },

  // Natural-language grounding for the companion. Called at sheet-open and
  // ask time; each call also pings the bridge so the NEXT read is fresh.
  getContext() {
    requestFresh();
    if (!lastCtx || Date.now() - lastCtxAt > STALE_MS) return "";
    const c = lastCtx;
    const parts = [];
    if (c.selected) {
      const s = c.selected;
      let line = `Selected object: ${s.name} (${s.kind})`;
      if (typeof s.altitudeDeg === "number") {
        line += s.altitudeDeg >= 0
          ? `, ${s.altitudeDeg}° above the horizon toward the ${compass(s.azimuthDeg)}`
          : `, currently ${-s.altitudeDeg}° below the horizon`;
      }
      if (s.magnitude !== null && s.magnitude !== undefined) line += `, magnitude ${s.magnitude}`;
      parts.push("The user is in the Astronomy sky view. " + line + ".");
    } else {
      parts.push("The user is in the Astronomy sky view, browsing the sky; nothing is selected yet.");
    }
    if (c.simTimeISO) {
      const d = new Date(c.simTimeISO);
      if (!isNaN(d)) parts.push(`Simulated sky time: ${d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.`);
    }
    if (c.location) parts.push(`Viewing from about latitude ${c.location.lat}, longitude ${c.location.lon}.`);
    if (c.visibleBright && c.visibleBright.length) {
      parts.push(`Bright solar-system objects up now: ${c.visibleBright.join(", ")}.`);
    }
    return parts.join(" ");
  },

  _state: () => ({ hasIframe: !!iframe, ctxAgeMs: lastCtx ? Date.now() - lastCtxAt : null, lastCtx }), // verification hook
};
