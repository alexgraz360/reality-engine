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
//     lookup(team, situation): object|null  // raw rows for this team+situation
//   }
// situation: { down, distance, zone }  (distance in yards; zone = app zone id)
//
// All data is vendored/offline — no network, no secrets. Honesty: these are
// season-to-date historical tendencies, not a prediction.

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
    L.push("Cite the specific numbers and how they compare to league average; frame as what this team USUALLY does here, never a guaranteed call.");
    return L.join("\n");
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
