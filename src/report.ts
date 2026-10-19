import type { JournalRecord } from "./store/journal";
import { fmtUsd } from "./util/num";

interface MarketAgg {
  label: string;
  fills: number;
  buyQty: number;
  buyNotional: number;
  sellQty: number;
  sellNotional: number;
  realized: number;
  mergedPairs: number;
  mergePnl: number;
  orders: number;
  cancels: number;
  errors: number;
  mo10: number[];
  mo60: number[];
  moFair60: number[];
}

function agg(): MarketAgg {
  return { label: "", fills: 0, buyQty: 0, buyNotional: 0, sellQty: 0, sellNotional: 0, realized: 0, mergedPairs: 0, mergePnl: 0, orders: 0, cancels: 0, errors: 0, mo10: [], mo60: [], moFair60: [] };
}

function mean(xs: number[]): string {
  const v = xs.filter((x) => Number.isFinite(x));
  if (v.length === 0) return "n/a";
  return `${((v.reduce((a, b) => a + b, 0) / v.length) * 100).toFixed(2)}c (n=${v.length})`;
}

export function buildReport(records: JournalRecord[], state: { markets?: Record<string, { inv: Record<string, number> }> } | null): string {
  const byMarket = new Map<number, MarketAgg>();
  const get = (id: number) => {
    let a = byMarket.get(id);
    if (!a) {
      a = agg();
      byMarket.set(id, a);
    }
    return a;
  };
  let dailyStops = 0;
  let first = Number.POSITIVE_INFINITY;
  let last = 0;
  for (const r of records) {
    first = Math.min(first, r.t);
    last = Math.max(last, r.t);
    const id = typeof r.marketId === "number" ? r.marketId : -1;
    switch (r.type) {
      case "fill": {
        const a = get(id);
        if (typeof r.label === "string") a.label = r.label;
        a.fills++;
        const qty = Number(r.qty) || 0;
        const notional = Number(r.notional) || 0;
        if (r.action === "BUY") {
          a.buyQty += qty;
          a.buyNotional += notional;
        } else {
          a.sellQty += qty;
          a.sellNotional += notional;
        }
        a.realized += Number(r.realizedDelta) || 0;
        break;
      }
      case "merge": {
        const a = get(id);
        a.mergedPairs += Number(r.pairs) || 0;
        const pnl = Number(r.pnl);
        if (Number.isFinite(pnl)) {
          a.mergePnl += pnl;
          a.realized += pnl;
        }
        break;
      }
      case "markout": {
        const a = get(id);
        if (typeof r.markoutMid10 === "number") a.mo10.push(r.markoutMid10);
        if (typeof r.markoutMid60 === "number") a.mo60.push(r.markoutMid60);
        if (typeof r.markoutFair60 === "number") a.moFair60.push(r.markoutFair60);
        break;
      }
      case "order":
        get(id).orders++;
        break;
      case "cancel":
        get(id).cancels++;
        break;
      case "order_error":
      case "merge_error":
        get(id).errors++;
        break;
      case "daily_stop":
        dailyStops++;
        break;
      default:
        break;
    }
  }
  const lines: string[] = [];
  if (records.length === 0) return "journal is empty";
  lines.push(`journal: ${records.length} records, ${new Date(first).toISOString()} -> ${new Date(last).toISOString()}`);
  lines.push("");
  lines.push("market | fills | buy qty/notional | sell qty/notional | merged pairs | merge pnl | realized pnl | orders/cancels/errors | markout mid10 | mid60 | fair60");
  let totalRealized = 0;
  const allMo10: number[] = [];
  const allMo60: number[] = [];
  const allFair60: number[] = [];
  for (const [id, a] of byMarket) {
    totalRealized += a.realized;
    allMo10.push(...a.mo10);
    allMo60.push(...a.mo60);
    allFair60.push(...a.moFair60);
    lines.push(
      `${id} ${a.label.slice(0, 30)} | ${a.fills} | ${a.buyQty.toFixed(2)}/${fmtUsd(a.buyNotional)} | ${a.sellQty.toFixed(2)}/${fmtUsd(a.sellNotional)} | ${a.mergedPairs.toFixed(2)} | ${fmtUsd(a.mergePnl)} | ${fmtUsd(a.realized)} | ${a.orders}/${a.cancels}/${a.errors} | ${mean(a.mo10)} | ${mean(a.mo60)} | ${mean(a.moFair60)}`,
    );
  }
  lines.push("");
  lines.push(`total realized pnl (fills + merges): ${fmtUsd(totalRealized)}`);
  lines.push(`markout after fill (positive = price moved in our favour): mid10 ${mean(allMo10)}, mid60 ${mean(allMo60)}, fair60 ${mean(allFair60)}`);
  if (dailyStops > 0) lines.push(`daily stop triggered ${dailyStops} time(s)`);
  if (state?.markets) {
    lines.push("");
    lines.push("open inventory (from state.json):");
    for (const [id, m] of Object.entries(state.markets)) {
      const inv = m.inv;
      if (!inv || (inv.yesQty === 0 && inv.noQty === 0)) continue;
      lines.push(`  ${id}: yes=${inv.yesQty} (cost ${fmtUsd(inv.yesCost ?? 0)}) no=${inv.noQty} (cost ${fmtUsd(inv.noCost ?? 0)}) realized=${fmtUsd(inv.realizedPnl ?? 0)}`);
    }
  }
  return lines.join("\n");
}
