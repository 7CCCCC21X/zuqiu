import { requestJson } from "../util/http";
import { log } from "../logger";
import type { BookmakerOdds, OddsEvent } from "../types";

const BASE = "https://api.the-odds-api.com/v4";

export interface OddsCredits {
  remaining?: number;
  used?: number;
  lastCost?: number;
  updatedAt: number;
}

export interface SportInfo {
  key: string;
  group: string;
  title: string;
  description: string;
  active: boolean;
  has_outrights: boolean;
}

interface RawOutcome { name: string; price: number; point?: number }
interface RawMarket { key: string; last_update?: string; outcomes: RawOutcome[] }
interface RawBookmaker { key: string; title: string; last_update: string; markets: RawMarket[] }
interface RawEvent {
  id: string;
  sport_key: string;
  sport_title?: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: RawBookmaker[];
}

export class OddsApi {
  credits: OddsCredits = { updatedAt: 0 };

  constructor(private readonly apiKey: string) {}

  async listSports(all = false): Promise<SportInfo[]> {
    const url = `${BASE}/sports/?apiKey=${encodeURIComponent(this.apiKey)}${all ? "&all=true" : ""}`;
    const res = await requestJson<SportInfo[]>(url, { quiet: true });
    this.readCredits(res.headers);
    return res.data;
  }

  /**
   * Fetch 1X2 (h2h) odds for one sport. Exchanges also return their lay prices
   * (h2h_lay) alongside h2h at no extra credit cost.
   * Cost: 1 credit per call for up to 10 bookmakers (1 market).
   */
  async fetchH2H(sportKey: string, bookmakers: string[], eventIds?: string[], regions?: string): Promise<OddsEvent[]> {
    const params = new URLSearchParams({
      apiKey: this.apiKey,
      markets: "h2h,h2h_lay",
      oddsFormat: "decimal",
      dateFormat: "iso",
    });
    if (bookmakers.length > 0) params.set("bookmakers", bookmakers.join(","));
    else params.set("regions", regions ?? "eu");
    if (eventIds && eventIds.length > 0) params.set("eventIds", eventIds.join(","));
    const url = `${BASE}/sports/${encodeURIComponent(sportKey)}/odds?${params.toString()}`;
    let res;
    try {
      res = await requestJson<RawEvent[]>(url, { quiet: true, timeoutMs: 15_000 });
    } catch (e) {
      // Some plans reject unknown market keys; retry with plain h2h.
      const msg = (e as Error).message;
      if (/h2h_lay|INVALID_MARKET/i.test(msg)) {
        params.set("markets", "h2h");
        const url2 = `${BASE}/sports/${encodeURIComponent(sportKey)}/odds?${params.toString()}`;
        res = await requestJson<RawEvent[]>(url2, { quiet: true, timeoutMs: 15_000 });
      } else {
        throw e;
      }
    }
    this.readCredits(res.headers);
    const fetchedAt = Date.now();
    const events = (res.data ?? []).map((ev) => parseEvent(ev, fetchedAt)).filter((e): e is OddsEvent => e !== null);
    log.debug(`odds: ${sportKey} ${events.length} events, credits remaining=${this.credits.remaining ?? "?"} last=${this.credits.lastCost ?? "?"}`);
    return events;
  }

  private readCredits(headers: Headers): void {
    const rem = headers.get("x-requests-remaining");
    const used = headers.get("x-requests-used");
    const last = headers.get("x-requests-last");
    this.credits = {
      remaining: rem !== null ? Number.parseInt(rem, 10) : this.credits.remaining,
      used: used !== null ? Number.parseInt(used, 10) : this.credits.used,
      lastCost: last !== null ? Number.parseInt(last, 10) : this.credits.lastCost,
      updatedAt: Date.now(),
    };
  }
}

function parseEvent(ev: RawEvent, fetchedAt: number): OddsEvent | null {
  const commence = Date.parse(ev.commence_time);
  if (!Number.isFinite(commence)) return null;
  const books: BookmakerOdds[] = [];
  for (const bm of ev.bookmakers ?? []) {
    const h2h = bm.markets.find((m) => m.key === "h2h");
    if (!h2h) continue;
    const back = mapOutcomes(h2h.outcomes, ev.home_team, ev.away_team);
    if (!back) continue;
    const layMarket = bm.markets.find((m) => m.key === "h2h_lay");
    const lay = layMarket ? mapOutcomes(layMarket.outcomes, ev.home_team, ev.away_team) : undefined;
    const lastUpdate = Date.parse(h2h.last_update ?? bm.last_update);
    books.push({
      key: bm.key,
      title: bm.title,
      lastUpdate: Number.isFinite(lastUpdate) ? lastUpdate : fetchedAt,
      back,
      ...(lay ? { lay } : {}),
    });
  }
  return {
    id: ev.id,
    sportKey: ev.sport_key,
    commenceTime: commence,
    homeTeam: ev.home_team,
    awayTeam: ev.away_team,
    bookmakers: books,
    fetchedAt,
  };
}

function mapOutcomes(outcomes: RawOutcome[], home: string, away: string): { home: number; draw: number; away: number } | null {
  let h: number | undefined;
  let d: number | undefined;
  let a: number | undefined;
  for (const o of outcomes) {
    if (!(o.price > 1)) continue;
    if (o.name === home) h = o.price;
    else if (o.name === away) a = o.price;
    else if (/^draw$/i.test(o.name)) d = o.price;
  }
  if (h === undefined || d === undefined || a === undefined) return null;
  return { home: h, draw: d, away: a };
}
