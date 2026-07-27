// Reality Engine · services/knowledge — the Knowledge Library client (RAG).
//
// Semantic reference lookup against the user's own bridge: seeded reference
// packs (cooking / astronomy / physics) plus anything they've asked the
// companion to remember. Everything is embedded and stored on THEIR machine —
// no cloud, no vector service, no per-query cost.
//
// Design notes:
//  - Retrieval is best-effort. If the bridge is unreachable or slow, search()
//    resolves to [] and the companion simply answers unaided — knowledge must
//    never be able to block or break a conversation.
//  - Queries are composed from the question AND the active mode's context,
//    which measurably improves ranking: "does a heavier weight swing faster"
//    alone mis-ranks, but prefixed with the pendulum context it retrieves the
//    period-formula chunk at 0.85 instead of 0.65 for the wrong one.
//
// Reads the same bridge config the companion uses (storage keys), so it stays
// independent of companion.js — no import cycle.

import storage from "./storage.js";

const SEARCH_TIMEOUT_MS = 8_000;  // retrieval is ~0.1 s; this is a stall guard
const ADD_TIMEOUT_MS = 30_000;    // embedding a long note takes a little longer
// Ranking nudge for the user's OWN memories on personal questions. Deliberately
// modest: it wins a near-tie against a reference chunk without dragging an
// irrelevant memory above a genuinely better match.
const PERSONAL_BOOST = 0.08;

function scrub(value) {
  return (value || "").replace(/[​-‍⁠﻿]/g, "").replace(/\s+/g, "");
}
function endpoint() { return scrub(storage.get("companion.endpoint", "")).replace(/\/+$/, ""); }
function token() { return scrub(storage.get("companion.token", "")); }
function configured() { return Boolean(endpoint() && token()); }

async function call(path, { method = "POST", body, timeoutMs = SEARCH_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(endpoint() + path, {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer " + token() },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error("knowledge " + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

export const knowledge = {
  isConfigured: configured,

  // Best-effort semantic search. Never throws.
  async search(question, { context = "", topK = 3, packs = null } = {}) {
    if (!configured() || !question) return [];
    // The mode's context disambiguates the question — see the note above.
    const query = (context ? context + " " : "") + question;
    try {
      // Ask for a slightly wider pool when the question is personal, so a
      // stored memory that scored just below a reference chunk can still be
      // promoted below rather than being cut off before we see it.
      const personal = this.isPersonalQuestion(question);
      const data = await call("/knowledge/search", {
        body: { query: query.slice(0, 1000), topK: personal ? Math.max(topK, 6) : topK, packs },
      });
      let results = Array.isArray(data.results) ? data.results : [];
      if (personal && results.length) {
        // "Where did I put my passport?" must surface YOUR memory, not a
        // reference chunk that happens to mention passports. A modest, bounded
        // boost — enough to win a near-tie, not enough to surface junk.
        results = results
          .map((r) => ({ r, rank: r.score + (r.meta && r.meta.scope === "personal" ? PERSONAL_BOOST : 0) }))
          .sort((a, b) => b.rank - a.rank)
          .slice(0, topK)
          .map((x) => x.r);
      }
      return results;
    } catch (err) {
      return []; // bridge down / slow / model missing → answer unaided
    }
  },

  // Store something the user asked to remember. Throws so the caller can report.
  // `meta` (optional) marks a PERSONAL memory: { scope:'personal', kind,
  // subject, ts, placeTag?, source } — the same store and embedding path as
  // everything else, just tagged so it can be listed, preferred and deleted.
  async add(text, { title = "", pack = "my-notes", meta = null } = {}) {
    if (!configured()) throw new Error("the companion bridge isn't configured yet");
    return call("/knowledge/add", { body: { text, title, pack, ...(meta ? { meta } : {}) }, timeoutMs: ADD_TIMEOUT_MS });
  },

  // The user's own memories only (never the seeded packs), newest first.
  async personal() {
    if (!configured()) return [];
    try {
      const data = await call("/knowledge/personal", { method: "GET" });
      return Array.isArray(data.memories) ? data.memories : [];
    } catch (err) { return []; }
  },

  async update(id, fields) {
    if (!configured()) throw new Error("the companion bridge isn't configured yet");
    return call("/knowledge/update", { body: { id, ...fields }, timeoutMs: ADD_TIMEOUT_MS });
  },

  async remove(id) {
    if (!configured()) throw new Error("the companion bridge isn't configured yet");
    return call("/knowledge/remove", { body: { id } });
  },

  // Does this question sound like it's asking about the user's OWN life?
  // ("where did I put my passport", "who is Maya", "what did I say about rent")
  isPersonalQuestion(q) {
    const t = String(q || "").toLowerCase();
    return /\b(my|mine|i|i'?ve|we|our)\b.*\b(put|leave|left|say|said|tell|told|park|store|keep|kept)\b/.test(t)
      || /\bwhere (did|do) (i|we)\b/.test(t)
      || /\bwhere('?s| is| are) (my|our|the)\b/.test(t)
      || /\bwho (is|was|are)\b/.test(t)
      || /\bwhat did i (say|tell|mention)\b/.test(t)
      // Meeting/session recall — "what did we decide about the budget?"
      || /\bwhat (did|was) (we|it|they) ?(decide|agree|discuss|say|conclude)/.test(t)
      || /\bwhat (was|were) (decided|agreed|discussed)\b/.test(t)
      || /\b(in|from|at) (the|that|our|my) (meeting|call|session|standup|review)\b/.test(t)
      || /\baction items?\b/.test(t)
      || /\b(did i|have i) (say|said|tell|told|store|save|remember)\b/.test(t)
      || /\bmy\b/.test(t);
  },

  async packs() {
    if (!configured()) return { packs: [], chunks: 0 };
    try { return await call("/knowledge/packs", { method: "GET" }); }
    catch (err) { return { packs: [], chunks: 0 }; }
  },

  // Render retrieved chunks into the prompt block the model sees.
  format(results) {
    return results
      .map((r) => {
        // A personal memory is labelled as the user's OWN, with WHEN (and where)
        // it was saved, so the model can say "you saved that Tuesday" instead of
        // reciting it like a reference fact.
        if (r.meta && r.meta.scope === "personal") {
          const when = knowledge.whenLabel(r.meta.ts);
          const where = r.meta.placeTag ? `, at ${r.meta.placeTag}` : "";
          const how = r.meta.source === "looked" ? " (saved by looking at it)" : "";
          return `[YOUR OWN MEMORY — ${r.meta.subject || r.title}; you saved this ${when}${where}${how}]\n${r.text}`;
        }
        return `[${r.packLabel || r.pack} — ${r.title}]\n${r.text}`;
      })
      .join("\n\n");
  },

  // "today" / "yesterday" / "on Tuesday" / "on 3 Mar" — recency is the point of
  // a personal memory, so recall always states it.
  whenLabel(ts) {
    if (!Number.isFinite(ts)) return "at some point";
    const d = new Date(ts), now = new Date();
    const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()) -
      new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 7) return "on " + d.toLocaleDateString([], { weekday: "long" });
    return "on " + d.toLocaleDateString([], { month: "short", day: "numeric" });
  },
};

export default knowledge;
