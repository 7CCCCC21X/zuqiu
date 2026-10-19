#!/usr/bin/env node
import { loadConfig, loadSecrets } from "./config";
import { log, setLogLevel } from "./logger";
import { PredictApi } from "./predict/api";
import { PredictTrader } from "./predict/trader";
import { PredictWs } from "./predict/ws";
import { OddsApi } from "./odds/oddsApi";
import { combineFair } from "./odds/fair";
import { Polymarket } from "./poly/polymarket";
import { Journal } from "./store/journal";
import { Engine } from "./mm/engine";
import { buildReport } from "./report";
import { startStatusServer } from "./server";
import { detectOutcome, rankEvents } from "./mm/match";
import { bookTop } from "./mm/quoter";
import { fmtUsd, weiToNumber } from "./util/num";
import type { Config, PredictMarketInfo, Secrets } from "./types";

interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd: positional[0] ?? "help", positional: positional.slice(1), flags };
}

function flag(args: Args, k: string): string | undefined {
  const v = args.flags[k];
  return typeof v === "string" ? v : undefined;
}

const USAGE = `predict.fun football market maker

usage: node dist/index.js <command> [--config config.json] [options]
  (env: CONFIG_PATH, CONFIG_JSON, MARKETS_JSON, DRY_RUN, NETWORK, DATA_DIR, LOG_LEVEL, PORT, STATUS_TOKEN)

  run                      start the bot (dryRun is controlled by config.dryRun)
  scan                     list predict.fun markets and the odds events they match
      --category <slug>      markets of one predict.fun category (slug from the URL)
      --ids 1,2,3            specific market ids
      --search <text>        scan the market list for a text match (--max-pages N, default 10)
      --sport k1,k2          odds api sport keys to match against (default: soccer_epl)
  fair                     fair value of every configured market (checks odds/poly keys)
  book --market <id>       predict.fun orderbook top levels
  status                   USDT balance, open orders, positions
  cancel-all [--market id] remove every open order from the orderbook (--onchain also invalidates on-chain)
  merge --market <id>      merge YES+NO pairs held in a market (--pairs N to limit)
  approve                  set on-chain approvals for the configured markets
  report                   PnL / fill / markout summary from data/journal.jsonl
  sports                   list soccer sport keys of The Odds API
  poly-find <text>         search Polymarket events (prints slugs and markets)
`;

function makeApi(cfg: Config, secrets: Secrets): PredictApi {
  return new PredictApi(cfg.predict.apiBase, secrets.predictApiKey);
}

async function cmdRun(cfg: Config, secrets: Secrets): Promise<void> {
  const api = makeApi(cfg, secrets);
  const trader = await PredictTrader.create(cfg, secrets, api);
  const odds = secrets.oddsApiKey ? new OddsApi(secrets.oddsApiKey) : null;
  const poly = cfg.poly.enabled ? new Polymarket(cfg.poly.gammaBase, cfg.poly.clobBase) : null;
  const ws = cfg.ws.enabled ? new PredictWs(cfg.predict.wsUrl, secrets.predictApiKey) : null;
  const journal = new Journal(cfg.dataDir);
  const engine = new Engine(cfg, secrets, { api, trader, odds, poly, ws, journal });
  const port = Number.parseInt(process.env.PORT ?? "", 10);
  if (Number.isFinite(port) && port > 0) startStatusServer(port, engine, journal, process.env.STATUS_TOKEN || undefined);
  const shutdown = (sig: string) => {
    engine
      .stop(sig)
      .catch((e) => log.error("shutdown error:", e))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (e) => log.error("unhandled rejection:", e));
  await engine.start();
}

function describeMarket(m: PredictMarketInfo): string {
  const outcomes = (Array.isArray(m.raw.outcomes) ? (m.raw.outcomes as Array<Record<string, unknown>>) : []).map((o) => `${String(o.name)}#${String(o.indexSet)}`).join("/");
  return `[${m.id}] ${m.title}\n      question: ${m.question}\n      category: ${m.categorySlug ?? "?"} status=${m.status} negRisk=${m.isNegRisk} yield=${m.isYieldBearing} fee=${m.feeRateBps}bps outcomes=${outcomes}${m.endsAt ? ` ends=${new Date(m.endsAt).toISOString()}` : ""}${m.description ? `\n      rules: ${m.description.replace(/\s+/g, " ").slice(0, 240)}` : ""}`;
}

