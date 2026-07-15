// Reality Engine · services/overlay — HUD / canvas helpers shared by modes.
// Modes draw their overlays (graphs, reticles, AR pins) on canvases created here so
// device-pixel-ratio handling and cleanup stay consistent. A three.js layer can be
// added later behind the same service without touching modes that don't need it.

export const overlay = {
  // Create a full-bleed canvas inside `parent` (default: absolutely positioned to fill).
  createCanvas(parent, { position = "absolute" } = {}) {
    const canvas = document.createElement("canvas");
    canvas.style.cssText = `position:${position}; inset:0; width:100%; height:100%;`;
    parent.appendChild(canvas);
    return canvas;
  },

  // Match the canvas backing store to its CSS size × devicePixelRatio (capped at 2 for
  // battery). Returns a 2D context with the transform set so you draw in CSS pixels.
  // Call each frame — it only reallocates when the size actually changed.
  fit2d(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h };
  },

  // Read a CSS custom property from the shared theme (e.g. cssVar("--accent")).
  cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  },
};

export default overlay;
