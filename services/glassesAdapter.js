// Reality Engine · services/glassesAdapter — the glasses attach point (STUB).
//
// When the Brilliant Labs Halo arrives, its SDK bridge drops in HERE (see GLASSES.md
// for the full plan + configuration checklist). The adapter's two jobs:
//   1. MIRROR — push the active mode's glanceable HUD to the glasses display.
//   2. ROUTE  — feed the glasses' mic + camera into services/sensors and the companion,
//               so modes don't care whether input comes from the phone or the glasses.
//
// Everything below is a documented no-op so callers can be written today and work
// unchanged when real hardware lands. Strictly additive: the phone experience never
// depends on this file.

export const glassesAdapter = {
  isConnected() { return false; },

  // Pair with the glasses (future: Halo SDK handshake over BLE/WebBluetooth).
  async connect() {
    throw new Error("No glasses adapter configured yet — see GLASSES.md.");
  },

  async disconnect() { /* no-op until hardware lands */ },

  // Mirror a glanceable HUD frame/text to the glasses display.
  // `hud` will be a small declarative payload (text lines / simple vector ops),
  // NOT a full canvas stream — the Halo display is glanceable, not immersive.
  mirrorHUD(hud) { /* no-op stub */ },

  // Route glasses inputs into the engine. Future implementations return the same
  // shapes services/sensors produces, so modes stay input-agnostic.
  async routeMic() { throw new Error("Glasses mic routing not configured yet."); },
  async routeCamera() { throw new Error("Glasses camera routing not configured yet."); },

  // Wake-word / tap gesture hook for the companion loop.
  onWake(fn) { return () => {}; /* no-op unsubscribe */ },
};

export default glassesAdapter;