async function cmdScan(cfg: Config, secrets: Secrets, args: Args): Promise<void> {
  const api = makeApi(cfg, secrets);
  let markets: PredictMarketInfo[] = [];
  const category = flag(args, "category");
  const ids = flag(args, "ids");
  const search = flag(args, "search");
  if (category) {
    const c = await api.getCategory(category);
    markets = c.markets;
    log.info(`category "${String(c.raw.title ?? category)}": ${markets.length} markets`);
  } else if (ids) {
    for (const id of ids.split(",")) markets.push(await api.getMarket(Number.parseInt(id.trim(), 10)));
  } else if (search) {
    const maxPages = Number.parseInt(flag(args, "max-pages") ?? "10", 10);
    const toks = search.toLowerCase().split(/\s+/).filter(Boolean);
    const all = await api.listMarkets({ maxPages, onPage: (n, got) => log.info(`page ${n}: ${got} markets so far`) });
    markets = all.filter((m) => {
      const text = `${m.title} ${m.question} ${m.categorySlug ?? ""} ${m.categoryTitle ?? ""}`.toLowerCase();
      return toks.every((t) => text.includes(t));
    });
  } else {
    console.log(USAGE);
    return;
  }
  markets = markets.filter((m) => !/resolved|closed|settled/i.test(m.status));
  const sports = (flag(args, "sport") ?? [...new Set(cfg.markets.map((m) => m.oddsSport).filter(Boolean))].join(",") ?? "soccer_epl") || "soccer_epl";
  const odds = secrets.oddsApiKey ? new OddsApi(secrets.oddsApiKey) : null;
  const events: Array<{ sport: string; ev: import("./types").OddsEvent }> = [];
  if (odds) {
    for (const sport of sports.split(",").map((s) => s.trim()).filter(Boolean)) {
      try {
        for (const ev of await odds.fetchH2H(sport, cfg.odds.bookmakers, undefined, cfg.odds.regions)) events.push({ sport, ev });
      } catch (e) {
        log.warn(`odds fetch failed for ${sport}: ${(e as Error).message}`);
      }
    }
    log.info(`odds: ${events.length} upcoming events across ${sports}; credits remaining=${odds.credits.remaining ?? "?"}`);
  } else {
    log.warn("ODDS_API_KEY not set: markets are listed without odds matching");
  }
  const suggestions: unknown[] = [];
  for (const m of markets) {
    console.log(describeMarket(m));
    const text = `${m.categoryTitle ?? ""} ${m.title} ${m.question}`;
    const ranked = rankEvents(text, events.map((e) => e.ev), cfg.aliases, m.endsAt);
    const best = ranked[0];
    if (best && best.score >= 2) {
      const sport = events.find((e) => e.ev.id === best.event.id)?.sport ?? "";
      const teams = { home: best.event.homeTeam, away: best.event.awayTeam };
      const outcome = detectOutcome(text, teams, cfg.aliases);
      const fair = combineFair(best.event, { weights: cfg.odds.weights, devig: cfg.odds.devig, maxSourceAgeSec: cfg.odds.maxSourceAgeSec, maxExchangeSpread: cfg.odds.maxExchangeSpread });
      console.log(`      odds match: ${best.event.homeTeam} v ${best.event.awayTeam} kickoff=${new Date(best.event.commenceTime).toISOString()} event=${best.event.id} sport=${sport} detected outcome=${outcome ?? "?"}${fair ? ` fair home/draw/away=${fair.p.home.toFixed(3)}/${fair.p.draw.toFixed(3)}/${fair.p.away.toFixed(3)} (${fair.nSources} sources)` : ""}`);
      if (ranked[1] && ranked[1].score >= 2) console.log(`      WARNING: also matches ${ranked[1].event.homeTeam} v ${ranked[1].event.awayTeam} on ${new Date(ranked[1].event.commenceTime).toISOString()}`);
      suggestions.push({ predictMarketId: m.id, outcome: outcome ?? "home", label: `${best.event.homeTeam} v ${best.event.awayTeam} - ${outcome ?? "?"}`, oddsSport: sport, oddsEventId: best.event.id, teams, polySlug: "" });
    } else {
      console.log(`      odds match: none${best ? ` (best partial: ${best.event.homeTeam} v ${best.event.awayTeam})` : ""}`);
    }
    console.log("");
  }
  if (suggestions.length > 0) {
    console.log("suggested config.markets entries (verify outcome + settlement rules before use):");
    console.log(JSON.stringify(suggestions, null, 2));
  }
}

