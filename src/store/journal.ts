import fs from "node:fs";
import path from "node:path";

export interface JournalRecord {
  t: number;
  type: string;
  [k: string]: unknown;
}

export class Journal {
  private readonly file: string;
  private readonly stateFile: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "journal.jsonl");
    this.stateFile = path.join(dataDir, "state.json");
  }

  append(type: string, record: Record<string, unknown>): void {
    const line = JSON.stringify({ t: Date.now(), type, ...record }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    fs.appendFileSync(this.file, `${line}\n`);
  }

  readAll(): JournalRecord[] {
    if (!fs.existsSync(this.file)) return [];
    const out: JournalRecord[] = [];
    for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as JournalRecord);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  }

  saveState(state: unknown): void {
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    fs.renameSync(tmp, this.stateFile);
  }

  loadState<T>(): T | null {
    if (!fs.existsSync(this.stateFile)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as T;
    } catch {
      return null;
    }
  }
}
