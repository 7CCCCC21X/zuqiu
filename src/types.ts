/**
 * Shared types for the predict.fun football market-making bot.
 */

export type Outcome = "home" | "draw" | "away";
export type Token = "YES" | "NO";
export type OrderAction = "BUY" | "SELL";

/** One bookmaker's 1X2 prices for a single event (decimal odds). */
export interface BookmakerOdds {
  key: string;
  title: string;
  lastUpdate: number; // epoch ms
  back: { home: number; draw: number; away: number };
  /** Lay odds (betting exchanges only, from the h2h_lay market). */
  lay?: { home: number; draw: number; away: number };
}

export interface OddsEvent {
  id: string;
  sportKey: string;
  commenceTime: number; // epoch ms (kickoff)
  homeTeam: string;
  awayTeam: string;
  bookmakers: BookmakerOdds[];
  fetchedAt: number;
}

export interface SourceProbability {
  key: string;
  weight: number;
  p: { home: number; draw: number; away: number };
  lastUpdate: number;
  stale: boolean;
  /** Implied-probability gap between back and lay (exchanges only). */
  exchangeSpread?: number;
  overround: number;
}

export interface FairEstimate {
  p: { home: number; draw: number; away: number };
  sources: SourceProbability[];
  /** max - min probability of the selected outcome across live sources */
  dispersion: { home: number; draw: number; away: number };
  nSources: number;
  asOf: number;
}

export interface MarketFair {
  /** fair YES probability for the configured outcome */
  p: number;
  oddsP: number;
  polyMid?: number;
  polyExecutable?: { bid: number; ask: number };
  ok: boolean;
  reason?: string;
  asOf: number;
  dispersion: number;
  nSources: number;
}

/** predict.fun market, normalised from GET /v1/markets. */
export interface PredictMarketInfo {
  id: number;
  title: string;
  question: string;
  description?: string;
  slug?: string;
  conditionId: string;
  status: string;
  categorySlug?: string;
  categoryTitle?: string;
  isNegRisk: boolean;
  isYieldBearing: boolean;
  feeRateBps: number;
  yesTokenId: string;
  noTokenId: string;
  yesIndexSet: number;
  noIndexSet: number;
  /** best-effort kickoff/close timestamp found on the market object */
  endsAt?: number;
  raw: Record<string, unknown>;
}

/** YES-denominated order book, best level first. */
export interface Book {
  marketId: number;
  ts: number;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
}

export interface LiveOrder {
  id: string;
  hash: string;
  marketId: number;
  action: OrderAction;
  token: Token;
  price: number;
  qty: number;
  filledQty: number;
  status: string;
  expiresAt: number;
  placedAt: number;
  tokenId: string;
  /** signed order struct, needed for on-chain cancel */
  order: Record<string, unknown>;
  simulated?: boolean;
}

export interface Fill {
  t: number;
  marketId: number;
  orderId: string;
  action: OrderAction;
  token: Token;
  price: number;
  qty: number;
  fairAtFill?: number;
  midAtFill?: number;
}

export interface MarketInventory {
  yesQty: number;
  noQty: number;
  yesCost: number; // total USDT paid for current YES qty
  noCost: number;
  realizedPnl: number;
  mergedPairs: number;
  fills: number;
}

export interface DesiredQuote {
  action: OrderAction;
  token: Token;
  price: number;
  qty: number;
  reason: string;
}

export type MarketMode = "idle" | "quoting" | "exiting" | "paused" | "done";

export interface MarketSpec {
  predictMarketId: number;
  outcome: Outcome;
  label?: string;
  oddsSport?: string;
  oddsEventId?: string;
  teams?: { home: string; away: string };
  /** ISO kickoff; overrides what the odds feed says */
  kickoff?: string;
  polySlug?: string;
  polyMarketQuestion?: string;
  polyTokenId?: string;
  /** when true the bot never quotes this market (useful for parking entries) */
  disabled?: boolean;
}

export interface Config {
  network: "mainnet" | "testnet";
  dryRun: boolean;
  dataDir: string;
  loopIntervalSec: number;
  logLevel: "debug" | "info" | "warn" | "error";
  predict: {
    apiBase: string;
    wsUrl: string;
    rpcUrl?: string;
    pollOrdersSec: number;
    pollPositionsSec: number;
    pollBookSec: number;
    cancelOnExit: boolean;
    disconnectCancelSec: number;
  };
  odds: {
    bookmakers: string[];
    weights: Record<string, number>;
    regions: string;
    refreshSec: number;
    maxSourceAgeSec: number;
    maxFairAgeSec: number;
    devig: "multiplicative" | "power";
    maxExchangeSpread: number;
    maxSourceDispersion: number;
    minSources: number;
    minCreditsReserve: number;
  };
  poly: {
    enabled: boolean;
    weight: number;
    maxDeviation: number;
    minDepthUsd: number;
    depthWindow: number;
    refreshSec: number;
    gammaBase: string;
    clobBase: string;
  };
  quote: {
    tickSize: number;
    halfSpread: number;
    minEdge: number;
    skewMax: number;
    orderCostUsd: number;
    minOrderShares: number;
    orderTtlSec: number;
    requoteTicks: number;
    requoteSizeRatio: number;
    sellInventory: boolean;
    postOnly: boolean;
    minPrice: number;
    maxPrice: number;
  };
  risk: {
    maxCapitalUsd: number;
    maxMarkets: number;
    maxUnpairedCostPerMarketUsd: number;
    dailyStopLossUsd: number;
    maxOrderCostUsd: number;
  };
  schedule: {
    quoteStartHoursBeforeKickoff: number;
    quoteEndHoursBeforeKickoff: number;
    exitMode: "merge_and_sell" | "merge_and_hold";
    exitMaxSlippage: number;
  };
  merge: {
    enabled: boolean;
    minShares: number;
    cooldownSec: number;
  };
  ws: { enabled: boolean };
  markets: MarketSpec[];
  aliases: Record<string, string>;
}

export interface Secrets {
  predictApiKey?: string;
  predictPrivateKey?: string;
  predictAccount?: string;
  oddsApiKey?: string;
}