async function cmdFair(cfg: Config, secrets: Secrets): Promise<void> {
  if (!secrets.oddsApiKey) throw new Error("ODDS_API_KEY missing");
  const odds = new OddsApi(secrets.oddsApiKey);
  const poly = cfg.poly.enabled ? new Polymarket(cfg.poly.gammaBase, cfg.poly.clobBase) : null;
  const bySport = new Map<string, import("./types").OddsEvent[]>();
  for (const spec of cfg.markets) {
    if (!spec.oddsSport) {
      console.log(`[${spec.predictMarketId}] no oddsSport configured`);
      continue;
    }
    if (!bySport.has(spec.oddsSport)) bySport.set(spec.oddsSport, await odds.fetchH2H(spec.oddsSport, cfg.odds.bookmakers, undefined, cfg.odds.regions));
    const events = bySport.get(spec.oddsSport) ?? [];
    const ev = spec.oddsEventId ? events.find((e) => e.id === spec.oddsEventId) : rankEvents(spec.label ?? "", events, cfg.aliases)[0]?.event;
    if (!ev) {
      console.log(`[${spec.predictMarketId}] odds event not found (${spec.oddsEventId ?? spec.label ?? "?"})`);
      continue;
    }
    const fair = combineFair(ev, { weights: cfg.odds.weights, devig: cfg.odds.devig, maxSourceAgeSec: cfg.odds.maxSourceAgeSec, maxExchangeSpread: cfg.odds.maxExchangeSpread });
    console.log(`[${spec.predictMarketId}] ${ev.homeTeam} v ${ev.awayTeam} kickoff=${new Date(ev.commenceTime).toISOString()} outcome=${spec.outcome}`);
    for (const s of fair?.sources ?? []) {
      console.log(`    ${s.key.padEnd(14)} w=${s.weight.toFixed(2)} home/draw/away=${s.p.home.toFixed(3)}/${s.p.draw.toFixed(3)}/${s.p.away.toFixed(3)} overround=${s.overround.toFixed(3)}${s.exchangeSpread !== undefined ? ` back-lay gap=${s.exchangeSpread.toFixed(3)}` : ""}${s.stale ? " STALE" : ""} updated=${new Date(s.lastUpdate).toISOString()}`);
    }
    if (fair) console.log(`    fair ${spec.outcome} = ${fair.p[spec.outcome].toFixed(4)} (dispersion ${(fair.dispersion[spec.outcome] * 100).toFixed(1)} pts, ${fair.nSources} sources)`);
    if (poly && spec.polySlug) {
      const pev = await poly.eventBySlug(spec.polySlug);
      const pm = pev ? Polymarket.pickMarket(pev, spec.outcome, spec.teams ?? { home: ev.homeTeam, away: ev.awayTeam }, spec.polyMarketQuestion, cfg.aliases) : null;
      if (pm) {
        const b = await poly.book(pm.yesTokenId, cfg.poly.depthWindow);
        console.log(`    poly "${pm.question}": bid/ask=${b.bestBid ?? "-"}/${b.bestAsk ?? "-"} mid=${b.mid?.toFixed(3) ?? "-"} depth bid/ask=${fmtUsd(b.bidDepthUsd)}/${fmtUsd(b.askDepthUsd)}`);
      } else {
        console.log(`    poly: market not found for slug ${spec.polySlug}`);
      }
    }
  }
  console.log(`odds credits remaining=${odds.credits.remaining ?? "?"} used=${odds.credits.used ?? "?"}`);
}

