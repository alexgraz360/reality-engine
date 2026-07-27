// Guide · fix & assemble — the Build-family entry point into the SAME Guide
// engine. This is deliberately a thin adapter, not a fork: it imports the one
// engine module (sharing all of its state and logic) and only changes which
// list you land on. Everything — steps, safety prep, hazard gate, triage,
// timers, vision, glance cards — is the engine's.
//
// The point of building Guide as an engine was that a second domain shouldn't
// need a second implementation. This file is the proof.

import guide from "./guide.js";

export default {
  ...guide,
  id: "repair",
  title: "Guide · fix & assemble",
  icon: "🔧",
  family: "Build",
  permissions: ["camera", "mic"],

  // The repair half of Guide's router capabilities, declared against THIS mode
  // id so a fix request opens the Fix picker and a cooking request opens Cook.
  // The engine's own hazard gate runs inside draftRecipe, so a hazardous ask is
  // refused rather than started.
  describeCapabilities() {
    return [
      { id: "guide.fix", label: "Guide", needsMode: true,
        patterns: [/\bguide me through (fixing|repairing|replacing|unclogging|unblocking|assembling|installing|fitting|mending)\b/i,
                   /\b(help|walk) me (through )?(fix|fixing|repair|repairing|assembl|unclog)/i,
                   /\bhow do i (fix|unclog|unblock|replace)\b/i],
        examples: ["guide me through fixing the sink", "help me fix a flat tyre", "guide me through assembling a bookcase"],
        run: (text, ctx) => (ctx.callActiveCommand ? ctx.callActiveCommand(text) : null) },
      { id: "guide.triage", label: "Guide", needsMode: true,
        patterns: [/\bwhat'?s wrong with (my|the)\b/i, /\bhelp me (work out|figure out) what'?s wrong\b/i],
        examples: ["what's wrong with my sink", "help me figure out what's wrong"],
        run: (text, ctx) => (ctx.callActiveCommand ? ctx.callActiveCommand("whats wrong") : null) },
    ];
  },

  async init(ctx) {
    guide._setDomain("repair");   // open on the Fix list rather than Cook
    return guide.init(ctx);
  },
  teardown() {
    guide._setDomain("cooking");  // leave the shared engine as we found it
    return guide.teardown();
  },
};
