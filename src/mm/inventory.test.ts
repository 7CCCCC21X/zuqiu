import test from "node:test";
import assert from "node:assert/strict";
import { applyFill, applyMerge, avgCost, emptyInventory, inventoryCost, markToMarket, pairedQty, unpaired } from "./inventory";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("buy both sides, merge, realise the spread", () => {
  let inv = emptyInventory();
  inv = applyFill(inv, { action: "BUY", token: "YES", price: 0.59, qty: 50 });
  inv = applyFill(inv, { action: "BUY", token: "NO", price: 0.39, qty: 50 });
  close(inventoryCost(inv), 49);
  assert.equal(pairedQty(inv), 50);
  assert.equal(unpaired(inv).token, null);
  inv = applyMerge(inv, 50);
  close(inv.realizedPnl, 1);
  assert.equal(inv.yesQty, 0);
  assert.equal(inv.noQty, 0);
  close(inventoryCost(inv), 0);
  assert.equal(inv.mergedPairs, 50);
});

test("unpaired exposure and mark to market", () => {
  let inv = emptyInventory();
  inv = applyFill(inv, { action: "BUY", token: "YES", price: 0.59, qty: 50 });
  inv = applyFill(inv, { action: "BUY", token: "NO", price: 0.39, qty: 20 });
  const u = unpaired(inv);
  assert.equal(u.token, "YES");
  close(u.qty, 30);
  close(u.cost, 17.7);
  // fair dropped to 0.50: 20 pairs worth 1 each, 30 YES marked at 0.50
  const mtm = markToMarket(inv, { yes: 0.5, no: 0.5 });
  close(mtm, 20 * (1 - 0.59 - 0.39) + 30 * (0.5 - 0.59));
});

test("sell realises pnl against average cost", () => {
  let inv = emptyInventory();
  inv = applyFill(inv, { action: "BUY", token: "YES", price: 0.5, qty: 10 });
  inv = applyFill(inv, { action: "BUY", token: "YES", price: 0.6, qty: 10 });
  close(avgCost(inv, "YES"), 0.55);
  inv = applyFill(inv, { action: "SELL", token: "YES", price: 0.6, qty: 5 });
  close(inv.realizedPnl, 0.25);
  close(inv.yesQty, 15);
  close(avgCost(inv, "YES"), 0.55);
});