async function cmdBook(cfg: Config, secrets: Secrets, args: Args): Promise<void> {
  const id = Number.parseInt(flag(args, "market") ?? "", 10);
  if (!Number.isFinite(id)) throw new Error("--market <id> required");
  const api = makeApi(cfg, secrets);
  const m = await api.getMarket(id);
  console.log(describeMarket(m));
  const book = await api.getOrderbook(id);
  const top = bookTop(book);
  console.log(`YES best bid/ask: ${top.bestBidYes ?? "-"}/${top.bestAskYes ?? "-"}   NO best bid/ask: ${top.bestBidNo ?? "-"}/${top.bestAskNo ?? "-"}`);
  console.log("asks (YES):", book.asks.slice(0, 8).map(([p, q]) => `${p}x${q}`).join("  "));
  console.log("bids (YES):", book.bids.slice(0, 8).map(([p, q]) => `${p}x${q}`).join("  "));
}

async function cmdStatus(cfg: Config, secrets: Secrets): Promise<void> {
  const api = makeApi(cfg, secrets);
  const trader = await PredictTrader.create(cfg, secrets, api);
  if (trader) console.log(`maker ${trader.makerAddress} USDT balance: ${fmtUsd(await trader.usdtBalance())}`);
  else console.log("PREDICT_PRIVATE_KEY not set: balance unavailable");
  const orders = await api.getOpenOrders();
  console.log(`open orders: ${orders.length}`);
  for (const o of orders) {
    const side = Number(o.order.side) === 0 ? "BUY" : "SELL";
    const mk = weiToNumber(o.order.makerAmount);
    const tk = weiToNumber(o.order.takerAmount);
    const qty = side === "BUY" ? tk : mk;
    const price = qty > 0 ? (side === "BUY" ? mk / qty : tk / qty) : 0;
    console.log(`  id=${o.id} market=${o.marketId} ${side} token=${String(o.order.tokenId).slice(0, 12)}… ${qty.toFixed(2)}@${price.toFixed(3)} filled=${o.amountFilled}/${o.amount} status=${o.status} exp=${new Date(Number(o.order.expiration) * 1000).toISOString()}`);
  }
  const positions = await api.getPositions();
  console.log(`positions: ${positions.length}`);
  for (const p of positions) console.log(`  market=${p.market?.id} ${p.market?.title ?? ""} outcome=${p.outcome?.name} amount=${weiToNumber(BigInt(String(p.amount).split(".")[0] ?? "0")).toFixed(2)} valueUsd=${p.valueUsd ?? "?"}`);
}

async function cmdCancelAll(cfg: Config, secrets: Secrets, args: Args): Promise<void> {
  const api = makeApi(cfg, secrets);
  const trader = await PredictTrader.create(cfg, secrets, api);
  if (!trader) throw new Error("PREDICT_PRIVATE_KEY required");
  const marketFilter = flag(args, "market");
  let orders = await api.getOpenOrders();
  if (marketFilter) orders = orders.filter((o) => String(o.marketId) === marketFilter);
  if (orders.length === 0) {
    console.log("no open orders");
    return;
  }
  const res = await trader.cancelByIds(orders.map((o) => String(o.id)));
  console.log(`removed ${res.removed.length} orders, noop ${res.noop.length}`);
  if (args.flags.onchain) {
    await trader.cancelOnChain(orders.map((o) => ({ order: o.order, isNegRisk: Boolean(o.isNegRisk), isYieldBearing: Boolean(o.isYieldBearing) })));
    console.log("on-chain cancellation submitted");
  }
}

