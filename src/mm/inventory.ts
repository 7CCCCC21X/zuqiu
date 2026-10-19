import type { Fill, MarketInventory, Token } from "../types";
import { fix } from "../util/num";

export function emptyInventory(): MarketInventory {
  return { yesQty: 0, noQty: 0, yesCost: 0, noCost: 0, realizedPnl: 0, mergedPairs: 0, fills: 0 };
}

export function avgCost(inv: MarketInventory, token: Token): number {
  const qty = token === "YES" ? inv.yesQty : inv.noQty;
  const cost = token === "YES" ? inv.yesCost : inv.noCost;
  return qty > 1e-9 ? cost / qty : 0;
}

/** Apply a fill (maker or taker) to the inventory, average-cost accounting. */
export function applyFill(inv: MarketInventory, fill: Pick<Fill, "action" | "token" | "price" | "qty">): MarketInventory {
  const out = { ...inv };
  const q = fill.qty;
  if (q <= 0) return out;
  if (fill.action === "BUY") {
    if (fill.token === "YES") {
      out.yesQty = fix(out.yesQty + q);
      out.yesCost = fix(out.yesCost + q * fill.price);
    } else {
      out.noQty = fix(out.noQty + q);
      out.noCost = fix(out.noCost + q * fill.price);
    }
  } else {
    const avg = avgCost(inv, fill.token);
    const held = fill.token === "YES" ? inv.yesQty : inv.noQty;
    const sold = Math.min(q, held);
    const extra = q - sold; // selling more than tracked: treat as zero-cost (keeps books consistent)
    out.realizedPnl = fix(out.realizedPnl + sold * (fill.price - avg) + extra * fill.price);
    if (fill.token === "YES") {
      out.yesQty = fix(Math.max(0, inv.yesQty - sold));
      out.yesCost = fix(Math.max(0, inv.yesCost - sold * avg));
    } else {
      out.noQty = fix(Math.max(0, inv.noQty - sold));
      out.noCost = fix(Math.max(0, inv.noCost - sold * avg));
    }
  }
  out.fills = inv.fills + 1;
  return out;
}

/** Merge `pairs` YES+NO pairs back into collateral (1 USDT per pair). */
export function applyMerge(inv: MarketInventory, pairs: number): MarketInventory {
  const n = Math.min(pairs, inv.yesQty, inv.noQty);
  if (n <= 0) return { ...inv };
  const ay = avgCost(inv, "YES");
  const an = avgCost(inv, "NO");
  return {
    ...inv,
    yesQty: fix(inv.yesQty - n),
    noQty: fix(inv.noQty - n),
    yesCost: fix(Math.max(0, inv.yesCost - n * ay)),
    noCost: fix(Math.max(0, inv.noCost - n * an)),
    realizedPnl: fix(inv.realizedPnl + n * (1 - ay - an)),
    mergedPairs: fix(inv.mergedPairs + n),
  };
}

export function pairedQty(inv: MarketInventory): number {
  return fix(Math.min(inv.yesQty, inv.noQty));
}

export interface Unpaired {
  token: Token | null;
  qty: number;
  cost: number;
  avg: number;
}

/** The side we hold more of, its excess quantity and what that excess cost. */
export function unpaired(inv: MarketInventory): Unpaired {
  const diff = fix(inv.yesQty - inv.noQty);
  if (Math.abs(diff) < 1e-6) return { token: null, qty: 0, cost: 0, avg: 0 };
  const token: Token = diff > 0 ? "YES" : "NO";
  const avg = avgCost(inv, token);
  const qty = Math.abs(diff);
  return { token, qty, cost: fix(qty * avg), avg };
}

/** Capital currently tied up in positions (at cost). */
export function inventoryCost(inv: MarketInventory): number {
  return fix(inv.yesCost + inv.noCost);
}

/**
 * Mark-to-market: pairs are worth 1 each (merge), the unpaired excess is
 * valued at the given exit price for its token.
 */
export function markToMarket(inv: MarketInventory, exitPrice: { yes: number; no: number }): number {
  const pairs = pairedQty(inv);
  const ay = avgCost(inv, "YES");
  const an = avgCost(inv, "NO");
  let pnl = pairs * (1 - ay - an);
  const u = unpaired(inv);
  if (u.token === "YES") pnl += u.qty * (exitPrice.yes - u.avg);
  if (u.token === "NO") pnl += u.qty * (exitPrice.no - u.avg);
  return fix(pnl);
}
