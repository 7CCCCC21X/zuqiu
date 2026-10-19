import { requestJson, HttpError } from "../util/http";
import { log } from "../logger";
import { num } from "../util/num";
import type { Book, PredictMarketInfo } from "../types";

export interface Envelope<T> {
  success?: boolean;
  data?: T;
  cursor?: string | null;
  error?: { code?: string; message?: string } | string;
  [k: string]: unknown;
}

export interface RawOrder {
  id: string;
  marketId: number;
  amount: string;
  amountFilled: string;
  isNegRisk: boolean;
  isYieldBearing: boolean;
  strategy: string;
  status: string;
  createdAt?: string;
  pricePerShare?: string;
  order: {
    hash: string;
    salt: string;
    maker: string;
    signer: string;
    taker: string;
    tokenId: string;
    makerAmount: string;
    takerAmount: string;
    expiration: string;
    nonce: string;
    feeRateBps: string;
    side: number;
    signatureType: number;
    signature: string;
  };
  [k: string]: unknown;
}

export interface RawPosition {
  id: string;
  market: { id: number; title?: string; conditionId?: string; [k: string]: unknown };
  outcome: { name: string; indexSet: number; onChainId: string; status?: string | null };
  amount: string;
  valueUsd?: string;
  [k: string]: unknown;
}

export class PredictApi {
  jwt?: string;

