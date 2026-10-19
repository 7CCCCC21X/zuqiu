import http from "node:http";
import { log } from "./logger";
import { buildReport } from "./report";
import type { Engine } from "./mm/engine";
import type { Journal } from "./store/journal";

/**
 * Tiny status endpoint, enabled when PORT is set (e.g. on Railway):
 *   GET /          plain-text status (same block the log prints every minute)
 *   GET /state     JSON view of every market
 *   GET /report    PnL / fill / markout report from the journal
 *   GET /health    200 ok
 * Set STATUS_TOKEN to require ?token=... (or an x-status-token header).
 */
export function startStatusServer(port: number, engine: Engine, journal: Journal, token?: string): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (token && url.searchParams.get("token") !== token && req.headers["x-status-token"] !== token) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    try {
      if (url.pathname === "/state") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ pnl: engine.pnlSnapshot(), markets: engine.states() }, null, 2));
      } else if (url.pathname === "/report") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(buildReport(journal.readAll(), journal.loadState()));
      } else {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(engine.statusText());
      }
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`error: ${(e as Error).message}`);
    }
  });
  server.listen(port, "0.0.0.0", () => log.info(`status server listening on :${port}${token ? " (token protected)" : ""}`));
  return server;
}
