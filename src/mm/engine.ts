import { log } from "../logger";
import type { Config, DesiredQuote, FairEstimate, LiveOrder, MarketFair, MarketInventory, MarketMode, MarketSpec, OddsEvent, OrderAction, PredictMarketInfo, Secrets, Token, Book } from "../types";
import type { PredictApi, RawOrder } from "../predict/api";
import type { PredictTrader } from "../predict/trader";
import type { PredictWs, WalletEvent } from "../predict/ws";
import type { OddsApi } from "../odds/oddsApi";
import type { Polymarket, PolyBookSummary } from "../poly/polymarket";
import { Polymarket as PolyClient } from "../poly/polymarket";
import type { Journal } from "../store/journal";
import { combineFair } from "../odds/fair";
import { applyFill, applyMerge, emptyInventory, inventoryCost, markToMarket, pairedQty, unpaired } from "./inventory";
import { bookTop, computeQuotes, orderMatchesQuote } from "./quoter";
import { detectOutcome, rankEvents } from "./match";
import { fix, fmtUsd, hours, sleep, weiToNumber } from "../util/num";

interface MarketState {
  spec: MarketSpec;
  info: PredictMarketInfo;
  teams?: { home: string; away: string };
  oddsSport?: string;
  oddsEventId?: string;
  kickoff?: number;
  polyToken?: string;
  poly?: PolyBookSummary;
  polyAt: number;
  fair?: MarketFair;
  fairEstimate?: FairEstimate;
  book?: Book;
  bookAt: number;
  inv: MarketInventory;
  orders: Map<string, LiveOrder>;
  mode: MarketMode;
  pauseReason?: string;
  lastMergeAt: number;
  lastMergeError?: string;
  mergeFailures: number;
  lastRequoteAt: Record<string, number>;
}

interface PersistedState {
  version: 1;
  savedAt: number;
  risk: { dayKey: string; realizedToday: number; stopped: boolean; stopReason?: string };
  markets: Record<string, { inv: MarketInventory; orders: LiveOrder[]; lastMergeAt: number }>;
  simCounter: number;
}

interface Markout {
  marketId: number;
  orderId: string;
  token: Token;
  action: OrderAction;
  price: number;
  qty: number;
  t0: number;
  mid0?: number;
  fair0?: number;
  mid10?: number;
  fair10?: number;
  mid60?: number;
  fair60?: number;
}

export interface EngineDeps {
  api: PredictApi;
  trader: PredictTrader | null;
  odds: OddsApi | null;
  poly: Polymarket | null;
  ws: PredictWs | null;
  journal: Journal;
}

const DAY_MS = 24 * 3600 * 1000;

export class Engine {
  private markets = new Map<number, MarketState>();
  private oddsCache = new Map<string, { events: OddsEvent[]; fetchedAt: number }>();
  private lastOddsFetch = 0;
  private lastOrdersSync = 0;
  private lastPositionsSync = 0;
  private lastStatusAt = 0;
  private lastApiOk = Date.now();
  private disconnectCancelled = false;
  private syncRequested = false;
  private stopping = false;
  private simCounter = 1;
  private markouts: Markout[] = [];
  private risk = { dayKey: dayKey(Date.now()), realizedToday: 0, stopped: false, stopReason: undefined as string | undefined };

  constructor(
    private readonly cfg: Config,
    private readonly secrets: Secrets,
    private readonly deps: EngineDeps,
  ) {}

  // ================================================================ lifecycle

  /** Load state, resolve markets, approvals, websocket and the first data pull. */
  async init(): Promise<void> {
    const { cfg } = this;
    log.info(`engine starting: network=${cfg.network} dryRun=${cfg.dryRun} markets=${cfg.markets.length}`);
    if (!cfg.dryRun && !this.deps.trader) throw new Error("live mode needs PREDICT_PRIVATE_KEY");
    if (!this.deps.odds) throw new Error("ODDS_API_KEY is required (fair value source)");
    this.restoreState();
    await this.resolveMarkets();
    if (!cfg.dryRun && this.deps.trader) {
      await this.deps.trader.ensureApprovals([...this.markets.values()].map((m) => m.info));
    }
    this.setupWs();
    await this.refreshOdds(true);
    await this.syncOrders(true);
    await this.syncPositions(true);
    log.info("engine ready");
  }

  /** One full iteration of the trading loop (exposed for tests and tooling). */
  async step(): Promise<void> {
    await this.tick();
  }

  /** Read-only view of every market for tests / status tooling. */
  states(): Array<{ id: number; mode: MarketMode; pauseReason?: string; fair?: MarketFair; orders: LiveOrder[]; inv: MarketInventory; kickoff?: number; stopped: boolean; realizedToday: number }> {
    return [...this.markets.values()].map((m) => ({
      id: m.info.id,
      mode: m.mode,
      ...(m.pauseReason ? { pauseReason: m.pauseReason } : {}),
      ...(m.fair ? { fair: m.fair } : {}),
      orders: [...m.orders.values()],
      inv: m.inv,
      ...(m.kickoff ? { kickoff: m.kickoff } : {}),
      stopped: this.risk.stopped,
      realizedToday: this.risk.realizedToday,
    }));
  }

  async start(): Promise<void> {
    const { cfg } = this;
    await this.init();
    while (!this.stopping) {
      const t0 = Date.now();
      try {
        await this.tick();
        this.lastApiOk = Date.now();
        this.disconnectCancelled = false;
      } catch (e) {
        log.error("tick failed:", e);
        await this.handleDisconnect();
      }
      const elapsed = Date.now() - t0;
      await sleep(Math.max(250, cfg.loopIntervalSec * 1000 - elapsed));
    }
  }

