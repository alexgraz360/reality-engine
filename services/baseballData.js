// Reality Engine · services/baseballData — pitch prediction provider seam.
//
// A PROVIDER answers "what happens in this matchup and count?". The vendored
// public Statcast aggregates are provider #1 so the mode works today. Alex's
// own analytics site (mithrandir-metrics, whose data lives locally on his
// desktop) becomes provider #2 later WITHOUT touching this mode: register it in
// PROVIDERS and getPrediction() prefers it, falling back to public data for
// anything it doesn't answer. See MODES.md → "Baseball prediction providers".
//
// Provider interface:
//   { id, label,
//     async ready(),                                  // load once; true if usable
//     pitchers(): [{id, name}],  batters(): [{id, name}],
//     predict(pitcherId, batterId, count, situation)  // -> partial prediction
//   }
// count: { balls, strikes }
//
// Everything here is vendored/offline — no network, no secrets. HONESTY: these
// are historical frequencies, never a claim about the next pitch.

const DATA_BASE = new URL("../data/baseball/", import.meta.url);

function pct(x) { return x == null ? "n/a" : Math.round(x * 100) + "%"; }
function countState(balls, strikes) {
  if (balls === 0 && strikes === 0) return "0-0";
  if (balls === 3 && strikes === 2) return "full";
  if (balls === 3) return "3ball";
  if (strikes === 2) return "2strike";
  if (strikes > balls) return "ahead";
  if (balls > strikes) return "behind";
  return "even";
}
// "low-away" → "low and away"; used for the spoken call.
function locPhrase(cell) {
  if (!cell) return null;
  const [row, col] = cell.split("-");
  const rowW = { low: "low", mid: "middle", up: "up" }[row] || row;
  const colW = { in: "inside", mid: "middle", away: "away" }[col] || col;
  if (rowW === "middle" && colW === "middle") return "middle-middle";
  if (colW === "middle") return rowW;
  if (rowW === "middle") return colW;
  return `${rowW} and ${colW}`;
}
function topEntry(obj) {
  if (!obj) return null;
  const e = Object.entries(obj).sort((a, b) => b[1] - a[1])[0];
  return e ? { key: e[0], value: e[1] } : null;
}

// ---------------------------------------------------------------- provider #1
const publicProvider = (() => {
  let league = null, pitchers = null, batters = null, loaded = false, ok = false;
  return {
    id: "statcast",
    label: "public Statcast",
    async ready() {
      if (loaded) return ok;
      loaded = true;
      try {
        const [l, p, b] = await Promise.all([
          fetch(new URL("league.json", DATA_BASE)).then((r) => r.json()),
          fetch(new URL("pitchers.json", DATA_BASE)).then((r) => r.json()),
          fetch(new URL("batters.json", DATA_BASE)).then((r) => r.json()),
        ]);
        league = l; pitchers = p.pitchers; batters = b.batters;
        ok = !!(league && pitchers && batters);
      } catch (err) {
        console.warn("baseballData: vendored data unavailable", err);
        ok = false;
      }
      return ok;
    },
    meta() { return league ? league.meta : null; },
    leagueRow() { return league ? league.league : null; },
    pitchers() {
      return ok ? Object.entries(pitchers).map(([id, r]) => ({ id, name: r.name, n: r.n }))
        .sort((a, b) => a.name.localeCompare(b.name)) : [];
    },
    batters() {
      return ok ? Object.entries(batters).map(([id, r]) => ({ id, name: r.name, n: r.n }))
        .sort((a, b) => a.name.localeCompare(b.name)) : [];
    },
    getPitcher(id) { return (ok && pitchers[id]) || null; },
    getBatter(id) { return (ok && batters[id]) || null; },

    predict(pitcherId, batterId, count) {
      if (!ok) return null;
      const st = countState(count.balls, count.strikes);
      const cnt = `${count.balls}-${count.strikes}`;
      const L = league.league;
      const P = pitcherId && pitchers[pitcherId];
      const B = batterId && batters[batterId];
      const out = { source: this.id, state: st, count: cnt, fallbacks: [] };

      // --- likely pitch type: pitcher's own mix for this count state, else league
      const mix = (P && P.mix && P.mix[st]) || null;
      if (mix) out.mix = mix;
      else { out.mix = L.pitchMix[st] || null; if (out.mix) out.fallbacks.push("pitch mix"); }
      const top = topEntry(out.mix);
      if (top) {
        out.pitch = { code: top.key, name: (league.meta.pitchNames || {})[top.key] || top.key, share: top.value };
      }

      // --- location tendency: pitcher's grid for this state, then his overall, then league
      let locGrid = (P && P.loc && P.loc[st]) || null;
      if (!locGrid && P && P.locAll) { locGrid = P.locAll; out.fallbacks.push("location (his overall)"); }
      if (!locGrid) { locGrid = L.location[st] || null; if (locGrid) out.fallbacks.push("location"); }
      out.locationGrid = locGrid;
      const tl = topEntry(locGrid);
      if (tl) out.location = { cell: tl.key, phrase: locPhrase(tl.key), share: tl.value };
      out.zoneRate = (P && P.zoneRate && P.zoneRate[st] != null) ? P.zoneRate[st] : (L.zoneRate[st] ?? null);

      // --- outcome distribution for THIS count: batter's own if the sample
      // allows, else the league baseline (labelled, never silently swapped)
      const bRow = B && B.byCount && B.byCount[cnt];
      if (bRow) out.outcome = { ...bRow, basis: "batter" };
      else if (L.byCount[cnt]) { out.outcome = { ...L.byCount[cnt], basis: "league" }; out.fallbacks.push("outcome %"); }
      out.leagueOutcome = L.byCount[cnt] || null;

      if (B) out.batter = { name: B.name, stand: B.stand, swing: B.swing, chase: B.chase, whiff: B.whiff, vsPitch: B.vsPitch };
      if (P) out.pitcher = { name: P.name, n: P.n };
      out.league = { swing: L.swing, chase: L.chase, whiff: L.whiff, zoneRate: L.zoneRate[st] };
      return out;
    },
  };
})();

