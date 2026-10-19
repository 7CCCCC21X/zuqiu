import { formatEther, parseEther } from "ethers";

const EPS = 1e-9;

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Round to the nearest multiple of tick (ties away from zero). */
export function roundTick(x: number, tick: number): number {
  return fix(Math.round(x / tick + EPS) * tick);
}

export function floorTick(x: number, tick: number): number {
  return fix(Math.floor(x / tick + EPS) * tick);
}

export function ceilTick(x: number, tick: number): number {
  return fix(Math.ceil(x / tick - EPS) * tick);
}

/** Remove binary floating noise: keep 6 decimals. */
export function fix(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

export function fmtPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

export function fmtUsd(x: number): string {
  return `${x >= 0 ? "" : "-"}${Math.abs(x).toFixed(2)}U`;
}

/** price (0..1, max 3 decimals) -> wei bigint */
export function priceToWei(price: number): bigint {
  return parseEther(price.toFixed(3));
}

/** share quantity (max 2 decimals) -> wei bigint */
export function qtyToWei(qty: number): bigint {
  return parseEther(qty.toFixed(2));
}

export function weiToNumber(wei: bigint | string | number): number {
  if (typeof wei === "number") return wei;
  const b = typeof wei === "bigint" ? wei : BigInt(wei);
  return Number.parseFloat(formatEther(b));
}

export function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string") {
    const s = v.endsWith("n") ? v.slice(0, -1) : v;
    return BigInt(s);
  }
  throw new Error(`cannot convert ${String(v)} to bigint`);
}

export function num(v: unknown, fallback = 0): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

export function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function nowMs(): number {
  return Date.now();
}

export function hours(h: number): number {
  return h * 3600 * 1000;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
