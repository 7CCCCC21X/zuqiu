import fs from "node:fs";
import path from "node:path";
import type { Config, MarketSpec, Secrets } from "./types";

const DEFAULTS: Config = {
  network: "mainnet",
  dryRun: true,
  dataDir: "./data",
  loopIntervalSec: 5,
  logLevel: "info",
  predict: {
    apiBase: "",
    wsUrl: "wss://ws.predict.fun/ws",
    rpcUrl: undefined,
    pollOrdersSec: 5,
    pollPositionsSec: 60,
    pollBookSec: 5,
    cancelOnExit: true,
    disconnectCancelSec: 60,
  },
  odds: {
    bookmakers: ["pinnacle", "betfair_ex_eu", "matchbook"],
    weights: { pinnacle: 0.5, betfair_ex_eu: 0.35, matchbook: 0.15 },
    regions: "eu,uk",
    refreshSec: 120,
    maxSourceAgeSec: 900,
    maxFairAgeSec: 420,
    devig: "multiplicative",
    maxExchangeSpread: 0.05,
    maxSourceDispersion: 0.06,
    minSources: 2,
    minCreditsReserve: 20,
  },
  poly: {
    enabled: true,
    weight: 0.25,
    maxDeviation: 0.05,
    minDepthUsd: 50,
    depthWindow: 0.02,
    refreshSec: 30,
    gammaBase: "https://gamma-api.polymarket.com",
    clobBase: "https://clob.polymarket.com",
  },
  quote: {
    tickSize: 0.01,
    halfSpread: 0.015,
    minEdge: 0.005,
    skewMax: 0.02,
    orderCostUsd: 15,
    minOrderShares: 5,
    orderTtlSec: 900,
    requoteTicks: 1,
    requoteSizeRatio: 0.3,
    sellInventory: true,
    postOnly: true,
    minPrice: 0.05,
    maxPrice: 0.95,
  },
  risk: {
    maxCapitalUsd: 300,
    maxMarkets: 3,
    maxUnpairedCostPerMarketUsd: 30,
    dailyStopLossUsd: 10,
    maxOrderCostUsd: 20,
  },
  schedule: {
    quoteStartHoursBeforeKickoff: 24,
    quoteEndHoursBeforeKickoff: 2,
    exitMode: "merge_and_sell",
    exitMaxSlippage: 0.03,
  },
  merge: { enabled: true, minShares: 10, cooldownSec: 120 },
  ws: { enabled: true },
  markets: [],
  aliases: {},
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isObject(override)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override)) {
    const cur = out[k];
    if (isObject(cur) && isObject(v) && k !== "weights" && k !== "aliases") {
      out[k] = deepMerge(cur, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/** Minimal .env loader (no dependency): KEY=VALUE lines, # comments, optional quotes. */
export function loadDotEnv(file = ".env"): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export function loadSecrets(): Secrets {
  return {
    predictApiKey: process.env.PREDICT_API_KEY || undefined,
    predictPrivateKey: process.env.PREDICT_PRIVATE_KEY || undefined,
    predictAccount: process.env.PREDICT_ACCOUNT || undefined,
    oddsApiKey: process.env.ODDS_API_KEY || undefined,
  };
}

function assertNumber(v: unknown, name: string, min?: number, max?: number): void {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`config.${name} must be a number`);
  if (min !== undefined && v < min) throw new Error(`config.${name} must be >= ${min}`);
  if (max !== undefined && v > max) throw new Error(`config.${name} must be <= ${max}`);
}

export function validateConfig(cfg: Config): void {
  if (cfg.network !== "mainnet" && cfg.network !== "testnet") throw new Error("config.network must be mainnet|testnet");
  assertNumber(cfg.quote.tickSize, "quote.tickSize", 0.001, 0.1);
  assertNumber(cfg.quote.halfSpread, "quote.halfSpread", 0, 0.2);
  assertNumber(cfg.quote.minEdge, "quote.minEdge", 0, 0.2);
  assertNumber(cfg.quote.skewMax, "quote.skewMax", 0, 0.2);
  assertNumber(cfg.quote.orderCostUsd, "quote.orderCostUsd", 0.5);
  assertNumber(cfg.quote.minOrderShares, "quote.minOrderShares", 0.01);
  assertNumber(cfg.quote.minPrice, "quote.minPrice", 0.001, 0.5);
  assertNumber(cfg.quote.maxPrice, "quote.maxPrice", 0.5, 0.999);
  assertNumber(cfg.risk.maxCapitalUsd, "risk.maxCapitalUsd", 1);
  assertNumber(cfg.risk.maxMarkets, "risk.maxMarkets", 1);
  assertNumber(cfg.risk.maxUnpairedCostPerMarketUsd, "risk.maxUnpairedCostPerMarketUsd", 1);
  assertNumber(cfg.risk.dailyStopLossUsd, "risk.dailyStopLossUsd", 0);
  assertNumber(cfg.risk.maxOrderCostUsd, "risk.maxOrderCostUsd", 0.5);
  if (cfg.quote.orderCostUsd > cfg.risk.maxOrderCostUsd) throw new Error("quote.orderCostUsd exceeds risk.maxOrderCostUsd");
  assertNumber(cfg.schedule.quoteStartHoursBeforeKickoff, "schedule.quoteStartHoursBeforeKickoff", 0);
  assertNumber(cfg.schedule.quoteEndHoursBeforeKickoff, "schedule.quoteEndHoursBeforeKickoff", 0);
  if (cfg.schedule.quoteEndHoursBeforeKickoff >= cfg.schedule.quoteStartHoursBeforeKickoff) {
    throw new Error("schedule.quoteEndHoursBeforeKickoff must be smaller than quoteStartHoursBeforeKickoff");
  }
  if (cfg.odds.devig !== "multiplicative" && cfg.odds.devig !== "power") throw new Error("odds.devig must be multiplicative|power");
  if (!Array.isArray(cfg.markets)) throw new Error("config.markets must be an array");
  const seen = new Set<number>();
  for (const m of cfg.markets as MarketSpec[]) {
    if (typeof m.predictMarketId !== "number") throw new Error("markets[].predictMarketId must be a number");
    if (seen.has(m.predictMarketId)) throw new Error(`duplicate market ${m.predictMarketId}`);
    seen.add(m.predictMarketId);
    if (!["home", "draw", "away"].includes(m.outcome)) throw new Error(`markets[${m.predictMarketId}].outcome must be home|draw|away`);
  }
  for (const b of cfg.odds.bookmakers) {
    if (cfg.odds.weights[b] === undefined) cfg.odds.weights[b] = 1;
  }
}

/**
 * Environment overrides (handy on hosts without a file system you can edit,
 * e.g. Railway):
 *   CONFIG_PATH   config file to load (default config.json)
 *   CONFIG_JSON   full config as a JSON string; used instead of the file
 *   MARKETS_JSON  JSON array that replaces config.markets
 *   DRY_RUN       true|false
 *   NETWORK       mainnet|testnet
 *   DATA_DIR      where journal.jsonl / state.json live (mount a volume there)
 *   LOG_LEVEL     debug|info|warn|error
 */
export function loadConfig(file?: string): Config {
  loadDotEnv();
  const configPath = file ?? process.env.CONFIG_PATH ?? "config.json";
  let parsed: unknown = {};
  if (process.env.CONFIG_JSON) {
    parsed = JSON.parse(process.env.CONFIG_JSON);
  } else if (fs.existsSync(configPath)) {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } else {
    throw new Error(`config file not found: ${configPath} (copy config.example.json to config.json, or set CONFIG_PATH / CONFIG_JSON)`);
  }
  const cfg = deepMerge(structuredClone(DEFAULTS), parsed);
  if (process.env.MARKETS_JSON) {
    const markets = JSON.parse(process.env.MARKETS_JSON) as unknown;
    if (!Array.isArray(markets)) throw new Error("MARKETS_JSON must be a JSON array");
    cfg.markets = markets as MarketSpec[];
  }
  if (process.env.DRY_RUN !== undefined) cfg.dryRun = !/^(0|false|no|off)$/i.test(process.env.DRY_RUN.trim());
  if (process.env.NETWORK) cfg.network = process.env.NETWORK.trim() as Config["network"];
  if (process.env.DATA_DIR) cfg.dataDir = process.env.DATA_DIR;
  if (process.env.LOG_LEVEL) cfg.logLevel = process.env.LOG_LEVEL.trim() as Config["logLevel"];
  if (!cfg.predict.apiBase) {
    cfg.predict.apiBase = cfg.network === "testnet" ? "https://api-testnet.predict.fun" : "https://api.predict.fun";
  }
  if (!cfg.predict.rpcUrl && process.env.RPC_URL) cfg.predict.rpcUrl = process.env.RPC_URL;
  cfg.dataDir = path.resolve(cfg.dataDir);
  validateConfig(cfg);
  return cfg;
}

export { DEFAULTS as CONFIG_DEFAULTS };