  async stop(reason = "shutdown"): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    log.info(`stopping (${reason})`);
    try {
      if (this.cfg.predict.cancelOnExit) await this.cancelAll("exit");
    } catch (e) {
      log.error("cancel on exit failed:", e);
    }
    this.persistState();
    this.deps.ws?.close();
  }

  // ================================================================== setup

  private restoreState(): void {
    const st = this.deps.journal.loadState<PersistedState>();
    if (!st || st.version !== 1) return;
    this.simCounter = st.simCounter ?? 1;
    this.risk = { dayKey: st.risk.dayKey, realizedToday: st.risk.realizedToday, stopped: st.risk.stopped, stopReason: st.risk.stopReason };
    if (this.risk.dayKey !== dayKey(Date.now())) this.risk = { dayKey: dayKey(Date.now()), realizedToday: 0, stopped: false, stopReason: undefined };
    this.restoredMarkets = st.markets;
    log.info(`restored state from ${new Date(st.savedAt).toISOString()} (${Object.keys(st.markets).length} markets)`);
  }
  private restoredMarkets: PersistedState["markets"] = {};

  private async resolveMarkets(): Promise<void> {
    for (const spec of this.cfg.markets) {
      const info = await this.deps.api.getMarket(spec.predictMarketId);
      if (!info.yesTokenId || !info.noTokenId) throw new Error(`market ${spec.predictMarketId}: could not determine YES/NO token ids (outcomes: ${JSON.stringify(info.raw.outcomes)})`);
      const saved = this.restoredMarkets[String(spec.predictMarketId)];
      const st: MarketState = {
        spec,
        info,
        ...(spec.teams ? { teams: spec.teams } : {}),
        ...(spec.oddsSport ? { oddsSport: spec.oddsSport } : {}),
        ...(spec.oddsEventId ? { oddsEventId: spec.oddsEventId } : {}),
        ...(spec.kickoff ? { kickoff: Date.parse(spec.kickoff) } : {}),
        ...(spec.polyTokenId ? { polyToken: spec.polyTokenId } : {}),
        polyAt: 0,
        bookAt: 0,
        inv: saved?.inv ?? emptyInventory(),
        orders: new Map((saved?.orders ?? []).map((o) => [o.id, o])),
        mode: "idle",
        lastMergeAt: saved?.lastMergeAt ?? 0,
        mergeFailures: 0,
        lastRequoteAt: {},
      };
      if (spec.disabled) {
        st.mode = "paused";
        st.pauseReason = "disabled in config";
      }
      this.markets.set(spec.predictMarketId, st);
      log.info(`market ${info.id} "${info.title}" status=${info.status} negRisk=${info.isNegRisk} yield=${info.isYieldBearing} fee=${info.feeRateBps}bps outcome=${spec.outcome}`);
      if (info.status && !/open|active|registered/i.test(info.status)) log.warn(`market ${info.id} status is ${info.status}`);
    }
    if (this.markets.size > this.cfg.risk.maxMarkets) log.warn(`${this.markets.size} markets configured, risk.maxMarkets=${this.cfg.risk.maxMarkets}: the extra ones wait`);
    if (this.deps.poly && this.cfg.poly.enabled) await this.resolvePoly();
  }

  private async resolvePoly(): Promise<void> {
    for (const m of this.markets.values()) {
      if (m.polyToken || !m.spec.polySlug) continue;
      try {
        const ev = await this.deps.poly!.eventBySlug(m.spec.polySlug);
        if (!ev) {
          log.warn(`market ${m.info.id}: polymarket event ${m.spec.polySlug} not found`);
          continue;
        }
        const pm = PolyClient.pickMarket(ev, m.spec.outcome, m.teams, m.spec.polyMarketQuestion, this.cfg.aliases);
        if (!pm) {
          log.warn(`market ${m.info.id}: no polymarket market for outcome ${m.spec.outcome} in ${m.spec.polySlug} (markets: ${ev.markets.map((x) => x.question).join(" | ")})`);
          continue;
        }
        m.polyToken = pm.yesTokenId;
        log.info(`market ${m.info.id}: polymarket cross-check "${pm.question}" token=${pm.yesTokenId.slice(0, 10)}…`);
      } catch (e) {
        log.warn(`market ${m.info.id}: polymarket lookup failed: ${(e as Error).message}`);
      }
    }
  }

  private setupWs(): void {
    const ws = this.deps.ws;
    if (!ws) return;
    ws.on("book", (book: Book) => {
      const m = this.markets.get(book.marketId);
      if (!m) return;
      m.book = book;
      m.bookAt = Date.now();
    });
    ws.on("wallet", (ev: WalletEvent) => {
      if (/orderTransactionSuccess|orderTransactionSubmitted|orderCancelled|orderExpired|orderNotAccepted/.test(ev.type)) {
        log.debug(`wallet event ${ev.type} order=${ev.orderId ?? ev.orderHash ?? "?"}`);
        this.syncRequested = true;
      }
    });
    ws.on("open", () => {
      for (const id of this.markets.keys()) ws.subscribeOrderbook(id);
    });
    ws.connect();
    for (const id of this.markets.keys()) ws.subscribeOrderbook(id);
    if (!this.cfg.dryRun && this.deps.trader) {
      this.deps.trader
        .authenticate()
        .then((jwt) => ws.subscribeWallet(jwt))
        .catch((e) => log.warn(`wallet websocket auth failed (polling only): ${(e as Error).message}`));
    }
  }

  // =================================================================== tick

  private async tick(): Promise<void> {
    const now = Date.now();
    this.rollDay(now);
    await this.refreshOdds(false);
    for (const m of this.markets.values()) await this.updateFair(m, now);
    await this.refreshBooks(now);
    if (this.syncRequested || now - this.lastOrdersSync >= this.cfg.predict.pollOrdersSec * 1000) await this.syncOrders(false);
    if (now - this.lastPositionsSync >= this.cfg.predict.pollPositionsSec * 1000) await this.syncPositions(false);
    this.decideModes(now);
    this.checkDailyStop();
    await this.quoteAll(now);
    await this.mergeAll(now);
    this.processMarkouts(now);
    this.persistState();
    if (now - this.lastStatusAt >= 60_000) {
      this.printStatus();
      this.lastStatusAt = now;
    }
  }

  private rollDay(now: number): void {
    const key = dayKey(now);
    if (key !== this.risk.dayKey) {
      log.info(`new UTC day ${key}: resetting daily PnL (${fmtUsd(this.risk.realizedToday)}) and stop flag`);
      this.risk = { dayKey: key, realizedToday: 0, stopped: false, stopReason: undefined };
    }
  }

  // ================================================================== odds

  private async refreshOdds(force: boolean): Promise<void> {
    const odds = this.deps.odds;
    if (!odds) return;
    const now = Date.now();
    if (!force && now - this.lastOddsFetch < this.cfg.odds.refreshSec * 1000) return;
    const active = [...this.markets.values()].filter((m) => !m.spec.disabled && m.mode !== "done");
    const sports = new Set<string>();
    for (const m of active) if (m.oddsSport) sports.add(m.oddsSport);
    if (sports.size === 0) {
      if (active.length > 0) log.warn("no oddsSport configured on any market; run `scan` to generate market entries");
      this.lastOddsFetch = now;
      return;
    }
    const rem = odds.credits.remaining;
    if (rem !== undefined && rem <= this.cfg.odds.minCreditsReserve) {
      log.warn(`odds credits nearly exhausted (${rem} left): skipping refresh, quotes will go stale and cancel`);
      this.lastOddsFetch = now;
      return;
    }
    for (const sport of sports) {
      const ms = active.filter((m) => m.oddsSport === sport);
      const allMatched = ms.every((m) => m.oddsEventId);
      const eventIds = allMatched ? ms.map((m) => m.oddsEventId as string) : undefined;
      try {
        const events = await odds.fetchH2H(sport, this.cfg.odds.bookmakers, eventIds, this.cfg.odds.regions);
        this.oddsCache.set(sport, { events, fetchedAt: Date.now() });
        for (const m of ms) if (!m.oddsEventId) this.matchOddsEvent(m, events);
        this.deps.journal.append("odds", { sport, events: events.length, credits: odds.credits });
      } catch (e) {
        log.error(`odds refresh failed for ${sport}: ${(e as Error).message}`);
      }
    }
    this.lastOddsFetch = Date.now();
  }

  private matchOddsEvent(m: MarketState, events: OddsEvent[]): void {
    const text = `${m.info.categoryTitle ?? ""} ${m.info.title} ${m.info.question}`;
    const ranked = rankEvents(text, events, this.cfg.aliases, m.kickoff);
    const best = ranked[0];
    if (!best || best.score < 2) {
      log.warn(`market ${m.info.id}: no odds event matched both teams (best: ${best ? `${best.event.homeTeam} v ${best.event.awayTeam} score=${best.score}` : "none"}); set oddsEventId in config`);
      return;
    }
    const second = ranked[1];
    if (second && second.score === 2 && Math.abs(second.event.commenceTime - best.event.commenceTime) > 6 * 3600_000 && !m.kickoff) {
      log.warn(`market ${m.info.id}: ambiguous odds match (${best.event.homeTeam} v ${best.event.awayTeam} on ${new Date(best.event.commenceTime).toISOString()} vs ${new Date(second.event.commenceTime).toISOString()}); set oddsEventId or kickoff in config`);
      return;
    }
    m.oddsEventId = best.event.id;
    m.teams = m.teams ?? { home: best.event.homeTeam, away: best.event.awayTeam };
    if (!m.kickoff) m.kickoff = best.event.commenceTime;
    const detected = detectOutcome(text, m.teams, this.cfg.aliases);
    if (detected && detected !== m.spec.outcome) log.warn(`market ${m.info.id}: title suggests outcome "${detected}" but config says "${m.spec.outcome}" — double check!`);
    log.info(`market ${m.info.id}: matched odds event ${best.event.id} ${best.event.homeTeam} v ${best.event.awayTeam} kickoff=${new Date(m.kickoff).toISOString()}`);
  }

  private findEvent(m: MarketState): OddsEvent | undefined {
    if (!m.oddsSport || !m.oddsEventId) return undefined;
    return this.oddsCache.get(m.oddsSport)?.events.find((e) => e.id === m.oddsEventId);
  }

  private async updateFair(m: MarketState, now: number): Promise<void> {
    const ev = this.findEvent(m);
    if (!ev) {
      m.fair = { p: NaN, oddsP: NaN, ok: false, reason: "no odds event", asOf: 0, dispersion: 0, nSources: 0 };
      return;
    }
    if (!m.spec.kickoff && m.kickoff !== ev.commenceTime) {
      if (m.kickoff) log.warn(`market ${m.info.id}: kickoff moved ${new Date(m.kickoff).toISOString()} -> ${new Date(ev.commenceTime).toISOString()} (odds feed)`);
      m.kickoff = ev.commenceTime;
    }
    if (!m.teams) m.teams = { home: ev.homeTeam, away: ev.awayTeam };
    const est = combineFair(ev, {
      weights: this.cfg.odds.weights,
      devig: this.cfg.odds.devig,
      maxSourceAgeSec: this.cfg.odds.maxSourceAgeSec,
      maxExchangeSpread: this.cfg.odds.maxExchangeSpread,
      now,
    });
    if (!est) {
      m.fair = { p: NaN, oddsP: NaN, ok: false, reason: "all odds sources stale", asOf: ev.fetchedAt, dispersion: 0, nSources: 0 };
      return;
    }
    m.fairEstimate = est;
    const oddsP = est.p[m.spec.outcome];
    const dispersion = est.dispersion[m.spec.outcome];
    const fair: MarketFair = { p: oddsP, oddsP, ok: true, asOf: ev.fetchedAt, dispersion, nSources: est.nSources };
    if (est.nSources < this.cfg.odds.minSources) {
      fair.ok = false;
      fair.reason = `only ${est.nSources} odds source(s)`;
    } else if (dispersion > this.cfg.odds.maxSourceDispersion) {
      fair.ok = false;
      fair.reason = `sources disagree (${(dispersion * 100).toFixed(1)} pts)`;
    }
    if (now - ev.fetchedAt > this.cfg.odds.maxFairAgeSec * 1000) {
      fair.ok = false;
      fair.reason = `odds stale (${Math.round((now - ev.fetchedAt) / 1000)}s)`;
    }
    await this.applyPoly(m, fair, now);
    m.fair = fair;
  }

  private async applyPoly(m: MarketState, fair: MarketFair, now: number): Promise<void> {
    if (!this.deps.poly || !this.cfg.poly.enabled || !m.polyToken) return;
    if (now - m.polyAt >= this.cfg.poly.refreshSec * 1000) {
      try {
        m.poly = await this.deps.poly.book(m.polyToken, this.cfg.poly.depthWindow);
      } catch (e) {
        log.warn(`market ${m.info.id}: polymarket book failed: ${(e as Error).message}`);
      }
      m.polyAt = now;
    }
    const pb = m.poly;
    if (!pb || pb.mid === undefined || pb.bestBid === undefined || pb.bestAsk === undefined) return;
    fair.polyMid = pb.mid;
    fair.polyExecutable = { bid: pb.bestBid, ask: pb.bestAsk };
    const deep = pb.bidDepthUsd >= this.cfg.poly.minDepthUsd && pb.askDepthUsd >= this.cfg.poly.minDepthUsd;
    if (!deep) return; // thin Poly book: informational only
    const dev = Math.abs(pb.mid - fair.oddsP);
    if (dev > this.cfg.poly.maxDeviation) {
      fair.ok = false;
      fair.reason = `poly mid ${pb.mid.toFixed(3)} vs odds ${fair.oddsP.toFixed(3)} (${(dev * 100).toFixed(1)} pts)`;
      return;
    }
    fair.p = fix((1 - this.cfg.poly.weight) * fair.oddsP + this.cfg.poly.weight * pb.mid);
  }

  // ================================================================== books

  private async refreshBooks(now: number): Promise<void> {
    for (const m of this.markets.values()) {
      if (m.mode === "done" && m.orders.size === 0) continue;
      const wsFresh = this.deps.ws?.connected && now - m.bookAt < 30_000;
      if (wsFresh || now - m.bookAt < this.cfg.predict.pollBookSec * 1000) continue;
      try {
        m.book = await this.deps.api.getOrderbook(m.info.id);
        m.bookAt = now;
      } catch (e) {
        log.warn(`market ${m.info.id}: orderbook fetch failed: ${(e as Error).message}`);
        throw e;
      }
    }
  }

  // ================================================================= orders

  private tokenOf(m: MarketState, tokenId: string): Token | null {
    if (tokenId === m.info.yesTokenId) return "YES";
    if (tokenId === m.info.noTokenId) return "NO";
    return null;
  }

  private liveFromRaw(m: MarketState, raw: RawOrder, prev?: LiveOrder): LiveOrder | null {
    const token = this.tokenOf(m, String(raw.order.tokenId));
    if (!token) return null;
    const makerAmt = weiToNumber(raw.order.makerAmount);
    const takerAmt = weiToNumber(raw.order.takerAmount);
    const action: OrderAction = Number(raw.order.side) === 0 ? "BUY" : "SELL";
    const qty = action === "BUY" ? takerAmt : makerAmt;
    const price = qty > 0 ? (action === "BUY" ? makerAmt / qty : takerAmt / qty) : 0;
    const amount = safeBig(raw.amount);
    const filled = safeBig(raw.amountFilled);
    const ratio = amount > 0n ? Number((filled * 1_000_000n) / amount) / 1_000_000 : 0;
    const status = String(raw.status ?? "OPEN").toUpperCase();
    let filledQty = fix(Math.min(qty, qty * ratio));
    if (status === "FILLED") filledQty = fix(qty); // guard against an unexpected `amount` unit
    return {
      id: String(raw.id),
      hash: String(raw.order.hash),
      marketId: m.info.id,
      action,
      token,
      price: fix(price),
      qty: fix(qty),
      filledQty,
      status,
      expiresAt: Number(raw.order.expiration) * 1000,
      placedAt: prev?.placedAt ?? (raw.createdAt ? Date.parse(raw.createdAt) : Date.now()),
      tokenId: String(raw.order.tokenId),
      order: raw.order as unknown as Record<string, unknown>,
    };
  }

  /** Reconcile tracked orders with the exchange and turn fill deltas into inventory. */
  private async syncOrders(initial: boolean): Promise<void> {
    this.syncRequested = false;
    this.lastOrdersSync = Date.now();
    if (this.cfg.dryRun) {
      this.simulateFills();
      return;
    }
    const open = await this.deps.api.getOpenOrders();
    const openById = new Map(open.map((o) => [String(o.id), o]));
    for (const m of this.markets.values()) {
      // adopt untracked open orders on our tokens (manual orders / lost state)
      for (const raw of open) {
        const id = String(raw.id);
        if (m.orders.has(id)) continue;
        const live = this.liveFromRaw(m, raw);
        if (!live) continue;
        m.orders.set(id, live);
        log.info(`market ${m.info.id}: adopted open order ${id} ${live.action} ${live.token} ${live.qty}@${live.price}`);
      }
      for (const [id, tracked] of [...m.orders]) {
        let raw = openById.get(id);
        if (!raw) {
          const fetched = await this.deps.api.getOrder(tracked.hash);
          if (!fetched) {
            if (initial) log.warn(`market ${m.info.id}: order ${id} unknown to the api; dropping`);
            m.orders.delete(id);
            continue;
          }
          raw = fetched;
        }
        const live = this.liveFromRaw(m, raw, tracked);
        if (!live) {
          m.orders.delete(id);
          continue;
        }
        const delta = fix(live.filledQty - tracked.filledQty);
        if (delta > 1e-6) this.recordFill(m, live, delta);
        if (live.status === "OPEN") m.orders.set(id, live);
        else {
          m.orders.delete(id);
          this.deps.journal.append("order_closed", { marketId: m.info.id, orderId: id, status: live.status, filledQty: live.filledQty, qty: live.qty });
        }
      }
    }
  }

  /** Dry-run: a resting order fills when the book trades through its price. */
  private simulateFills(): void {
    for (const m of this.markets.values()) {
      if (!m.book) continue;
      const top = bookTop(m.book);
      for (const [id, o] of [...m.orders]) {
        if (o.expiresAt && Date.now() > o.expiresAt) {
          m.orders.delete(id);
          this.deps.journal.append("order_closed", { marketId: m.info.id, orderId: id, status: "EXPIRED", simulated: true });
          continue;
        }
        let crossed = false;
        if (o.action === "BUY" && o.token === "YES") crossed = top.bestAskYes !== undefined && top.bestAskYes <= o.price;
        if (o.action === "BUY" && o.token === "NO") crossed = top.bestAskNo !== undefined && top.bestAskNo <= o.price;
        if (o.action === "SELL" && o.token === "YES") crossed = top.bestBidYes !== undefined && top.bestBidYes >= o.price;
        if (o.action === "SELL" && o.token === "NO") crossed = top.bestBidNo !== undefined && top.bestBidNo >= o.price;
        if (!crossed) continue;
        const delta = fix(o.qty - o.filledQty);
        const filled = { ...o, filledQty: o.qty, status: "FILLED" };
        this.recordFill(m, filled, delta);
        m.orders.delete(id);
        this.deps.journal.append("order_closed", { marketId: m.info.id, orderId: id, status: "FILLED", simulated: true });
      }
    }
  }

  private recordFill(m: MarketState, o: LiveOrder, qty: number): void {
    const before = m.inv;
    m.inv = applyFill(m.inv, { action: o.action, token: o.token, price: o.price, qty });
    const realizedDelta = fix(m.inv.realizedPnl - before.realizedPnl);
    this.risk.realizedToday = fix(this.risk.realizedToday + realizedDelta);
    const mid = m.book ? midFor(m.book, o.token) : undefined;
    const fair = m.fair?.ok ? (o.token === "YES" ? m.fair.p : fix(1 - m.fair.p)) : undefined;
    log.info(`FILL market=${m.info.id} ${o.action} ${o.token} ${qty}@${o.price} (order ${o.id}) inv yes=${m.inv.yesQty} no=${m.inv.noQty} realized=${fmtUsd(m.inv.realizedPnl)}`);
    this.deps.journal.append("fill", {
      marketId: m.info.id,
      label: m.spec.label ?? m.info.title,
      orderId: o.id,
      action: o.action,
      token: o.token,
      price: o.price,
      qty,
      notional: fix(qty * o.price),
      realizedDelta,
      mid,
      fair,
      inv: m.inv,
      simulated: Boolean(o.simulated),
    });
    this.markouts.push({ marketId: m.info.id, orderId: o.id, token: o.token, action: o.action, price: o.price, qty, t0: Date.now(), ...(mid !== undefined ? { mid0: mid } : {}), ...(fair !== undefined ? { fair0: fair } : {}) });
  }

  private processMarkouts(now: number): void {
    for (const mo of this.markouts) {
      const m = this.markets.get(mo.marketId);
      if (!m) continue;
      const mid = m.book ? midFor(m.book, mo.token) : undefined;
      const fair = m.fair?.ok ? (mo.token === "YES" ? m.fair.p : fix(1 - m.fair.p)) : undefined;
      if (mo.mid10 === undefined && mo.fair10 === undefined && now - mo.t0 >= 10_000) {
        mo.mid10 = mid ?? NaN;
        mo.fair10 = fair ?? NaN;
      }
      if (mo.mid60 === undefined && mo.fair60 === undefined && now - mo.t0 >= 60_000) {
        mo.mid60 = mid ?? NaN;
        mo.fair60 = fair ?? NaN;
        const sign = mo.action === "BUY" ? 1 : -1;
        this.deps.journal.append("markout", {
          marketId: mo.marketId,
          orderId: mo.orderId,
          action: mo.action,
          token: mo.token,
          price: mo.price,
          qty: mo.qty,
          mid0: mo.mid0,
          mid10: mo.mid10,
          mid60: mo.mid60,
          fair0: mo.fair0,
          fair10: mo.fair10,
          fair60: mo.fair60,
          markoutMid10: mo.mid10 !== undefined && Number.isFinite(mo.mid10) ? fix(sign * (mo.mid10 - mo.price)) : null,
          markoutMid60: Number.isFinite(mo.mid60) ? fix(sign * (mo.mid60 - mo.price)) : null,
          markoutFair60: Number.isFinite(mo.fair60) ? fix(sign * ((mo.fair60 as number) - mo.price)) : null,
        });
      }
    }
    this.markouts = this.markouts.filter((mo) => mo.mid60 === undefined && mo.fair60 === undefined);
  }

  // ============================================================== positions

  private async syncPositions(initial: boolean): Promise<void> {
    this.lastPositionsSync = Date.now();
    if (this.cfg.dryRun) return;
    let positions;
    try {
      positions = await this.deps.api.getPositions();
    } catch (e) {
      log.warn(`positions fetch failed: ${(e as Error).message}`);
      return;
    }
    for (const m of this.markets.values()) {
      let yes = 0;
      let no = 0;
      for (const p of positions) {
        if (Number(p.market?.id) !== m.info.id) continue;
        const token = this.tokenOf(m, String(p.outcome?.onChainId ?? ""));
        const amt = weiToNumber(safeBig(p.amount));
        if (token === "YES") yes += amt;
        if (token === "NO") no += amt;
      }
      yes = fix(yes);
      no = fix(no);
      const dy = fix(yes - m.inv.yesQty);
      const dn = fix(no - m.inv.noQty);
      if (Math.abs(dy) > 0.01 || Math.abs(dn) > 0.01) {
        const lvl = initial ? log.info : log.warn;
        lvl(`market ${m.info.id}: on-chain position yes=${yes} no=${no} differs from tracked yes=${m.inv.yesQty} no=${m.inv.noQty}; adopting on-chain quantities`);
        // keep average costs, adopt quantities (pending settlements can lag a few seconds)
        const ay = m.inv.yesQty > 0 ? m.inv.yesCost / m.inv.yesQty : m.fair?.ok ? m.fair.p : 0.5;
        const an = m.inv.noQty > 0 ? m.inv.noCost / m.inv.noQty : m.fair?.ok ? 1 - m.fair.p : 0.5;
        m.inv = { ...m.inv, yesQty: yes, noQty: no, yesCost: fix(yes * ay), noCost: fix(no * an) };
      }
    }
  }

  // ================================================================= modes

  private decideModes(now: number): void {
    const active: MarketState[] = [];
    for (const m of this.markets.values()) {
      if (m.spec.disabled) continue;
      const prev = m.mode;
      m.pauseReason = undefined;
      if (!m.kickoff) {
        m.mode = "paused";
        m.pauseReason = "kickoff unknown (no odds event matched)";
      } else if (now >= m.kickoff) {
        m.mode = "done";
      } else if (now >= m.kickoff - hours(this.cfg.schedule.quoteEndHoursBeforeKickoff)) {
        m.mode = "exiting";
      } else if (now < m.kickoff - hours(this.cfg.schedule.quoteStartHoursBeforeKickoff)) {
        m.mode = "idle";
      } else {
        m.mode = "quoting";
      }
      if ((m.mode === "quoting" || m.mode === "exiting") && !m.fair?.ok) {
        m.mode = "paused";
        m.pauseReason = m.fair?.reason ?? "no fair value";
      }
      if (this.risk.stopped && m.mode !== "done") {
        m.mode = "paused";
        m.pauseReason = `daily stop: ${this.risk.stopReason ?? ""}`;
      }
      if (m.mode === "quoting" || m.mode === "exiting") active.push(m);
      if (m.mode !== prev) {
        log.info(`market ${m.info.id}: ${prev} -> ${m.mode}${m.pauseReason ? ` (${m.pauseReason})` : ""}`);
        this.deps.journal.append("mode", { marketId: m.info.id, from: prev, to: m.mode, reason: m.pauseReason ?? null });
      }
    }
    // only the N earliest kickoffs may add new risk
    active.sort((a, b) => (a.kickoff ?? 0) - (b.kickoff ?? 0));
    let n = 0;
    for (const m of active) {
      const hasRisk = m.orders.size > 0 || inventoryCost(m.inv) > 0;
      if (n < this.cfg.risk.maxMarkets || hasRisk) {
        n++;
        continue;
      }
      m.mode = "paused";
      m.pauseReason = `risk.maxMarkets=${this.cfg.risk.maxMarkets} reached`;
    }
  }

  private exitPrices(m: MarketState): { yes: number; no: number } {
    const top = m.book ? bookTop(m.book) : {};
    const fairYes = m.fair?.ok ? m.fair.p : m.inv.yesQty > 0 ? m.inv.yesCost / m.inv.yesQty : 0.5;
    const slip = this.cfg.schedule.exitMaxSlippage;
    return {
      yes: top.bestBidYes ?? Math.max(0, fairYes - slip),
      no: top.bestBidNo ?? Math.max(0, 1 - fairYes - slip),
    };
  }

  private checkDailyStop(): void {
    if (this.risk.stopped) return;
    let unrealized = 0;
    for (const m of this.markets.values()) unrealized += markToMarket(m.inv, this.exitPrices(m));
    const total = fix(this.risk.realizedToday + unrealized);
    if (total <= -this.cfg.risk.dailyStopLossUsd) {
      this.risk.stopped = true;
      this.risk.stopReason = `pnl ${fmtUsd(total)} (realized ${fmtUsd(this.risk.realizedToday)}, unrealized ${fmtUsd(unrealized)})`;
      log.error(`DAILY STOP triggered: ${this.risk.stopReason}. Cancelling all orders; positions are kept.`);
      this.deps.journal.append("daily_stop", { realized: this.risk.realizedToday, unrealized, total });
      for (const m of this.markets.values()) {
        m.mode = "paused";
        m.pauseReason = `daily stop: ${this.risk.stopReason}`;
      }
    }
  }

  // ================================================================ quoting

  private capitalUsed(): number {
    let used = 0;
    for (const m of this.markets.values()) {
      used += inventoryCost(m.inv);
      for (const o of m.orders.values()) if (o.action === "BUY" && o.status === "OPEN") used += (o.qty - o.filledQty) * o.price;
    }
    return used;
  }

  private async quoteAll(now: number): Promise<void> {
    const usedTotal = this.capitalUsed();
    for (const m of this.markets.values()) {
      if (m.mode === "quoting" || m.mode === "exiting") {
        if (!m.book || !m.fair?.ok) continue;
        const ownBids = [...m.orders.values()].filter((o) => o.action === "BUY" && o.status === "OPEN").reduce((a, o) => a + (o.qty - o.filledQty) * o.price, 0);
        const desired = computeQuotes({
          fairYes: m.fair.p,
          book: m.book,
          inv: m.inv,
          quote: this.cfg.quote,
          maxUnpairedCost: this.cfg.risk.maxUnpairedCostPerMarketUsd,
          capitalAvailable: this.cfg.risk.maxCapitalUsd - usedTotal + ownBids,
          maxOrderCost: this.cfg.risk.maxOrderCostUsd,
          openOrders: [...m.orders.values()],
          mode: m.mode,
          exitMaxSlippage: this.cfg.schedule.exitMaxSlippage,
          exitMode: this.cfg.schedule.exitMode,
        });
        await this.reconcile(m, desired, now);
      } else if (m.orders.size > 0) {
        await this.cancelMarketOrders(m, `mode=${m.mode}${m.pauseReason ? ` (${m.pauseReason})` : ""}`);
      }
    }
  }

  private async reconcile(m: MarketState, desired: DesiredQuote[], now: number): Promise<void> {
    const keep = new Set<string>();
    const satisfied = new Set<number>();
    const toCancel: LiveOrder[] = [];
    for (const o of m.orders.values()) {
      if (o.status !== "OPEN") continue;
      const expiringSoon = o.expiresAt > 0 && o.expiresAt - now < 120_000;
      let idx = -1;
      if (!expiringSoon) idx = desired.findIndex((q, i) => !satisfied.has(i) && orderMatchesQuote(o, q, this.cfg.quote));
      if (idx >= 0) {
        keep.add(o.id);
        satisfied.add(idx);
      } else {
        toCancel.push(o);
      }
    }
    if (toCancel.length > 0) await this.cancelOrders(m, toCancel, "requote");
    let placed = 0;
    for (let i = 0; i < desired.length; i++) {
      if (satisfied.has(i)) continue;
      const q = desired[i] as DesiredQuote;
      const key = `${q.action}:${q.token}`;
      if (placed >= 3) break;
      try {
        await this.place(m, q);
        m.lastRequoteAt[key] = now;
        placed++;
      } catch (e) {
        log.error(`market ${m.info.id}: place ${q.action} ${q.token} ${q.qty}@${q.price} failed: ${(e as Error).message}`);
        this.deps.journal.append("order_error", { marketId: m.info.id, quote: q, error: (e as Error).message });
        break;
      }
    }
  }

  private async place(m: MarketState, q: DesiredQuote): Promise<void> {
    const ttl = this.cfg.quote.orderTtlSec;
    let live: LiveOrder;
    if (this.cfg.dryRun || !this.deps.trader) {
      const id = `sim-${this.simCounter++}`;
      live = {
        id,
        hash: id,
        marketId: m.info.id,
        action: q.action,
        token: q.token,
        price: q.price,
        qty: q.qty,
        filledQty: 0,
        status: "OPEN",
        expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : 0,
        placedAt: Date.now(),
        tokenId: q.token === "YES" ? m.info.yesTokenId : m.info.noTokenId,
        order: {},
        simulated: true,
      };
    } else {
      const res = await this.deps.trader.placeLimit(m.info, q.token, q.action, q.price, q.qty, ttl);
      live = {
        id: res.orderId || res.orderHash,
        hash: res.orderHash,
        marketId: m.info.id,
        action: q.action,
        token: q.token,
        price: q.price,
        qty: q.qty,
        filledQty: 0,
        status: "OPEN",
        expiresAt: Number(res.order.expiration) * 1000,
        placedAt: Date.now(),
        tokenId: String(res.order.tokenId),
        order: res.order as unknown as Record<string, unknown>,
      };
    }
    m.orders.set(live.id, live);
    log.info(`PLACE market=${m.info.id} ${q.action} ${q.token} ${q.qty}@${q.price} (${q.reason}) fair=${m.fair?.p.toFixed(3)}${live.simulated ? " [sim]" : ""}`);
    this.deps.journal.append("order", { marketId: m.info.id, orderId: live.id, hash: live.hash, action: q.action, token: q.token, price: q.price, qty: q.qty, reason: q.reason, fair: m.fair?.p, simulated: Boolean(live.simulated) });
  }

  private async cancelOrders(m: MarketState, orders: LiveOrder[], reason: string): Promise<void> {
    if (orders.length === 0) return;
    const real = orders.filter((o) => !o.simulated);
    if (real.length > 0 && this.deps.trader) {
      const res = await this.deps.trader.cancelByIds(real.map((o) => o.id));
      log.debug(`cancel result removed=${res.removed.length} noop=${res.noop.length}`);
    }
    for (const o of orders) {
      log.info(`CANCEL market=${m.info.id} ${o.action} ${o.token} ${o.qty - o.filledQty}@${o.price} (${reason})${o.simulated ? " [sim]" : ""}`);
      this.deps.journal.append("cancel", { marketId: m.info.id, orderId: o.id, action: o.action, token: o.token, price: o.price, remaining: fix(o.qty - o.filledQty), reason });
      m.lastRequoteAt[`${o.action}:${o.token}`] = Date.now();
      m.orders.delete(o.id);
    }
    // a cancelled order may have filled in the meantime: resync soon
    this.syncRequested = true;
  }

  private async cancelMarketOrders(m: MarketState, reason: string): Promise<void> {
    await this.cancelOrders(m, [...m.orders.values()], reason);
  }

  async cancelAll(reason: string): Promise<void> {
    for (const m of this.markets.values()) await this.cancelMarketOrders(m, reason);
  }

  private async handleDisconnect(): Promise<void> {
    const down = Date.now() - this.lastApiOk;
    if (down < this.cfg.predict.disconnectCancelSec * 1000 || this.disconnectCancelled) return;
    log.error(`api unreachable for ${Math.round(down / 1000)}s: cancelling all orders (best effort)`);
    try {
      await this.cancelAll("api disconnect");
      this.disconnectCancelled = true;
    } catch (e) {
      log.error(`cancel during disconnect failed (orders still expire after ${this.cfg.quote.orderTtlSec}s): ${(e as Error).message}`);
    }
  }

  // ================================================================== merge

  private async mergeAll(now: number): Promise<void> {
    if (!this.cfg.merge.enabled) return;
    for (const m of this.markets.values()) {
      const pairs = Math.floor(pairedQty(m.inv) * 100) / 100;
      if (pairs < this.cfg.merge.minShares) continue;
      if (now - m.lastMergeAt < this.cfg.merge.cooldownSec * 1000) continue;
      if (m.mergeFailures >= 3 && now - m.lastMergeAt < 30 * 60_000) continue;
      m.lastMergeAt = now;
      if (this.cfg.dryRun || !this.deps.trader) {
        const before = m.inv.realizedPnl;
        m.inv = applyMerge(m.inv, pairs);
        const pnl = fix(m.inv.realizedPnl - before);
        this.risk.realizedToday = fix(this.risk.realizedToday + pnl);
        log.info(`MERGE [sim] market=${m.info.id} ${pairs} pairs pnl=${fmtUsd(pnl)} realized=${fmtUsd(m.inv.realizedPnl)}`);
        this.deps.journal.append("merge", { marketId: m.info.id, pairs, pnl, simulated: true, inv: m.inv });
        continue;
      }
      try {
        const before = m.inv.realizedPnl;
        const res = await this.deps.trader.merge(m.info, pairs);
        if (!res.success) throw new Error(res.error ?? "merge failed");
        m.inv = applyMerge(m.inv, pairs);
        m.mergeFailures = 0;
        const pnl = fix(m.inv.realizedPnl - before);
        this.risk.realizedToday = fix(this.risk.realizedToday + pnl);
        log.info(`MERGE market=${m.info.id} ${pairs} pairs tx=${res.txHash ?? "?"} pnl=${fmtUsd(pnl)}`);
        this.deps.journal.append("merge", { marketId: m.info.id, pairs, txHash: res.txHash ?? null, pnl, inv: m.inv });
        this.lastPositionsSync = 0; // re-read on-chain balances
      } catch (e) {
        m.mergeFailures++;
        m.lastMergeError = (e as Error).message;
        log.error(`market ${m.info.id}: merge failed (${m.mergeFailures}): ${m.lastMergeError}`);
        this.deps.journal.append("merge_error", { marketId: m.info.id, pairs, error: m.lastMergeError });
      }
    }
  }

  // ================================================================= status

  private persistState(): void {
    const markets: PersistedState["markets"] = {};
    for (const m of this.markets.values()) {
      markets[String(m.info.id)] = { inv: m.inv, orders: [...m.orders.values()], lastMergeAt: m.lastMergeAt };
    }
    const st: PersistedState = { version: 1, savedAt: Date.now(), risk: { ...this.risk }, markets, simCounter: this.simCounter };
    this.deps.journal.saveState(st);
  }

  /** Realised / unrealised PnL and capital in use, for status output. */
  pnlSnapshot(): { realizedToday: number; unrealized: number; capitalUsed: number; stopped: boolean } {
    let unrealized = 0;
    for (const m of this.markets.values()) unrealized += markToMarket(m.inv, this.exitPrices(m));
    return { realizedToday: this.risk.realizedToday, unrealized: fix(unrealized), capitalUsed: fix(this.capitalUsed()), stopped: this.risk.stopped };
  }

  /** Human-readable status block (also served by the HTTP status endpoint). */
  statusText(): string {
    const lines: string[] = [];
    for (const m of this.markets.values()) {
      const top = m.book ? bookTop(m.book) : {};
      const u = unpaired(m.inv);
      const mtm = markToMarket(m.inv, this.exitPrices(m));
      const bids = [...m.orders.values()].filter((o) => o.status === "OPEN").map((o) => `${o.action === "BUY" ? "B" : "S"}${o.token[0]}${o.qty - o.filledQty}@${o.price}`).join(" ");
      const fair = m.fair?.ok ? `fair=${m.fair.p.toFixed(3)}${m.fair.polyMid !== undefined ? `/poly=${m.fair.polyMid.toFixed(3)}` : ""}` : `fair=n/a(${m.fair?.reason ?? "?"})`;
      const kick = m.kickoff ? `${((m.kickoff - Date.now()) / 3600_000).toFixed(1)}h` : "?";
      lines.push(
        `  [${m.info.id}] ${m.spec.label ?? m.info.title.slice(0, 40)} mode=${m.mode}${m.pauseReason ? `(${m.pauseReason})` : ""} T-${kick} ${fair} book=${top.bestBidYes ?? "-"}/${top.bestAskYes ?? "-"} inv yes=${m.inv.yesQty} no=${m.inv.noQty} unpaired=${u.token ?? "-"}:${u.qty.toFixed(2)}(${fmtUsd(u.cost)}) realized=${fmtUsd(m.inv.realizedPnl)} mtm=${fmtUsd(mtm)} orders: ${bids || "none"}`,
      );
    }
    const credits = this.deps.odds?.credits.remaining;
    const p = this.pnlSnapshot();
    return `STATUS ${new Date().toISOString()} dryRun=${this.cfg.dryRun} capital=${fmtUsd(p.capitalUsed)}/${this.cfg.risk.maxCapitalUsd} realizedToday=${fmtUsd(p.realizedToday)} unrealized=${fmtUsd(p.unrealized)}${p.stopped ? " STOPPED" : ""} oddsCredits=${credits ?? "?"} ws=${this.deps.ws?.connected ? "up" : "down"}\n${lines.join("\n")}`;
  }

  printStatus(): void {
    log.info(this.statusText());
    this.deps.journal.append("pnl", this.pnlSnapshot());
  }
}

// -------------------------------------------------------------------- utils

function dayKey(t: number): string {
  return new Date(Math.floor(t / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

function safeBig(v: unknown): bigint {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(Math.trunc(v));
    if (typeof v === "string" && v.trim() !== "") return BigInt(v.replace(/n$/, "").split(".")[0] as string);
  } catch {
    /* fallthrough */
  }
  return 0n;
}

function midFor(book: Book, token: Token): number | undefined {
  const top = bookTop(book);
  if (top.bestBidYes === undefined || top.bestAskYes === undefined) return undefined;
  const midYes = (top.bestBidYes + top.bestAskYes) / 2;
  return fix(token === "YES" ? midYes : 1 - midYes);
}