// Provider #2 (Alex's mithrandir-metrics, local) will be appended here. Later
// entries WIN on any field they answer — see getPrediction()'s overlay.
const PROVIDERS = [publicProvider];

const api = {
  async ready() {
    const flags = await Promise.all(PROVIDERS.map((p) => p.ready().catch(() => false)));
    return flags.some(Boolean);
  },
  providers() { return PROVIDERS.map((p) => ({ id: p.id, label: p.label })); },
  meta() { return publicProvider.meta(); },
  pitchers() { return publicProvider.pitchers(); },
  batters() { return publicProvider.batters(); },
  getPitcher(id) { return publicProvider.getPitcher(id); },
  getBatter(id) { return publicProvider.getBatter(id); },

  // The seam. Later providers overlay earlier ones field-by-field, so Alex's
  // model can sharpen just the pitch call (say) and still inherit public
  // outcome percentages for anything it doesn't model.
  getPrediction(pitcherId, batterId, count, situation) {
    let out = null;
    for (const p of PROVIDERS) {
      const rows = p.predict(pitcherId, batterId, count, situation);
      if (!rows) continue;
      out = out
        ? { ...out, ...rows, sources: [...(out.sources || []), p.id] }
        : { ...rows, sources: [p.id] };
    }
    return out;
  },

  countState,
  locPhrase,

  // ---- speakable composition (deterministic; NO model call) ----
  // Mirrors football's instantRead: the numbers ARE the read.
  instantRead(pred, names) {
    if (!pred) return null;
    const S = [], numbers = [];
    const who = (names && names.pitcher) || (pred.pitcher && pred.pitcher.name) || "the pitcher";
    const bat = (names && names.batter) || (pred.batter && pred.batter.name) || "the batter";

    // 1. the call: likely pitch + where. With no pitcher picked these are the
    // LEAGUE numbers, so say that rather than implying we know this arm.
    if (pred.pitch) {
      const loc = pred.location ? ` ${pred.location.phrase}` : "";
      const knowsPitcher = !!(pred.pitcher && pred.pitcher.name);
      S.push(knowsPitcher
        ? `${who} leans ${pred.pitch.name} (${pct(pred.pitch.share)})${loc} in ${pred.count} counts.`
        : `League-wide in ${pred.count} counts it's ${pred.pitch.name} (${pct(pred.pitch.share)})${loc} — pick the pitcher for his own mix.`);
      numbers.push(`${pred.pitch.name} ${pct(pred.pitch.share)}`);
      if (pred.location) numbers.push(`${pred.location.phrase} ${pct(pred.location.share)}`);
    }
    // 2. the live outcome line
    if (pred.outcome) {
      const o = pred.outcome;
      S.push(`In ${pred.count}, ${bat} strikes out ${pct(o.k)}, reaches ${pct(o.hit + o.walk)}` +
        (o.basis === "league" ? " (league average — thin sample for him)." : "."));
      numbers.push(`K ${pct(o.k)} · hit ${pct(o.hit)} · BB ${pct(o.walk)} · out ${pct(o.out)}`);
    }
    // 3. one edge: the biggest deviation from league
    const edges = [];
    if (pred.batter && pred.batter.chase != null && pred.league.chase != null) {
      edges.push({ size: Math.abs(pred.batter.chase - pred.league.chase),
        text: pred.batter.chase > pred.league.chase
          ? `${bat} chases ${pct(pred.batter.chase)} out of the zone, above the ${pct(pred.league.chase)} average`
          : `${bat} rarely chases (${pct(pred.batter.chase)} vs ${pct(pred.league.chase)})` });
    }
    if (pred.zoneRate != null && pred.league.zoneRate != null) {
      edges.push({ size: Math.abs(pred.zoneRate - pred.league.zoneRate),
        text: pred.zoneRate < pred.league.zoneRate
          ? `he works out of the zone here (${pct(pred.zoneRate)} in-zone)`
          : `he fills the zone here (${pct(pred.zoneRate)})` });
    }
    edges.sort((a, b) => b.size - a.size);
    if (edges[0] && edges[0].size >= 0.03) S.push(edges[0].text.replace(/^./, (c) => c.toUpperCase()) + ".");

    return { line: S.join(" "), numbers, outcome: pred.outcome, location: pred.location,
             pitch: pred.pitch, fallbacks: pred.fallbacks || [] };
  },

  // Trimmed rows for the anchored ＋Detail prompt (2-3 facts, not whole tables).
  formatBriefForPrompt(pred, names) {
    if (!pred) return "";
    const L = [];
    L.push(`Count: ${pred.count} (${pred.state}).`);
    if (pred.pitch) L.push(`${(names && names.pitcher) || "Pitcher"} most likely pitch here: ${pred.pitch.name} ${pct(pred.pitch.share)}` +
      (pred.location ? `, usually ${pred.location.phrase} (${pct(pred.location.share)})` : "") + ".");
    if (pred.zoneRate != null) L.push(`In-zone rate here: ${pct(pred.zoneRate)} (league ${pct(pred.league.zoneRate)}).`);
    if (pred.outcome) L.push(`Outcome in this count: strikeout ${pct(pred.outcome.k)}, hit ${pct(pred.outcome.hit)}, ` +
      `walk ${pct(pred.outcome.walk)}, other out ${pct(pred.outcome.out)} (${pred.outcome.basis} basis, n=${pred.outcome.n}).`);
    if (pred.batter) L.push(`Batter: chase ${pct(pred.batter.chase)} (league ${pct(pred.league.chase)}), whiff ${pct(pred.batter.whiff)}.`);
    L.push("These are historical frequencies, not a prediction of the next pitch. Never claim to know what is coming.");
    return L.join("\n");
  },

  // Card rows.
  cardLines(pred) {
    if (!pred) return [];
    const out = [];
    if (pred.pitch) out.push(`Likely: ${pred.pitch.name} ${pct(pred.pitch.share)}` +
      (pred.location ? ` · ${pred.location.phrase}` : ""));
    if (pred.mix) {
      out.push("Mix: " + Object.entries(pred.mix).sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([k, v]) => `${k} ${pct(v)}`).join(" · "));
    }
    if (pred.zoneRate != null) out.push(`In zone: ${pct(pred.zoneRate)} (lg ${pct(pred.league.zoneRate)})`);
    if (pred.batter) out.push(`Chase ${pct(pred.batter.chase)} · whiff ${pct(pred.batter.whiff)}`);
    return out;
  },
};

export default api;
