// Reality Engine · services/footballData — tendency provider seam.
//
// A PROVIDER exposes a team's situational tendencies. The vendored public
// nflverse dataset is the first provider; Alex's own analytics pages can be
// added later as a SECOND provider without reworking Football mode — register
// it in PROVIDERS and getTendencies() merges (later provider overlays/augments
// the earlier one). See MODES.md → "Football tendency providers".
//
// Provider interface:
//   { id, label,
//     async ready(),                     // load once; return true if usable
//     teams(): string[],                 // team codes it knows
//     lookup(team, situation): object|null,        // OFFENSE rows for this team
//     lookupDefense(team, situation): object|null   // DEFENSE rows (optional)
//   }
// situation: { down, distance, zone }  (distance in yards; zone = app zone id)
//
// All data is vendored/offline — no network, no secrets. Honesty: these are
// season-to-date historical tendencies, not a prediction. Public data has NO
// coverage labels (Cover 2/3 is proprietary), so coverage is always reported
// as n/a and never inferred; "pressure" is QB hits + sacks per dropback, the
// public proxy — charted hurries are not available.

const DATA_BASE = new URL("../data/football/", import.meta.url);

function distBucket(distance) {
  return distance <= 3 ? "short" : distance <= 7 ? "med" : "long";
}
function pct(x) { return x == null ? "n/a" : Math.round(x * 100) + "%"; }
function signed(x) { return x == null ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(2); }
// Top-N groupings by share. NOTE: integer-like keys ("11","10") iterate in
// numeric order in JS, not insertion order, so we must sort by value here.
function topGroupings(obj, n) {
  return obj ? Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n) : [];
}
function ordinalDown(d) { return ["", "1st", "2nd", "3rd", "4th"][d] || `${d}th`; }
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// -------------------------------------------------- vendored nflverse provider
const vendoredProvider = (() => {
  let teamsData = null;   // { meta, teams }
  let leagueData = null;  // { meta, league }
  let loaded = false;

  return {
    id: "nflverse",
    label: "nflverse public data",
    meta: () => (teamsData ? teamsData.meta : null),
    async ready() {
      if (loaded) return !!teamsData;
      loaded = true;
      try {
        const [t, l] = await Promise.all([
          fetch(new URL("tendencies.json", DATA_BASE)).then((r) => r.json()),
          fetch(new URL("league.json", DATA_BASE)).then((r) => r.json()),
        ]);
        teamsData = t; leagueData = l;
      } catch (e) {
        console.error("football data failed to load:", e);
        teamsData = null;
      }
      return !!teamsData;
    },
    teams() { return teamsData ? Object.keys(teamsData.teams).sort() : []; },
    league() { return leagueData ? leagueData.league : null; },
    lookup(team, sit) {
      if (!teamsData || !team || !teamsData.teams[team]) return null;
      const t = teamsData.teams[team];
      const lg = leagueData ? leagueData.league : null;
      const ddKey = `${sit.down}|${distBucket(sit.distance)}`;
      return {
        source: this.id, meta: teamsData.meta, team, plays: t.plays,
        overall: t.overall, leagueOverall: lg && lg.overall,
        ddKey, dd: t.downDistance[ddKey], leagueDd: lg && lg.downDistance[ddKey],
        zone: sit.zone, zoneCell: t.fieldZone[sit.zone], leagueZone: lg && lg.fieldZone[sit.zone],
        thirdDown: t.thirdDown, redZone: t.redZone,
        personnel: t.personnel, formation: t.formation,
        fingerprint: t.fingerprint,
      };
    },
    // League rank of a team's pass rate in one down|distance cell (1 = most
    // pass-happy). Computed here from the vendored table — no server needed.
    rankPass(team, ddKey, minN = 25) {
      if (!teamsData) return null;
      const rows = Object.entries(teamsData.teams)
        .map(([t, r]) => [t, r.downDistance[ddKey]])
        .filter(([, c]) => c && c.n >= minN && typeof c.pass === "number")
        .sort((a, b) => b[1].pass - a[1].pass);
      const i = rows.findIndex(([t]) => t === team);
      return i < 0 ? null : { rank: i + 1, of: rows.length };
    },
    rankBlitz(team, minN = 100) {
      if (!teamsData) return null;
      const rows = Object.entries(teamsData.teams)
        .map(([t, r]) => [t, r.defense && r.defense.overall])
        .filter(([, o]) => o && typeof o.blitzRate === "number")
        .sort((a, b) => b[1].blitzRate - a[1].blitzRate);
      const i = rows.findIndex(([t]) => t === team);
      return i < 0 ? null : { rank: i + 1, of: rows.length };
    },
    lookupDefense(team, sit) {
      if (!teamsData || !team || !teamsData.teams[team] || !teamsData.teams[team].defense) return null;
      const D = teamsData.teams[team].defense;
      const lgD = leagueData && leagueData.league.defense;
      const ddKey = `${sit.down}|${distBucket(sit.distance)}`;
      return {
        source: this.id, meta: teamsData.meta, team,
        overall: D.overall, leagueOverall: lgD && lgD.overall,
        ddKey, dd: D.downDistance[ddKey], leagueDd: lgD && lgD.downDistance[ddKey],
        blitzDD: D.blitzByDD ? D.blitzByDD[ddKey] : null,
        leagueBlitzDD: lgD && lgD.blitzByDD ? lgD.blitzByDD[ddKey] : null,
        zone: sit.zone, zoneCell: D.fieldZone[sit.zone], leagueZone: lgD && lgD.fieldZone[sit.zone],
        thirdDown: D.thirdDown, redZone: D.redZone,
        fingerprint: teamsData.teams[team].fingerprint,
      };
    },
  };
})();

