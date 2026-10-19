type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let current: Level = "info";

export function setLogLevel(level: Level): void {
  current = level;
}

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack ?? a.message;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

export const log = {
  debug: (...args: unknown[]) => { if (ORDER[current] <= 10) console.log(`${ts()} DEBUG ${fmt(args)}`); },
  info: (...args: unknown[]) => { if (ORDER[current] <= 20) console.log(`${ts()} INFO  ${fmt(args)}`); },
  warn: (...args: unknown[]) => { if (ORDER[current] <= 30) console.warn(`${ts()} WARN  ${fmt(args)}`); },
  error: (...args: unknown[]) => { if (ORDER[current] <= 40) console.error(`${ts()} ERROR ${fmt(args)}`); },
};