  constructor(
    readonly base: string,
    private readonly apiKey?: string,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.apiKey) h["x-api-key"] = this.apiKey;
    if (this.jwt) h.authorization = `Bearer ${this.jwt}`;
    return h;
  }

  async get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<Envelope<T>> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== "") qs.set(k, String(v));
    const url = `${this.base}${path}${qs.size ? `?${qs.toString()}` : ""}`;
    const res = await requestJson<Envelope<T> | T>(url, { headers: this.headers() });
    return unwrap(res.data);
  }

  async post<T>(path: string, body: unknown, retries = 0): Promise<Envelope<T>> {
    const res = await requestJson<Envelope<T> | T>(`${this.base}${path}`, { method: "POST", body, headers: this.headers(), retries });
    return unwrap(res.data);
  }

  // ---------------------------------------------------------------- markets

  async getMarketsPage(after?: string, first = 100, extra: Record<string, string | undefined> = {}): Promise<{ markets: PredictMarketInfo[]; cursor?: string }> {
    const env = await this.get<unknown>("/v1/markets", { first, after, ...extra });
    const list = asArray(env.data);
    return { markets: list.map(normalizeMarket), ...(env.cursor ? { cursor: env.cursor } : {}) };
  }

  async listMarkets(opts: { maxPages?: number; extra?: Record<string, string | undefined>; onPage?: (n: number, got: number) => void } = {}): Promise<PredictMarketInfo[]> {
    const out: PredictMarketInfo[] = [];
    let after: string | undefined;
    const maxPages = opts.maxPages ?? 20;
    for (let page = 0; page < maxPages; page++) {
      const { markets, cursor } = await this.getMarketsPage(after, 100, opts.extra ?? {});
      out.push(...markets);
      opts.onPage?.(page + 1, out.length);
      if (!cursor || markets.length === 0 || cursor === after) break;
      after = cursor;
    }
    return out;
  }

  async getMarket(id: number): Promise<PredictMarketInfo> {
    const env = await this.get<Record<string, unknown>>(`/v1/markets/${id}`);
    if (!env.data) throw new Error(`market ${id} not found`);
    return normalizeMarket(env.data);
  }

  async getCategory(slug: string): Promise<{ raw: Record<string, unknown>; markets: PredictMarketInfo[] }> {
    const env = await this.get<Record<string, unknown>>(`/v1/categories/${encodeURIComponent(slug)}`);
    const raw = env.data ?? {};
    const markets = asArray(raw.markets).map((m) => normalizeMarket({ ...m, categorySlug: raw.slug ?? slug, categoryTitle: raw.title }));
    return { raw, markets };
  }

  async listCategories(maxPages = 10, extra: Record<string, string | undefined> = {}): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let after: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const env = await this.get<unknown>("/v1/categories", { first: 100, after, ...extra });
      const list = asArray(env.data);
      out.push(...list);
      if (!env.cursor || list.length === 0 || env.cursor === after) break;
      after = env.cursor;
    }
    return out;
  }

  async getOrderbook(marketId: number): Promise<Book> {
    const env = await this.get<Record<string, unknown>>(`/v1/markets/${marketId}/orderbook`);
    return normalizeBook(env.data ?? {}, marketId);
  }

  // ----------------------------------------------------------------- orders

  async getOpenOrders(): Promise<RawOrder[]> {
    const out: RawOrder[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const env = await this.get<unknown>("/v1/orders", { status: "OPEN", first: 100, after });
      const list = asArray(env.data) as unknown as RawOrder[];
      out.push(...list);
      if (!env.cursor || list.length === 0 || env.cursor === after) break;
      after = env.cursor;
    }
    return out;
  }

  async getOrder(hash: string): Promise<RawOrder | null> {
    try {
      const env = await this.get<RawOrder>(`/v1/orders/${hash}`);
      return env.data ?? null;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  /** Best-effort: order match (fill) events for the account. */
  async getOrderMatches(params: Record<string, string | number | undefined> = {}): Promise<Array<Record<string, unknown>>> {
    for (const path of ["/v1/orders/matches", "/v1/orders/match-events"]) {
      try {
        const env = await this.get<unknown>(path, params);
        return asArray(env.data);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) continue;
        throw e;
      }
    }
    return [];
  }

  async createOrder(body: unknown): Promise<{ orderId: string; orderHash: string; code?: string; raw: unknown }> {
    const env = await this.post<Record<string, unknown>>("/v1/orders", body);
    const d = (env.data ?? env) as Record<string, unknown>;
    const orderId = String(d.orderId ?? d.id ?? "");
    const orderHash = String(d.orderHash ?? d.hash ?? "");
    if (env.success === false || !orderHash) {
      throw new Error(`createOrder rejected: ${JSON.stringify(env).slice(0, 400)}`);
    }
    return { orderId, orderHash, ...(typeof d.code === "string" ? { code: d.code } : {}), raw: env };
  }

  async removeOrders(ids: string[]): Promise<{ removed: string[]; noop: string[] }> {
    if (ids.length === 0) return { removed: [], noop: [] };
    const out = { removed: [] as string[], noop: [] as string[] };
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const env = await this.post<Record<string, unknown>>("/v1/orders/remove", { data: { ids: chunk } }, 1);
      const d = (env.data && typeof env.data === "object" ? env.data : env) as Record<string, unknown>;
      out.removed.push(...asArray(d.removed).map(String));
      out.noop.push(...asArray(d.noop).map(String));
      if (env.success === false) log.warn(`removeOrders returned success=false: ${JSON.stringify(env).slice(0, 300)}`);
    }
    return out;
  }

  // -------------------------------------------------------------- positions

  async getPositions(): Promise<RawPosition[]> {
    const out: RawPosition[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const env = await this.get<unknown>("/v1/positions", { first: 100, after });
      const list = asArray(env.data) as unknown as RawPosition[];
      out.push(...list);
      if (!env.cursor || list.length === 0 || env.cursor === after) break;
      after = env.cursor;
    }
    return out;
  }

  // ------------------------------------------------------------------- auth

  async getAuthMessage(): Promise<string> {
    const env = await this.get<{ message: string }>("/v1/auth/message");
    const msg = env.data?.message;
    if (!msg) throw new Error("auth message missing");
    return msg;
  }

  async authenticate(signer: string, signature: string, message: string): Promise<string> {
    const env = await this.post<{ token: string }>("/v1/auth", { signer, signature, message });
    const token = env.data?.token;
    if (!token) throw new Error(`auth failed: ${JSON.stringify(env).slice(0, 300)}`);
    this.jwt = token;
    return token;
  }
}

// ------------------------------------------------------------------ helpers

