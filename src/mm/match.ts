import type { OddsEvent, Outcome } from "../types";

/** Built-in aliases (normalised form -> canonical normalised form). Extend via config.aliases. */
const BUILTIN_ALIASES: Record<string, string> = {
  "man utd": "manchester united",
  "man united": "manchester united",
  "manchester utd": "manchester united",
  "man city": "manchester city",
  "spurs": "tottenham hotspur",
  "tottenham": "tottenham hotspur",
  "wolves": "wolverhampton wanderers",
  "wolverhampton": "wolverhampton wanderers",
  "newcastle": "newcastle united",
  "west ham": "west ham united",
  "brighton": "brighton and hove albion",
  "brighton hove albion": "brighton and hove albion",
  "nottm forest": "nottingham forest",
  "forest": "nottingham forest",
  "leeds": "leeds united",
  "sheff utd": "sheffield united",
  "psg": "paris saint germain",
  "paris sg": "paris saint germain",
  "paris saint-germain": "paris saint germain",
  "atletico": "atletico madrid",
  "atletico de madrid": "atletico madrid",
  "athletic bilbao": "athletic club",
  "real sociedad": "real sociedad",
  "inter": "inter milan",
  "internazionale": "inter milan",
  "fc internazionale milano": "inter milan",
  "milan": "ac milan",
  "juve": "juventus",
  "bayern": "bayern munich",
  "bayern munchen": "bayern munich",
  "fc bayern munchen": "bayern munich",
  "dortmund": "borussia dortmund",
  "bvb": "borussia dortmund",
  "gladbach": "borussia monchengladbach",
  "leverkusen": "bayer leverkusen",
  "rb leipzig": "rb leipzig",
  "barca": "barcelona",
  "fc barcelona": "barcelona",
  "real": "real madrid",
  "sporting": "sporting cp",
  "sporting lisbon": "sporting cp",
};

const STOPWORDS = new Set(["fc", "afc", "cf", "sc", "ac", "club", "the", "de", "of", "ssc", "us", "as", "ss", "cd", "ud", "sv", "vfb", "vfl", "tsg", "fsv", "bsc", "1", "1899", "04", "05"]);

export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function applyAliases(norm: string, aliases: Record<string, string>): string {
  const merged = { ...BUILTIN_ALIASES, ...normalizeAliasMap(aliases) };
  if (merged[norm]) return merged[norm] as string;
  // replace multi-word aliases inside longer text (longest first)
  let out = norm;
  const keys = Object.keys(merged).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const re = new RegExp(`(^|\\s)${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`, "g");
    out = out.replace(re, `$1${merged[k]}`);
  }
  return out;
}

const aliasCache = new WeakMap<Record<string, string>, Record<string, string>>();
function normalizeAliasMap(aliases: Record<string, string>): Record<string, string> {
  const cached = aliasCache.get(aliases);
  if (cached) return cached;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(aliases)) out[normalizeName(k)] = normalizeName(v);
  aliasCache.set(aliases, out);
  return out;
}

export function significantTokens(name: string, aliases: Record<string, string> = {}): string[] {
  const norm = applyAliases(normalizeName(name), aliases);
  return norm.split(" ").filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** True when `text` mentions `team` (alias-aware, tolerant of club suffixes). */
export function teamMatches(team: string, text: string, aliases: Record<string, string> = {}): boolean {
  const t = applyAliases(normalizeName(text), aliases);
  const n = applyAliases(normalizeName(team), aliases);
  if (!n) return false;
  if (` ${t} `.includes(` ${n} `)) return true;
  const toks = significantTokens(team, aliases);
  if (toks.length === 0) return false;
  const words = new Set(t.split(" "));
  // every significant token must appear ("Manchester United" must not match "Manchester City");
  // short forms such as "Man Utd" or "Spurs" are handled through the alias table.
  return toks.every((tok) => words.has(tok));
}

export interface EventMatch {
  event: OddsEvent;
  score: number;
}

/**
 * Rank odds events against a predict.fun market text (title + question + category).
 * Score: both teams found = 2, one team = 1; later kickoff tie-break prefers the
 * event closest to `preferTime` (if given) and otherwise the soonest kickoff.
 */
export function rankEvents(text: string, events: OddsEvent[], aliases: Record<string, string>, preferTime?: number): EventMatch[] {
  const scored: EventMatch[] = [];
  for (const ev of events) {
    const h = teamMatches(ev.homeTeam, text, aliases);
    const a = teamMatches(ev.awayTeam, text, aliases);
    const score = (h ? 1 : 0) + (a ? 1 : 0);
    if (score > 0) scored.push({ event: ev, score });
  }
  scored.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    if (preferTime !== undefined) return Math.abs(x.event.commenceTime - preferTime) - Math.abs(y.event.commenceTime - preferTime);
    return x.event.commenceTime - y.event.commenceTime;
  });
  return scored;
}

/** Detect which 1X2 outcome a market title refers to. */
export function detectOutcome(text: string, teams: { home: string; away: string }, aliases: Record<string, string> = {}): Outcome | undefined {
  const norm = applyAliases(normalizeName(text), aliases);
  if (/\bdraw\b/.test(norm) || /平局|打平/.test(text)) return "draw";
  const h = teamMatches(teams.home, norm, aliases);
  const a = teamMatches(teams.away, norm, aliases);
  if (h && !a) return "home";
  if (a && !h) return "away";
  if (h && a) {
    // "X vs Y: X to win" / "Will X win" -> look at the team mentioned right before "win"
    const winIdx = norm.search(/\b(win|wins|to win|victory|beat|beats)\b/);
    if (winIdx >= 0) {
      const before = norm.slice(0, winIdx);
      const hPos = lastIndexOfTeam(before, teams.home, aliases);
      const aPos = lastIndexOfTeam(before, teams.away, aliases);
      if (hPos >= 0 && hPos > aPos) return "home";
      if (aPos >= 0 && aPos > hPos) return "away";
    }
    const willIdx = norm.indexOf("will ");
    if (willIdx >= 0) {
      const after = norm.slice(willIdx + 5);
      const hPos = indexOfTeam(after, teams.home, aliases);
      const aPos = indexOfTeam(after, teams.away, aliases);
      if (hPos >= 0 && (aPos < 0 || hPos < aPos)) return "home";
      if (aPos >= 0 && (hPos < 0 || aPos < hPos)) return "away";
    }
  }
  return undefined;
}

function indexOfTeam(norm: string, team: string, aliases: Record<string, string>): number {
  for (const tok of significantTokens(team, aliases).sort((a, b) => b.length - a.length)) {
    const i = norm.indexOf(tok);
    if (i >= 0) return i;
  }
  return -1;
}

function lastIndexOfTeam(norm: string, team: string, aliases: Record<string, string>): number {
  let best = -1;
  for (const tok of significantTokens(team, aliases)) {
    const i = norm.lastIndexOf(tok);
    if (i > best) best = i;
  }
  return best;
}
