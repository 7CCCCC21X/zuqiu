import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "./engine";
import { CONFIG_DEFAULTS } from "../config";
import { Journal } from "../store/journal";
import { setLogLevel } from "../logger";
import { devigMultiplicative } from "../odds/fair";
import type { Book, Config, OddsEvent, PredictMarketInfo } from "../types";
import type { PredictApi } from "../predict/api";
import type { OddsApi } from "../odds/oddsApi";

setLogLevel("error");

function market(id: number): PredictMarketInfo {
  return {
    id, title: "Arsenal vs Chelsea: Will Arsenal win?", question: "Will Arsenal win?", conditionId: "0xcond", status: "OPEN",
    categorySlug: "arsenal-vs-chelsea", isNegRisk: false, isYieldBearing: false, feeRateBps: 0,
    yesTokenId: "111", noTokenId: "222", yesIndexSet: 1, noIndexSet: 2, raw: { outcomes: [{ name: "Yes", indexSet: 1, onChainId: "111" }, { name: "No", indexSet: 2, onChainId: "222" }] },
  };
}

function makeEvent(commenceTime: number, homeOdds = 1.667, drawOdds = 4.0, awayOdds = 5.0): OddsEvent {
  const now = Date.now();
  return {
    id: "ev1", sportKey: "soccer_epl", commenceTime, homeTeam: "Arsenal", awayTeam: "Chelsea", fetchedAt: now,
    bookmakers: [
      { key: "pinnacle", title: "Pinnacle", lastUpdate: now, back: { home: homeOdds, draw: drawOdds, away: awayOdds } },
      { key: "betfair_ex_eu", title: "Betfair", lastUpdate: now, back: { home: homeOdds, draw: drawOdds, away: awayOdds }, lay: { home: homeOdds * 1.02, draw: drawOdds * 1.03, away: awayOdds * 1.03 } },
    ],
  };
}

interface Harness {
  engine: Engine;
  book: Book;
  event: OddsEvent;
  cfg: Config;
  dir: string;
}

function harness(overrides: Partial<Config> = {}, commence = Date.now() + 5 * 3600_000): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-test-"));
  const cfg: Config = {
    ...structuredClone(CONFIG_DEFAULTS),
    dryRun: true,
    dataDir: dir,
    poly: { ...CONFIG_DEFAULTS.poly, enabled: false },
    ws: { enabled: false },
    odds: { ...CONFIG_DEFAULTS.odds, refreshSec: 0 },
    predict: { ...CONFIG_DEFAULTS.predict, pollBookSec: 0, pollOrdersSec: 0 },
    markets: [{ predictMarketId: 1, outcome: "home", oddsSport: "soccer_epl", teams: { home: "Arsenal", away: "Chelsea" } }],
    ...overrides,
  };
  const h: Partial<Harness> = { cfg, dir };
  h.book = { marketId: 1, ts: Date.now(), bids: [[0.55, 100]], asks: [[0.65, 100]] };
  h.event = makeEvent(commence);
  const api = {
    getMarket: async (id: number) => market(id),
    getOrderbook: async () => ({ ...(h.book as Book), ts: Date.now() }),
    getOpenOrders: async () => [],
    getPositions: async () => [],
    getOrder: async () => null,
  } as unknown as PredictApi;
  const odds = {
    credits: { updatedAt: 0 },
    fetchH2H: async () => [{ ...(h.event as OddsEvent), fetchedAt: Date.now() }],
  } as unknown as OddsApi;
  h.engine = new Engine(cfg, {}, { api, trader: null, odds, poly: null, ws: null, journal: new Journal(dir) });
  return h as Harness;
}