async function cmdMerge(cfg: Config, secrets: Secrets, args: Args): Promise<void> {
  const id = Number.parseInt(flag(args, "market") ?? "", 10);
  if (!Number.isFinite(id)) throw new Error("--market <id> required");
  const api = makeApi(cfg, secrets);
  const trader = await PredictTrader.create(cfg, secrets, api);
  if (!trader) throw new Error("PREDICT_PRIVATE_KEY required");
  const m = await api.getMarket(id);
  const positions = await api.getPositions();
  let yes = 0;
  let no = 0;
  for (const p of positions) {
    if (Number(p.market?.id) !== id) continue;
    const amt = weiToNumber(BigInt(String(p.amount).split(".")[0] ?? "0"));
    if (String(p.outcome?.onChainId) === m.yesTokenId) yes += amt;
    if (String(p.outcome?.onChainId) === m.noTokenId) no += amt;
  }
  let pairs = Math.floor(Math.min(yes, no) * 100) / 100;
  const want = Number.parseFloat(flag(args, "pairs") ?? "");
  if (Number.isFinite(want)) pairs = Math.min(pairs, want);
  console.log(`market ${id}: yes=${yes.toFixed(2)} no=${no.toFixed(2)} -> merging ${pairs} pairs`);
  if (pairs <= 0) return;
  await trader.ensureApprovals([m]);
  const res = await trader.merge(m, pairs);
  console.log(res.success ? `merged, tx=${res.txHash ?? "?"}` : `merge failed: ${res.error}`);
}

async function cmdApprove(cfg: Config, secrets: Secrets): Promise<void> {
  const api = makeApi(cfg, secrets);
  const trader = await PredictTrader.create(cfg, secrets, api);
  if (!trader) throw new Error("PREDICT_PRIVATE_KEY required");
  const markets: PredictMarketInfo[] = [];
  for (const spec of cfg.markets) markets.push(await api.getMarket(spec.predictMarketId));
  if (markets.length === 0) throw new Error("no markets configured");
  await trader.ensureApprovals(markets);
  console.log("approvals ok");
}

function cmdReport(cfg: Config): void {
  const journal = new Journal(cfg.dataDir);
  console.log(buildReport(journal.readAll(), journal.loadState()));
}

async function cmdSports(secrets: Secrets): Promise<void> {
  if (!secrets.oddsApiKey) throw new Error("ODDS_API_KEY missing");
  const odds = new OddsApi(secrets.oddsApiKey);
  const sports = await odds.listSports();
  for (const s of sports.filter((x) => x.group.toLowerCase() === "soccer")) console.log(`${s.key.padEnd(40)} ${s.title}`);
  console.log(`credits remaining=${odds.credits.remaining ?? "?"}`);
}

async function cmdPolyFind(cfg: Config, args: Args): Promise<void> {
  const q = args.positional.join(" ");
  if (!q) throw new Error("poly-find <text>");
  const poly = new Polymarket(cfg.poly.gammaBase, cfg.poly.clobBase);
  const hits = await poly.search(q, 10);
  for (const h of hits) {
    console.log(`${h.slug}  ${h.title}${h.startDate ? `  (${h.startDate})` : ""}`);
    const ev = await poly.eventBySlug(h.slug);
    for (const m of ev?.markets ?? []) console.log(`    ${m.closed ? "[closed] " : ""}${m.question}  yesToken=${m.yesTokenId.slice(0, 12)}… price=${m.outcomePrices[0] ?? "?"}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd === "help" || args.flags.help) {
    console.log(USAGE);
    return;
  }
  const cfg = loadConfig(flag(args, "config"));
  setLogLevel((flag(args, "log") as Config["logLevel"] | undefined) ?? cfg.logLevel);
  const secrets = loadSecrets();
  switch (args.cmd) {
    case "run":
      await cmdRun(cfg, secrets);
      break;
    case "scan":
      await cmdScan(cfg, secrets, args);
      break;
    case "fair":
      await cmdFair(cfg, secrets);
      break;
    case "book":
      await cmdBook(cfg, secrets, args);
      break;
    case "status":
      await cmdStatus(cfg, secrets);
      break;
    case "cancel-all":
      await cmdCancelAll(cfg, secrets, args);
      break;
    case "merge":
      await cmdMerge(cfg, secrets, args);
      break;
    case "approve":
      await cmdApprove(cfg, secrets);
      break;
    case "report":
      cmdReport(cfg);
      break;
    case "sports":
      await cmdSports(secrets);
      break;
    case "poly-find":
      await cmdPolyFind(cfg, args);
      break;
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  log.error(e instanceof Error ? e.message : String(e));
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
