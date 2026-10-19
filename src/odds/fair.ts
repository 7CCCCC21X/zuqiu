import type { BookmakerOdds, FairEstimate, OddsEvent, Outcome, SourceProbability } from "../types";

export type Probs = { home: number; draw: number; away: number };
export type Odds = { home: number; draw: number; away: number };

const KEYS: Outcome[] = ["home", "draw", "away"];

export function implied(odds: Odds): Probs {
  return { home: 1 / odds.home, draw: 1 / odds.draw, away: 1 / odds.away };
}

export function overround(odds: Odds): number {
  const p = implied(odds);
  return p.home + p.draw + p.away;
}

/** Proportional (multiplicative) de-vig: q_i = p_i / sum(p). */
export function devigMultiplicative(odds: Odds): Probs {
  const p = implied(odds);
  const s = p.home + p.draw + p.away;
  return { home: p.home / s, draw: p.draw / s, away: p.away / s };
}

/**
 * Power de-vig: find k >= 1 with sum(p_i^k) = 1. Removes more margin from
 * longshots than favourites (favourite-longshot bias). Falls back to
 * multiplicative when the book has no margin.
 */
export function devigPower(odds: Odds): Probs {
  const p = implied(odds);
  const total = p.home + p.draw + p.away;
  if (total <= 1) return devigMultiplicative(odds);
  let lo = 1;
  let hi = 20;
  const f = (k: number) => p.home ** k + p.draw ** k + p.away ** k - 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  const q = { home: p.home ** k, draw: p.draw ** k, away: p.away ** k };
  const s = q.home + q.draw + q.away;
  return { home: q.home / s, draw: q.draw / s, away: q.away / s };
}

/**
 * Exchange mid: average of back- and lay-implied probability per outcome,
 * then normalised. Returns the widest back/lay gap as `spread`.
 */
export function exchangeMid(back: Odds, lay: Odds): { p: Probs; spread: number } {
  const pb = implied(back);
  const pl = implied(lay);
  const raw = {
    home: (pb.home + pl.home) / 2,
    draw: (pb.draw + pl.draw) / 2,
    away: (pb.away + pl.away) / 2,
  };
  const s = raw.home + raw.draw + raw.away;
  const spread = Math.max(pb.home - pl.home, pb.draw - pl.draw, pb.away - pl.away);
  return { p: { home: raw.home / s, draw: raw.draw / s, away: raw.away / s }, spread: Math.max(0, spread) };
}

export interface FairOptions {
  weights: Record<string, number>;
  devig: "multiplicative" | "power";
  maxSourceAgeSec: number;
  maxExchangeSpread: number;
  now?: number;
}

export function sourceProbability(bm: BookmakerOdds, opts: FairOptions): SourceProbability {
  const now = opts.now ?? Date.now();
  const stale = now - bm.lastUpdate > opts.maxSourceAgeSec * 1000;
  let weight = opts.weights[bm.key] ?? 1;
  let p: Probs;
  let exchangeSpread: number | undefined;
  const hasLay = bm.lay && bm.lay.home > 1 && bm.lay.draw > 1 && bm.lay.away > 1;
  if (hasLay && bm.lay) {
    const r = exchangeMid(bm.back, bm.lay);
    p = r.p;
    exchangeSpread = r.spread;
    if (r.spread > opts.maxExchangeSpread) weight *= 0.5;
  } else {
    p = opts.devig === "power" ? devigPower(bm.back) : devigMultiplicative(bm.back);
  }
  return {
    key: bm.key,
    weight,
    p,
    lastUpdate: bm.lastUpdate,
    stale,
    overround: overround(bm.back),
    ...(exchangeSpread !== undefined ? { exchangeSpread } : {}),
  };
}

/** Combine all usable bookmakers of an event into one fair 1X2 estimate. */
export function combineFair(event: OddsEvent, opts: FairOptions): FairEstimate | null {
  const now = opts.now ?? Date.now();
  const sources = event.bookmakers.map((bm) => sourceProbability(bm, opts));
  const live = sources.filter((s) => !s.stale && s.weight > 0);
  if (live.length === 0) return null;
  const wsum = live.reduce((a, s) => a + s.weight, 0);
  const p: Probs = { home: 0, draw: 0, away: 0 };
  for (const s of live) {
    for (const k of KEYS) p[k] += (s.weight / wsum) * s.p[k];
  }
  const total = p.home + p.draw + p.away;
  for (const k of KEYS) p[k] /= total;
  const dispersion: Probs = { home: 0, draw: 0, away: 0 };
  for (const k of KEYS) {
    const vals = live.map((s) => s.p[k]);
    dispersion[k] = Math.max(...vals) - Math.min(...vals);
  }
  return { p, sources, dispersion, nSources: live.length, asOf: now };
}

export function pick(p: Probs, outcome: Outcome): number {
  return p[outcome];
}
