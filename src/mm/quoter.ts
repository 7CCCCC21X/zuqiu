import type { Book, Config, DesiredQuote, LiveOrder, MarketInventory, Token } from "../types";
import { ceilTick, clamp, fix, floorTick } from "../util/num";
import { avgCost, unpaired } from "./inventory";

export interface QuoteInput {
  fairYes: number;
  book: Book;
  inv: MarketInventory;
  quote: Config["quote"];
  /** cap on unpaired cost for this market, incl. resting bids on the heavy side */
  maxUnpairedCost: number;
  /** capital still available globally (bids + inventory at cost) */
  capitalAvailable: number;
  maxOrderCost: number;
  openOrders: LiveOrder[];
  mode: "quoting" | "exiting";
  exitMaxSlippage: number;
  exitMode: "merge_and_sell" | "merge_and_hold";
}

export interface BookTop {
  bestBidYes?: number;
  bestAskYes?: number;
  bestBidNo?: number;
  bestAskNo?: number;
}

/** YES-denominated book -> best prices for both tokens. */
export function bookTop(book: Book): BookTop {
  const bb = book.bids[0]?.[0];
  const ba = book.asks[0]?.[0];
  return {
    ...(bb !== undefined ? { bestBidYes: bb, bestAskNo: fix(1 - bb) } : {}),
    ...(ba !== undefined ? { bestAskYes: ba, bestBidNo: fix(1 - ba) } : {}),
  };
}

function remaining(o: LiveOrder): number {
  return Math.max(0, o.qty - o.filledQty);
}


/**
 * Target bid size for `token` so that, if the bid fills in full, the unpaired
 * cost (current excess + this order) stays within `cap`. Quotes describe the
 * full target state: resting orders are matched against them by the engine
 * and replaced when they differ, never stacked on top.
 */
function allowedBuyQty(inv: MarketInventory, token: Token, price: number, cap: number): number {
  const u = unpaired(inv);
  const base = u.token === token ? u.qty : u.token === null ? 0 : -u.qty; // + = already heavy in `token`
  const refPrice = Math.max(avgCost(inv, token) || price, price);
  const headroomShares = base >= 0 ? Math.max(0, cap / refPrice - base) : cap / refPrice + Math.abs(base);
  return Math.max(0, headroomShares);
}

export function computeQuotes(input: QuoteInput): DesiredQuote[] {
  const { fairYes, inv, quote } = input;
  const tick = quote.tickSize;
  const top = bookTop(input.book);
  const fair = { YES: fairYes, NO: fix(1 - fairYes) };
  const out: DesiredQuote[] = [];
  const u = unpaired(inv);

  if (input.mode === "exiting") {
    if (u.token && u.qty >= 0.01 && input.exitMode === "merge_and_sell") {
      const bestBid = u.token === "YES" ? top.bestBidYes : top.bestBidNo;
      const floor = ceilTick(fair[u.token] - input.exitMaxSlippage, tick);
      const price = bestBid !== undefined && bestBid >= floor ? floorTick(bestBid, tick) : Math.max(floor, tick);
      if (price > 0 && price < 1) {
        const qty = Math.floor(u.qty * 100) / 100;
        if (qty >= 0.01) out.push({ action: "SELL", token: u.token, price, qty, reason: `exit:${bestBid !== undefined && bestBid >= floor ? "take" : "rest"}` });
      }
    }
    return out;
  }

  // ---- inventory skew: heavy side gets a wider edge, light side a tighter one
  const heavyFrac = input.maxUnpairedCost > 0 ? clamp(u.cost / input.maxUnpairedCost, 0, 1) : 1;
  const skew = quote.skewMax * heavyFrac;
  const edge: Record<Token, number> = { YES: quote.halfSpread, NO: quote.halfSpread };
  if (u.token === "YES") {
    edge.YES += skew;
    edge.NO -= skew;
  } else if (u.token === "NO") {
    edge.NO += skew;
    edge.YES -= skew;
  }
  edge.YES = Math.max(quote.minEdge, edge.YES);
  edge.NO = Math.max(quote.minEdge, edge.NO);

  let capital = input.capitalAvailable; // excludes this market's own resting bids (they are part of the target)

  for (const token of ["YES", "NO"] as Token[]) {
    let price = floorTick(fair[token] - edge[token], tick);
    const bestAsk = token === "YES" ? top.bestAskYes : top.bestAskNo;
    if (quote.postOnly && bestAsk !== undefined && price >= bestAsk) price = floorTick(bestAsk - tick, tick);
    if (price < quote.minPrice || price > quote.maxPrice || price <= 0) continue;
    if (price > fair[token] - quote.minEdge + 1e-9) continue; // never bid through fair

    let shares = Math.max(quote.minOrderShares, quote.orderCostUsd / price);
    shares = Math.min(shares, input.maxOrderCost / price);
    const allowed = allowedBuyQty(inv, token, price, input.maxUnpairedCost);
    shares = Math.min(shares, allowed);
    if (capital > 0) shares = Math.min(shares, capital / price);
    else shares = 0;
    shares = Math.floor(shares * 100) / 100;
    if (shares < quote.minOrderShares) continue;
    capital -= shares * price;
    out.push({ action: "BUY", token, price, qty: shares, reason: `bid edge=${edge[token].toFixed(3)}${u.token === token ? " heavy" : u.token ? " light" : ""}` });
  }

  // ---- work the heavy side down by offering it at fair + spread (maker)
  if (quote.sellInventory && u.token && u.qty >= quote.minOrderShares) {
    let price = ceilTick(fair[u.token] + quote.halfSpread, tick);
    const bestBid = u.token === "YES" ? top.bestBidYes : top.bestBidNo;
    if (quote.postOnly && bestBid !== undefined && price <= bestBid) price = ceilTick(bestBid + tick, tick);
    if (price > 0 && price < 1 && price >= fair[u.token] + quote.minEdge - 1e-9) {
      const qty = Math.floor(u.qty * 100) / 100;
      if (qty >= quote.minOrderShares) out.push({ action: "SELL", token: u.token, price, qty, reason: "work heavy inventory" });
    }
  }
  return out;
}

/** Does the resting order still match the desired quote closely enough to keep it? */
export function orderMatchesQuote(o: LiveOrder, q: DesiredQuote, quote: Config["quote"]): boolean {
  if (o.action !== q.action || o.token !== q.token) return false;
  const priceDiffTicks = Math.abs(o.price - q.price) / quote.tickSize;
  if (priceDiffTicks > quote.requoteTicks - 1e-9) return false;
  const rem = remaining(o);
  if (rem <= 0) return false;
  if (Math.abs(rem - q.qty) > quote.requoteSizeRatio * q.qty) return false;
  return true;
}
