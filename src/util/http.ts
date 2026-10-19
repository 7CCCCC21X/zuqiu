import { log } from "../logger";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} ${url}: ${body.slice(0, 300)}`);
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  /** do not log the URL (it carries an api key) */
  quiet?: boolean;
}

export interface JsonResponse<T> {
  data: T;
  headers: Headers;
  status: number;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function requestJson<T = unknown>(url: string, opts: RequestOptions = {}): Promise<JsonResponse<T>> {
  const retries = opts.retries ?? 2;
  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= retries) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(opts.headers ?? {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new HttpError(res.status, opts.quiet ? "<redacted>" : url, text);
        if (RETRYABLE.has(res.status) && attempt < retries) {
          lastErr = err;
          attempt++;
          await backoff(attempt, res.headers.get("retry-after"));
          continue;
        }
        throw err;
      }
      const data = (text ? JSON.parse(text) : null) as T;
      return { data, headers: res.headers, status: res.status };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      lastErr = e;
      if (attempt < retries) {
        attempt++;
        log.debug(`request failed (${(e as Error).message}); retry ${attempt}/${retries}`);
        await backoff(attempt, null);
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function backoff(attempt: number, retryAfter: string | null): Promise<void> {
  let ms = Math.min(8000, 500 * 2 ** attempt);
  if (retryAfter) {
    const s = Number.parseFloat(retryAfter);
    if (Number.isFinite(s)) ms = Math.max(ms, s * 1000);
  }
  await new Promise((r) => setTimeout(r, ms));
}
