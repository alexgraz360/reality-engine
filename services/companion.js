// Reality Engine · services/companion — the AI companion seam (STUB).
//
// This is the reserved attach point for the future Jarvis-style companion
// (see GLASSES.md and the platform brief §3). NOTHING here talks to a model yet:
// no LLM, no API keys, no backend. Wiring one later (a tiny key-holding proxy, or a
// local agent like OpenClaw) should only mean replacing the body of `ask()` —
// every caller already passes the active mode's getContext() string, which is what
// makes the companion situation-aware across all modes.
//
// Future contract (kept stable from day one):
//   ask(prompt, context) → Promise<{ ok, text, source }>
//     prompt  — what the user said/asked (voice or text)
//     context — the active mode's getContext() string ("" if no mode is active)
//
// SAFETY (mandatory when this is wired): any side-effectful action the companion
// takes (send / post / delete / pay) must pass a confirmation gate first. A misheard
// voice command must never auto-fire an irreversible action.

export const companion = {
  isConfigured() { return false; },

  async ask(prompt, context = "") {
    return {
      ok: false,
      source: "stub",
      text:
        "The AI companion isn't configured yet — this seam is reserved for it. " +
        "When it's wired in, it will answer using what you're doing right now" +
        (context ? ` (the active mode reports: “${context}”)` : "") + ".",
    };
  },
};

export default companion;