// Register providers in priority order. A future analytics provider appends here.
const PROVIDERS = [vendoredProvider];

export const footballData = {
  async ready() {
    const oks = await Promise.all(PROVIDERS.map((p) => p.ready()));
    return oks.some(Boolean);
  },
  meta() { return vendoredProvider.meta(); },
  // Union of teams across providers.
  getTeams() {
    const set = new Set();
    for (const p of PROVIDERS) for (const t of p.teams()) set.add(t);
    return [...set].sort();
  },
  // First provider with data wins as the base; later providers overlay (so
  // Alex's analytics can add/override fields without breaking the mode).
  getTendencies(team, situation) {
    let out = null;
    for (const p of PROVIDERS) {
      const rows = p.lookup(team, situation);
      if (rows) out = out ? { ...out, ...rows, sources: [...(out.sources || []), p.id] } : { ...rows, sources: [p.id] };
    }
    return out;
  },
  // Same overlay contract for the DEFENDING team. Providers that don't do
  // defense simply omit lookupDefense and are skipped.
  getDefenseTendencies(team, situation) {
    let out = null;
    for (const p of PROVIDERS) {
      if (typeof p.lookupDefense !== "function") continue;
      const rows = p.lookupDefense(team, situation);
      if (rows) out = out ? { ...out, ...rows, sources: [...(out.sources || []), p.id] } : { ...rows, sources: [p.id] };
    }
    return out;
  },

  // ---- formatting helpers (kept here so both prompt + card stay consistent) ----

  // A compact block injected into the model prompt so the read cites real numbers.
  formatForPrompt(tend) {
    if (!tend) return "";
    const L = [];
    L.push(`Real tendency data for ${tend.team} (source: ${tend.source}, ${tend.meta.seasons.join("-")}, season-to-date, not a prediction):`);
    const o = tend.overall, lo = tend.leagueOverall;
    L.push(`- Overall: pass ${pct(o.passRate)} (league ${pct(lo && lo.passRate)}), shotgun ${pct(o.shotgun)}, early-down pass ${pct(o.earlyDownPass)}, EPA/play ${signed(o.epa)}.`);
    if (tend.dd) L.push(`- This down & distance (${tend.ddKey.replace("|", " and ")}): pass ${pct(tend.dd.pass)} (league ${pct(tend.leagueDd && tend.leagueDd.pass)}), success ${pct(tend.dd.success)}, n=${tend.dd.n}.`);
    if (tend.zoneCell) L.push(`- In this field zone (${tend.zone}): pass ${pct(tend.zoneCell.pass)} (league ${pct(tend.leagueZone && tend.leagueZone.pass)}), n=${tend.zoneCell.n}.`);
    if (tend.thirdDown && tend.thirdDown.n) L.push(`- Third down overall: converts ${pct(tend.thirdDown.convRate)}, passes ${pct(tend.thirdDown.passRate)}.`);
    if (tend.personnel) L.push(`- Personnel usage: ${topGroupings(tend.personnel, 3).map(([g, r]) => `${g} personnel ${pct(r)}`).join(", ")}.`);
    else L.push("- Personnel/formation: n/a for these seasons (participation data unavailable).");
    const fp = tend.fingerprint && tend.fingerprint.offense;
    if (fp) L.push(`- Scheme fingerprint (data-derived): shotgun ${pct(fp.shotgun)}, early-down pass ${pct(fp.earlyDownPass)}, ` +
      `no-huddle ${pct(fp.noHuddle)}, base personnel ${fp.topPersonnel || "n/a"}, EPA/play ${signed(fp.epa)}.`);
    L.push("Cite the specific numbers. Every '(league X%)' is the LEAGUE average — compare the team to that, " +
      "not to its own rate. Frame as what this team USUALLY does here, never a guaranteed call.");
    return L.join("\n");
  },

  // ---- INSTANT READ: composed from the numbers, NO model call ----
  // The tendency tables already contain the read; making a 7B model do lookups
  // and arithmetic on the hot path is what cost ~a minute. This assembles a
  // short speakable line in microseconds so it can be spoken before the snap.
  instantRead(tend, dTend, sit) {
    if (!tend && !dTend) return null;
    const MIN_N = 25;
    const dd = `${ordinalDown(sit.down)} and ${sit.distance === 0 ? "goal" : sit.distance}`;
    const sentences = [];
    const numbers = [];
    const deviations = [];   // {size, text} — biggest one becomes the "tell"
    let lean = null;         // "pass" | "run" — the data's direction; the call the model must not flip

    // --- offense: situational pass/run rate + league rank ---
    if (tend && tend.dd && tend.dd.n >= MIN_N) {
      const p = tend.dd.pass, lg = tend.leagueDd && tend.leagueDd.pass;
      const r = vendoredProvider.rankPass(tend.team, tend.ddKey);
      const rankTxt = r ? `, ${ordinal(r.rank)} in the league` : "";
      lean = p >= 0.5 ? "pass" : "run";
      if (p >= 0.5) sentences.push(`${tend.team} passes ${pct(p)} on ${dd}${rankTxt}.`);
      else sentences.push(`${tend.team} runs ${pct(1 - p)} on ${dd}${rankTxt}.`);
      numbers.push(`${tend.team} pass ${pct(p)} (lg ${pct(lg)})${r ? ` · #${r.rank}` : ""}`);
      if (lg != null) deviations.push({
        size: Math.abs(p - lg),
        text: p > lg ? `they throw it more than most teams here` : `they lean run here more than most`,
        cue: p > lg ? "expect the pass" : "expect the run",
      });
    } else if (tend && tend.overall) {
      lean = tend.overall.passRate >= 0.5 ? "pass" : "run";
      sentences.push(`${tend.team} passes ${pct(tend.overall.passRate)} overall.`);
      numbers.push(`${tend.team} pass ${pct(tend.overall.passRate)} overall`);
    }

    // --- defense: blitz/pressure for this exact down & distance ---
    if (dTend) {
      const bDD = dTend.blitzDD, o = dTend.overall, lo = dTend.leagueOverall;
      const blitz = bDD && bDD.n >= MIN_N ? bDD.blitz : o.blitzRate;
      const lgBlitz = bDD && bDD.n >= MIN_N && dTend.leagueBlitzDD ? dTend.leagueBlitzDD.blitz
        : (lo && lo.blitzRate);
      if (blitz != null) {
        const where = bDD && bDD.n >= MIN_N ? `on ${dd}` : "overall";
        const rk = vendoredProvider.rankBlitz(dTend.team);
        sentences.push(`${dTend.team} blitz ${pct(blitz)} ${where}${rk && rk.rank <= 8 ? " — one of the highest rates in the league" : rk && rk.rank >= 25 ? " — one of the lowest" : ""}.`);
        numbers.push(`${dTend.team} blitz ${pct(blitz)} (lg ${pct(lgBlitz)})`);
        if (lgBlitz != null) deviations.push({
          size: Math.abs(blitz - lgBlitz),
          text: blitz > lgBlitz ? `${dTend.team} blitz well above average here` : `${dTend.team} rarely blitz here`,
          cue: blitz > lgBlitz ? "watch for the hot route" : "the quarterback should have time",
        });
      }
      if (o && o.pressureRate != null) numbers.push(`pressure ${pct(o.pressureRate)} · sack ${pct(o.sackRate)}`);
    }

    // --- the tell: biggest deviation from league average ---
    deviations.sort((a, b) => b.size - a.size);
    const tell = deviations[0];
    if (tell && tell.size >= 0.04) sentences.push(`${cap(tell.text)} — ${tell.cue}.`);

    if (!sentences.length) return null;
    return { line: sentences.join(" "), numbers, tell: tell ? tell.text : null, lean };
  },

  // A trimmed prompt block for the OPTIONAL "more detail" model call — only the
  // 2-3 rows that matter, so the model isn't re-reading whole team tables.
  formatBriefForPrompt(tend, dTend, sit) {
    const L = [];
    const dd = `${ordinalDown(sit.down)} and ${sit.distance === 0 ? "goal" : sit.distance}`;
    L.push(`Situation: ${dd}, ${sit.zone.replace(/-/g, " ")}.`);
    if (tend && tend.dd) L.push(`${tend.team} offense here: pass ${pct(tend.dd.pass)} (league ${pct(tend.leagueDd && tend.leagueDd.pass)}), n=${tend.dd.n}.`);
    if (tend && tend.fingerprint) L.push(`${tend.team} identity: shotgun ${pct(tend.fingerprint.offense.shotgun)}, base personnel ${tend.fingerprint.offense.topPersonnel || "n/a"}.`);
    if (dTend) {
      const b = dTend.blitzDD || {};
      L.push(`${dTend.team} defense: blitz ${pct(b.blitz != null ? b.blitz : dTend.overall.blitzRate)} ` +
        `(league ${pct(dTend.leagueOverall && dTend.leagueOverall.blitzRate)}), pressure ${pct(dTend.overall.pressureRate)}.`);
    }
    L.push("Coverage shells: n/a (not in public data) — never state one as fact.");
    return L.join("\n");
  },

  // The DEFENDING team's block for the prompt, so the read can say "the Giants
  // blitz 37%, well above average". Coverage is explicitly n/a, never invented.
  formatDefenseForPrompt(d) {
    if (!d) return "";
    const L = [];
    const o = d.overall, lo = d.leagueOverall;
    L.push(`Real tendency data for the ${d.team} DEFENSE (same source and seasons):`);
    L.push(`- Pressure identity: blitz ${pct(o.blitzRate)} of dropbacks (league ${pct(lo && lo.blitzRate)}), ` +
      `pressure ${pct(o.pressureRate)} (league ${pct(lo && lo.pressureRate)}), sack ${pct(o.sackRate)}, ` +
      `avg box ${o.boxAvg == null ? "n/a" : o.boxAvg.toFixed(1)}.`);
    if (d.blitzDD) L.push(`- Blitz on this exact down & distance (${d.ddKey.replace("|", " and ")}): ` +
      `${pct(d.blitzDD.blitz)} (league ${pct(d.leagueBlitzDD && d.leagueBlitzDD.blitz)}), n=${d.blitzDD.n}.`);
    if (d.dd) L.push(`- Allowed here: opponents pass ${pct(d.dd.passFaced)}, EPA allowed ${signed(d.dd.epaAllowed)}, ` +
      `success allowed ${pct(d.dd.successAllowed)}, n=${d.dd.n}.`);
    if (d.thirdDown && d.thirdDown.n) L.push(`- Third-down stop rate: ${pct(d.thirdDown.stopRate)}.`);
    if (d.redZone && d.redZone.n) L.push(`- Red-zone defense: EPA allowed ${signed(d.redZone.epaAllowed)}, n=${d.redZone.n}.`);
    L.push("- Coverage shells (Cover 1/2/3 etc.): n/a — not in public data. Do NOT state what coverage they run as fact.");
    return L.join("\n");
  },

  // Two or three defense numbers for the card.
  defenseCardLines(d) {
    if (!d) return [];
    const o = d.overall;
    const lines = [`${d.team} D: blitz ${pct(o.blitzRate)} · pressure ${pct(o.pressureRate)} · sack ${pct(o.sackRate)}`];
    if (d.blitzDD) lines.push(`Blitz on ${d.ddKey.replace("|", " & ")}: ${pct(d.blitzDD.blitz)} · league ${pct(d.leagueBlitzDD && d.leagueBlitzDD.blitz)}`);
    if (d.thirdDown && d.thirdDown.stopRate != null) lines.push(`3rd-down stop: ${pct(d.thirdDown.stopRate)}`);
    lines.push("Coverage: n/a (public data)");
    return lines;
  },

  // A couple of raw numbers to show on the card (readable without the model).
  cardLines(tend) {
    if (!tend) return [];
    const lines = [];
    if (tend.dd) lines.push(`This spot (${tend.ddKey.replace("|", " & ")}): ${pct(tend.dd.pass)} pass · league ${pct(tend.leagueDd && tend.leagueDd.pass)}`);
    lines.push(`${tend.team} overall: ${pct(tend.overall.passRate)} pass · ${pct(tend.overall.shotgun)} shotgun · early-down ${pct(tend.overall.earlyDownPass)} pass`);
    if (tend.personnel) lines.push(`Personnel: ${topGroupings(tend.personnel, 3).map(([g, r]) => `${g} ${pct(r)}`).join(" · ")}`);
    return lines;
  },
};

export default footballData;
