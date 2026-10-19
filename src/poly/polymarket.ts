import { requestJson, HttpError } from "../util/http";
import { log } from "../logger";
import type { Outcome } from "../types";
import { normalizeName, teamMatches } from "../mm/match";

export interface PolyMarket {
  id: string;
  question: string;
  slug: string;
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  outcomes: string[];
  outcomePrices: number[];
  active: boolean;
  closed: boolean;
  groupItemTitle?: string;
}

export interface PolyEvent {
  id: string;
  title: string;
  slug: string;
  startDate?: string;
  markets: PolyMarket[];
}

export interface PolyBookSummary {
  tokenId: string;
  bestBid?: number;
  bestAsk?: number;
  mid?: number;
  /** USD resting within `window` of the mid on each side */
  bidDepthUsd: number;
  askDepthUsd: number;
  ts: number;
}

function parseJsonArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeMarket(m: Record<string, unknown>): PolyMarket | null {
  const tokens = parseJsonArray(m.clobTokenIds).map(String);
  const outcomes = parseJsonArray(m.outcomes).map(String);
  if (tokens.length < 2) return null;
  const prices = parseJsonArray(m.outcomePrices).map((p) => Number.parseFloat(String(p)));
  let yesIdx = outcomes.findIndex((o) => /^yes$/i.test(o));
  if (yesIdx < 0) yesIdx = 0;
  const noIdx = yesIdx === 0 ? 1 : 0;
  return {
    id: String(m.id ?? ""),
    question: String(m.question ?? ""),
    slug: String(m.slug ?? ""),
    conditionId: String(m.conditionId ?? ""),
    yesTokenId: tokens[yesIdx] ?? tokens[0] ?? "",
    noTokenId: tokens[noIdx] ?? tokens[1] ?? "",
    outcomes,
    outcomePrices: prices,
    active: Boolean(m.active),
    closed: Boolean(m.closed),
    ...(typeof m.groupItemTitle === "string" ? { groupItemTitle: m.groupItemTitle } : {}),
  };
}

export class Polymarket {
  constructor(
    private readonly gammaBase: string,
    private readonly clobBase: string,
  ) {}

  async eventBySlug(slug: string): Promise<PolyEvent | null> {
    const res = await requestJson<Array<Record<string, unknown>>>(`${this.gammaBase}/events?slug=${encodeURIComponent(slug)}`);
    const ev = res.data?.[0];
    if (!ev) return null;
    const markets = (Array.isArray(ev.markets) ? ev.markets : [])
      .map((m) => normalizeMarket(m as Record<string, unknown>))
      .filter((m): m is PolyMarket => m !== null);
    return {
      id: String(ev.id ?? ""),
      title: String(ev.title ?? ""),
      slug: String(ev.slug ?? slug),
      ...(typeof ev.startDate === "string" ? { startDate: ev.startDate } : {}),
      markets,
    };
  }

  /** Best-effort free-text search for events (used by the `poly-find` command). */
  async search(query: string, limit = 10): Promise<Array<{ title: string; slug: string; startDate?: string }>> {
    try {
      const res = await requestJson<Record<string, unknown>>(`${this.gammaBase}/public-search?q=${encodeURIComponent(query)}&limit_per_type=${limit}`);
      const events = (res.data?.events as Array<Record<string, unknown>> | undefined) ?? [];
      return events.map((e) => ({
        title: String(e.title ?? ""),
        slug: String(e.slug ?? ""),
        ...(typeof e.startDate === "string" ? { startDate: e.startDate } : {}),
      }));
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 404) log.warn(`poly public-search failed: ${(e as Error).message}`);
    }
    const res = await requestJson<Array<Record<string, unknown>>>(
      `${this.gammaBase}/events?active=true&closed=false&limit=500&order=startDate&ascending=true`,
    );
    const tokens = normalizeName(query).split(" ").filter(Boolean);
    return (res.data ?? [])
      .filter((e) => {
        const t = normalizeName(String(e.title ?? ""));
        return tokens.every((tok) => t.includes(tok));
      })
      .slice(0, limit)
      .map((e) => ({
        title: String(e.title ?? ""),
        slug: String(e.slug ?? ""),
        ...(typeof e.startDate === "string" ? { startDate: e.startDate } : {}),
      }));
  }

  /**
   * Pick the market inside an event that corresponds to the configured
   * outcome (home / draw / away) of a football match.
   */
  static pickMarket(
    ev: PolyEvent,
    outcome: Outcome,
    teams: { home: string; away: string } | undefined,
    questionHint: string | undefined,
    aliases: Record<string, string>,
  ): PolyMarket | null {
    const open = ev.markets.filter((m) => !m.closed);
    if (questionHint) {
      const hint = normalizeName(questionHint);
      const hit = open.find((m) => normalizeName(m.question).includes(hint) || normalizeName(m.groupItemTitle ?? "").includes(hint));
      if (hit) return hit;
    }
    if (open.length === 1 && outcome !== "draw") return open[0] ?? null;
    const label = (m: PolyMarket) => `${m.groupItemTitle ?? ""} ${m.question}`;
    if (outcome === "draw") {
      return open.find((m) => /\bdraw\b/i.test(label(m))) ?? null;
    }
    if (!teams) return null;
    const team = outcome === "home" ? teams.home : teams.away;
    const other = outcome === "home" ? teams.away : teams.home;
    const candidates = open.filter((m) => !/\bdraw\b/i.test(label(m)) && teamMatches(team, label(m), aliases));
    if (candidates.length === 1) return candidates[0] ?? null;
    // Multi-market events phrase every market with both teams; prefer the one
    // whose group title mentions only the wanted team.
    const strict = candidates.filter((m) => m.groupItemTitle && teamMatches(team, m.groupItemTitle, aliases) && !teamMatches(other, m.groupItemTitle, aliases));
    return strict[0] ?? candidates[0] ?? null;
  }

  async book(tokenId: string, depthWindow: number): Promise<PolyBookSummary> {
    const res = await requestJson<{ bids?: Array<{ price: string; size: string }>; asks?: Array<{ price: string; size: string }> }>(
      `${this.clobBase}/book?token_id=${encodeURIComponent(tokenId)}`,
    );
    const bids = (res.data?.bids ?? []).map((l) => [Number.parseFloat(l.price), Number.parseFloat(l.size)] as [number, number]).sort((a, b) => b[0] - a[0]);
    const asks = (res.data?.asks ?? []).map((l) => [Number.parseFloat(l.price), Number.parseFloat(l.size)] as [number, number]).sort((a, b) => a[0] - b[0]);
    const bestBid = bids[0]?.[0];
    const bestAsk = asks[0]?.[0];
    const mid = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : undefined;
    let bidDepthUsd = 0;
    let askDepthUsd = 0;
    if (mid !== undefined) {
      for (const [p, s] of bids) if (p >= mid - depthWindow) bidDepthUsd += p * s;
      for (const [p, s] of asks) if (p <= mid + depthWindow) askDepthUsd += p * s;
    }
    return {
      tokenId,
      ...(bestBid !== undefined ? { bestBid } : {}),
      ...(bestAsk !== undefined ? { bestAsk } : {}),
      ...(mid !== undefined ? { mid } : {}),
      bidDepthUsd,
      askDepthUsd,
      ts: Date.now(),
    };
  }
}