function unwrap<T>(body: Envelope<T> | T): Envelope<T> {
  if (body && typeof body === "object" && ("data" in (body as object) || "success" in (body as object))) {
    const env = body as Envelope<T>;
    if (env.success === false) {
      const err = typeof env.error === "string" ? env.error : env.error?.message ?? JSON.stringify(env).slice(0, 300);
      throw new Error(`predict api error: ${err}`);
    }
    return env;
  }
  return { success: true, data: body as T };
}

function asArray(v: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["items", "markets", "orders", "positions", "results", "data"]) {
      if (Array.isArray(o[k])) return o[k] as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function firstTimestamp(o: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string") {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      return v > 1e12 ? v : v * 1000;
    }
  }
  return undefined;
}

export function normalizeMarket(m: Record<string, unknown>): PredictMarketInfo {
  const outcomes = asArray(m.outcomes);
  const byName = (re: RegExp) => outcomes.find((o) => re.test(String(o.name ?? "")));
  const byIndex = (i: number) => outcomes.find((o) => num(o.indexSet) === i);
  const yes = byName(/^yes$/i) ?? byIndex(1) ?? outcomes[0];
  const no = byName(/^no$/i) ?? outcomes.find((o) => o !== yes && num(o.indexSet) === 2) ?? outcomes.find((o) => o !== yes);
  const category = (m.category && typeof m.category === "object" ? (m.category as Record<string, unknown>) : undefined) ?? {};
  const categorySlug = (m.categorySlug as string | undefined) ?? (category.slug as string | undefined);
  const categoryTitle = (m.categoryTitle as string | undefined) ?? (category.title as string | undefined);
  const endsAt = firstTimestamp(m, ["endsAt", "endAt", "closesAt", "closeAt", "endDate", "eventStartsAt", "startsAt", "startAt", "kickoffAt", "resolvesAt"]);
  const description = (m.description ?? m.rules ?? m.resolutionRules ?? m.details) as string | undefined;
  return {
    id: num(m.id),
    title: String(m.title ?? m.name ?? ""),
    question: String(m.question ?? m.title ?? ""),
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof m.slug === "string" ? { slug: m.slug } : {}),
    conditionId: String(m.conditionId ?? ""),
    status: String(m.status ?? ""),
    ...(categorySlug ? { categorySlug } : {}),
    ...(categoryTitle ? { categoryTitle } : {}),
    isNegRisk: Boolean(m.isNegRisk),
    isYieldBearing: Boolean(m.isYieldBearing),
    feeRateBps: num(m.feeRateBps),
    yesTokenId: String(yes?.onChainId ?? ""),
    noTokenId: String(no?.onChainId ?? ""),
    yesIndexSet: num(yes?.indexSet, 1),
    noIndexSet: num(no?.indexSet, 2),
    ...(endsAt !== undefined ? { endsAt } : {}),
    raw: m,
  };
}

function toLevel(l: unknown): [number, number] | null {
  if (Array.isArray(l) && l.length >= 2) {
    const p = num(l[0], NaN);
    const q = num(l[1], NaN);
    return Number.isFinite(p) && Number.isFinite(q) ? [p, q] : null;
  }
  if (l && typeof l === "object") {
    const o = l as Record<string, unknown>;
    const p = num(o.price, NaN);
    const q = num(o.size ?? o.quantity ?? o.qty, NaN);
    return Number.isFinite(p) && Number.isFinite(q) ? [p, q] : null;
  }
  return null;
}

export function normalizeBook(d: Record<string, unknown>, marketId: number): Book {
  const bids = (Array.isArray(d.bids) ? d.bids : []).map(toLevel).filter((x): x is [number, number] => x !== null && x[1] > 0).sort((a, b) => b[0] - a[0]);
  const asks = (Array.isArray(d.asks) ? d.asks : []).map(toLevel).filter((x): x is [number, number] => x !== null && x[1] > 0).sort((a, b) => a[0] - b[0]);
  const ts = num(d.updateTimestampMs ?? d.timestamp, Date.now());
  return { marketId: num(d.marketId, marketId), ts: ts > 1e12 ? ts : Date.now(), bids, asks };
}
