import test from "node:test";
import assert from "node:assert/strict";
import { bookTop, computeQuotes, orderMatchesQuote } from "./quoter";
import { applyFill, emptyInventory } from "./inventory";
import { CONFIG_DEFAULTS } from "../config";
import type { Book, LiveOrder } from "../types";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const book: Book = { marketId: 1, ts: 0, bids: [[0.57, 100], [0.55, 50]], asks: [[0.62, 80], [0.65, 30]] };

function base(overrides: Partial<Parameters<typeof computeQuotes>[0]> = {}) {
  return {
    fairYes: 0.6,
    book,
    inv: emptyInventory(),
    quote: { ...CONFIG_DEFAULTS.quote },
    maxUnpairedCost: 30,
    capitalAvailable: 300,
    maxOrderCost: 20,
    openOrders: [] as LiveOrder[],
    mode: "quoting" as const,
    exitMaxSlippage: 0.03,
    exitMode: "merge_and_sell" as const,
    ...overrides,
  };
}

test("bookTop mirrors YES book into NO prices", () => {
  const t = bookTop(book);
  close(t.bestBidYes ?? 0, 0.57);
  close(t.bestAskYes ?? 0, 0.62);
  close(t.bestBidNo ?? 0, 0.38);
  close(t.bestAskNo ?? 0, 0.43);
});

test("flat inventory: symmetric bids one half-spread below fair", () => {
  const qs = computeQuotes(base());
  const yes = qs.find((q) => q.token === "YES" && q.action === "BUY");
  const no = qs.find((q) => q.token === "NO" && q.action === "BUY");
  assert.ok(yes && no);
  close(yes.price, 0.58); // floor(0.6 - 0.015) at 0.01 tick
  close(no.price, 0.38);
  close(yes.qty * yes.price, 15, 0.6);
  assert.ok(yes.qty >= 5);
  assert.equal(qs.filter((q) => q.action === "SELL").length, 0);
});

test("YES heavy: YES bid backs off, NO bid tightens, YES offered above fair", () => {
  let inv = emptyInventory();
  inv = applyFill(inv, { action: "BUY", token: "YES", price: 0.59, qty: 30 }); // 17.7 unpaired cost of 30 cap
  const qs = computeQuotes(base({ inv }));
  const yes = qs.find((q) => q.token === "YES" && q.action === "BUY");
  const no = qs.find((q) => q.token === "NO" && q.action === "BUY");
  const sell = qs.find((q) => q.token === "YES" && q.action === "SELL");
  assert.ok(no, "light side must still be bid");
  assert.ok(no.price >= 0.38, "light side bid should not be worse than the symmetric quote");
  assert.ok(no.price <= 0.4 - 0.005 + 1e-9, "never bid through fair");
  assert.ok(sell, "heavy inventory should be offered");
  assert.ok(sell.price >= 0.62, "offer at or above fair + half spread");
  close(sell.qty, 30);
  if (yes) assert.ok(yes.price <= 0.58, "heavy side bid must not tighten");
});

test("unpaired cap blocks adding to the heavy side", () => {
  let inv = emptyInventory();
  inv = applyFill(inv, { action: "BUY", token: "YES", price: 0.59, qty: 52 }); // 30.68 > cap 30
  const qs = computeQuotes(base({ inv }));
  assert.equal(qs.find((q) => q.token === "YES" && q.action === "BUY"), undefined);
  assert.ok(qs.find((q) => q.token === "NO" && q.action === "BUY"), "pairing side keeps quoting");
});

test("quotes are target state: an oversized resting bid is replaced, not stacked", () => {
  const resting: LiveOrder = {
    id: "1", hash: "0x", marketId: 1, action: "BUY", token: "YES", price: 0.58, qty: 50, filledQty: 0, status: "OPEN",
    expiresAt: 0, placedAt: 0, tokenId: "", order: {},
  };
  const qs = computeQuotes(base({ openOrders: [resting] }));
  const yes = qs.find((q) => q.token === "YES" && q.action === "BUY");
  assert.ok(yes, "target bid still produced");
  assert.ok(yes.qty * yes.price <= 30 + 1e-6, "target never exceeds the unpaired cap");
  assert.ok(!orderMatchesQuote(resting, yes, CONFIG_DEFAULTS.quote), "the 50-share order must be replaced");
});

test("heavy side target shrinks to the remaining cap headroom", () => {
  let inv = emptyInventory();
  inv = applyFill(inv, { action: "BUY", token: "YES", price: 0.55, qty: 40 }); // 22U unpaired of 30U cap
  const qs = computeQuotes(base({ inv, fairYes: 0.58 }));
  const yes = qs.find((q) => q.token === "YES" && q.action === "BUY");
  if (yes) assert.ok(22 + yes.qty * Math.max(yes.price, 0.55) <= 30 + 1e-6, `potential unpaired too high: ${yes.qty}@${yes.price}`);
});

test("post-only never crosses the book", () => {
  const tight: Book = { marketId: 1, ts: 0, bids: [[0.59, 10]], asks: [[0.585, 10]] };
  const qs = computeQuotes(base({ book: tight, fairYes: 0.62 }));
  const yes = qs.find((q) => q.token === "YES" && q.action === "BUY");
  assert.ok(!yes || yes.price < 0.585, "bid must stay below the best ask");
});

test("capital limit scales the order down or removes it", () => {
  const qs = computeQuotes(base({ capitalAvailable: 4 }));
  const total = qs.filter((q) => q.action === "BUY").reduce((a, q) => a + q.qty * q.price, 0);
  assert.ok(total <= 4 + 1e-6);
});

test("exit mode sells the unpaired side only", () => {
  let inv = emptyInventory();
  inv = applyFill(inv, { action: "BUY", token: "NO", price: 0.39, qty: 20 });
  const qs = computeQuotes(base({ inv, mode: "exiting" }));
  assert.equal(qs.filter((q) => q.action === "BUY").length, 0);
  const sell = qs.find((q) => q.action === "SELL");
  assert.ok(sell && sell.token === "NO");
  close(sell.qty, 20);
  close(sell.price, 0.38); // best NO bid (1 - 0.62) is within slippage -> take it
});

test("orderMatchesQuote tolerates small size drift but not price drift", () => {
  const o: LiveOrder = { id: "1", hash: "0x", marketId: 1, action: "BUY", token: "YES", price: 0.58, qty: 25, filledQty: 2, status: "OPEN", expiresAt: 0, placedAt: 0, tokenId: "", order: {} };
  const q = { action: "BUY" as const, token: "YES" as const, price: 0.58, qty: 25, reason: "" };
  assert.ok(orderMatchesQuote(o, q, CONFIG_DEFAULTS.quote));
  assert.ok(!orderMatchesQuote(o, { ...q, price: 0.57 }, CONFIG_DEFAULTS.quote));
  assert.ok(!orderMatchesQuote({ ...o, filledQty: 20 }, q, CONFIG_DEFAULTS.quote));
});