test("dry run: quotes both sides below fair, fills on crossing, merges pairs", async () => {
  const h = harness();
  await h.engine.init();
  await h.engine.step();
  let st = h.engine.states()[0]!;
  assert.equal(st.mode, "quoting");
  assert.ok(st.fair?.ok);
  const fair = st.fair!.p;
  const expected = devigMultiplicative({ home: 1.667, draw: 4.0, away: 5.0 }).home; // both fake sources agree -> ~0.572
  assert.ok(Math.abs(fair - expected) < 0.01, `fair ${fair} vs ${expected}`);
  const yes = st.orders.find((o) => o.token === "YES" && o.action === "BUY");
  const no = st.orders.find((o) => o.token === "NO" && o.action === "BUY");
  assert.ok(yes && no, "two bids expected");
  assert.ok(yes.price <= fair - 0.015 + 1e-9);
  assert.ok(no.price <= 1 - fair - 0.015 + 1e-9);
  assert.ok(yes.qty * yes.price <= 20 && no.qty * no.price <= 20);

  // the YES ask trades down through our bid -> YES fills
  h.book.asks = [[yes.price, 50]];
  await h.engine.step();
  st = h.engine.states()[0]!;
  assert.equal(st.inv.yesQty, yes.qty);
  const yesBids = st.orders.filter((o) => o.token === "YES" && o.action === "BUY");
  assert.ok(!yesBids.some((o) => o.id === yes.id), "the filled bid is gone");
  for (const o of yesBids) assert.ok(o.price < yes.price, "a re-placed heavy-side bid must back off");
  // heavy side is offered above fair, light side still bid
  assert.ok(st.orders.some((o) => o.token === "YES" && o.action === "SELL" && o.price >= fair + 0.005));
  const noBid = st.orders.find((o) => o.token === "NO" && o.action === "BUY");
  assert.ok(noBid && noBid.price <= 1 - fair - 0.005 + 1e-9, "never bid through fair when completing pairs");

  // now the YES bid side rises so our NO bid (a YES ask at 1-p) gets lifted -> NO fills
  h.book.asks = [[0.65, 100]];
  h.book.bids = [[1 - noBid.price, 100]];
  await h.engine.step();
  st = h.engine.states()[0]!;
  assert.ok(st.inv.noQty > 0, "NO should be filled");
  // pairs merged in the same step (minShares 10), spread realised
  const pairs = Math.min(yes.qty, noBid.qty);
  assert.ok(st.inv.mergedPairs >= pairs - 0.01, `merged ${st.inv.mergedPairs} expected ${pairs}`);
  const expectedPnl = pairs * (1 - yes.price - noBid.price);
  assert.ok(Math.abs(st.inv.realizedPnl - expectedPnl) < 0.05, `pnl ${st.inv.realizedPnl} vs ${expectedPnl}`);
  assert.ok(st.realizedToday > 0);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("daily stop cancels orders when the fair value moves against inventory", async () => {
  const h = harness({ risk: { ...CONFIG_DEFAULTS.risk, dailyStopLossUsd: 1 } });
  await h.engine.init();
  await h.engine.step();
  const yes = h.engine.states()[0]!.orders.find((o) => o.token === "YES" && o.action === "BUY")!;
  h.book.asks = [[yes.price, 50]];
  await h.engine.step(); // YES filled, about 25 shares
  // odds collapse: home now ~0.40 -> our YES inventory marked well below cost
  h.event = makeEvent(h.event.commenceTime, 2.5, 3.6, 2.9);
  h.book = { marketId: 1, ts: Date.now(), bids: [[0.38, 100]], asks: [[0.42, 100]] };
  await h.engine.step();
  const st = h.engine.states()[0]!;
  assert.equal(st.stopped, true);
  assert.equal(st.mode, "paused");
  assert.equal(st.orders.length, 0, "all orders cancelled after the stop");
  assert.ok(st.inv.yesQty > 0, "positions are kept");
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("exit window: no bids, unpaired inventory is sold near the best bid", async () => {
  const h = harness();
  await h.engine.init();
  await h.engine.step();
  const yes = h.engine.states()[0]!.orders.find((o) => o.token === "YES" && o.action === "BUY")!;
  h.book.asks = [[yes.price, 50]];
  await h.engine.step(); // YES inventory
  h.event = { ...h.event, commenceTime: Date.now() + 1 * 3600_000 }; // inside the 2h exit window
  h.book = { marketId: 1, ts: Date.now(), bids: [[0.57, 100]], asks: [[0.61, 100]] };
  await h.engine.step();
  const st = h.engine.states()[0]!;
  assert.equal(st.mode, "exiting");
  assert.equal(st.orders.filter((o) => o.action === "BUY").length, 0);
  const sell = st.orders.find((o) => o.action === "SELL" && o.token === "YES");
  assert.ok(sell, "exit sell expected");
  assert.equal(sell.price, 0.57); // best bid is within exitMaxSlippage of fair -> take it
  assert.ok(Math.abs(sell.qty - st.inv.yesQty) < 0.011);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("market is paused (and bids pulled) when the odds sources disagree", async () => {
  const h = harness();
  await h.engine.init();
  await h.engine.step();
  assert.equal(h.engine.states()[0]!.orders.length, 2);
  const ev = h.event;
  ev.bookmakers[1]!.back = { home: 2.6, draw: 3.6, away: 2.8 }; // betfair now says 0.39 vs pinnacle 0.60
  ev.bookmakers[1]!.lay = { home: 2.7, draw: 3.7, away: 2.9 };
  await h.engine.step();
  const st = h.engine.states()[0]!;
  assert.equal(st.mode, "paused");
  assert.match(st.pauseReason ?? "", /disagree/);
  assert.equal(st.orders.length, 0);
  fs.rmSync(h.dir, { recursive: true, force: true });
});
