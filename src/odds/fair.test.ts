import test from "node:test";
import assert from "node:assert/strict";
import { combineFair, devigMultiplicative, devigPower, exchangeMid, overround, sourceProbability } from "./fair";
import type { OddsEvent } from "../types";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("multiplicative devig sums to one and keeps ordering", () => {
  const q = devigMultiplicative({ home: 1.8, draw: 3.6, away: 4.5 });
  close(q.home + q.draw + q.away, 1);
  assert.ok(q.home > q.draw && q.draw > q.away);
  close(q.home, (1 / 1.8) / (1 / 1.8 + 1 / 3.6 + 1 / 4.5));
});

test("power devig sums to one and shades longshots more than favourites", () => {
  const odds = { home: 1.5, draw: 4.2, away: 7.0 };
  const m = devigMultiplicative(odds);
  const p = devigPower(odds);
  close(p.home + p.draw + p.away, 1);
  assert.ok(p.away < m.away, "longshot should be lower under power devig");
  assert.ok(p.home > m.home, "favourite should be higher under power devig");
  assert.ok(overround(odds) > 1);
});

test("power devig equals multiplicative for a fair book", () => {
  const odds = { home: 2, draw: 4, away: 4 }; // 0.5+0.25+0.25 = 1
  const m = devigMultiplicative(odds);
  const p = devigPower(odds);
  close(m.home, p.home);
  close(m.draw, p.draw);
});

test("exchange mid averages back and lay and reports spread", () => {
  const r = exchangeMid({ home: 2.0, draw: 3.5, away: 4.0 }, { home: 2.1, draw: 3.7, away: 4.3 });
  close(r.p.home + r.p.draw + r.p.away, 1);
  assert.ok(r.p.home > 0.47 && r.p.home < 0.5);
  assert.ok(r.spread > 0 && r.spread < 0.03);
});

test("combineFair weights sources, skips stale and halves wide exchanges", () => {
  const now = 1_000_000_000_000;
  const ev: OddsEvent = {
    id: "e1",
    sportKey: "soccer_epl",
    commenceTime: now + 3600_000,
    homeTeam: "A",
    awayTeam: "B",
    fetchedAt: now,
    bookmakers: [
      { key: "pinnacle", title: "Pinnacle", lastUpdate: now - 10_000, back: { home: 1.8, draw: 3.6, away: 4.5 } },
      { key: "betfair_ex_eu", title: "Betfair", lastUpdate: now - 10_000, back: { home: 1.85, draw: 3.6, away: 4.6 }, lay: { home: 1.9, draw: 3.75, away: 4.8 } },
      { key: "matchbook", title: "Matchbook", lastUpdate: now - 3600_000, back: { home: 1.1, draw: 9, away: 20 } }, // stale, must be ignored
    ],
  };
  const opts = { weights: { pinnacle: 0.5, betfair_ex_eu: 0.35, matchbook: 0.15 }, devig: "multiplicative" as const, maxSourceAgeSec: 900, maxExchangeSpread: 0.05, now };
  const fair = combineFair(ev, opts);
  assert.ok(fair);
  assert.equal(fair.nSources, 2);
  close(fair.p.home + fair.p.draw + fair.p.away, 1);
  assert.ok(fair.p.home > 0.5 && fair.p.home < 0.56, `home ${fair.p.home}`);
  assert.ok(fair.dispersion.home < 0.03);

  const wide = sourceProbability(
    { key: "betfair_ex_eu", title: "", lastUpdate: now, back: { home: 2.0, draw: 3.5, away: 4.0 }, lay: { home: 2.6, draw: 4.5, away: 5.5 } },
    opts,
  );
  close(wide.weight, 0.175);
  assert.ok((wide.exchangeSpread ?? 0) > 0.05);
});

test("combineFair returns null when every source is stale", () => {
  const now = 1_000_000_000_000;
  const ev: OddsEvent = {
    id: "e", sportKey: "s", commenceTime: now, homeTeam: "A", awayTeam: "B", fetchedAt: now,
    bookmakers: [{ key: "pinnacle", title: "", lastUpdate: now - 10_000_000, back: { home: 2, draw: 3, away: 4 } }],
  };
  assert.equal(combineFair(ev, { weights: {}, devig: "multiplicative", maxSourceAgeSec: 60, maxExchangeSpread: 0.05, now }), null);
});
