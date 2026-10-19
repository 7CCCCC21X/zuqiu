import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { log } from "../logger";
import { normalizeBook } from "./api";
import type { Book } from "../types";

export interface WalletEvent {
  type: string;
  orderHash?: string;
  orderId?: string;
  txHash?: string;
  reason?: string;
  details?: { price?: string; quantity?: string; quantityFilled?: string; outcome?: string; quoteType?: string };
  raw: Record<string, unknown>;
}

/**
 * Minimal predict.fun websocket client.
 * Protocol (type "R" = request response, "M" = push):
 *   -> {"method":"subscribe","requestId":1,"params":["predictOrderbook/123"]}
 *   <- {"type":"R","requestId":1,"success":true}
 *   <- {"type":"M","topic":"predictOrderbook/123","data":{...}}
 *   <- {"type":"M","topic":"heartbeat","data":1736696400000}   -> echo {"method":"heartbeat","data":1736696400000}
 */
export class PredictWs extends EventEmitter {
  private ws?: WebSocket;
  private topics = new Set<string>();
  private reqId = 1;
  private closed = false;
  private reconnectDelay = 1000;
  lastMessageAt = 0;
  connected = false;

  constructor(
    private readonly url: string,
    private readonly apiKey?: string,
  ) {
    super();
  }

  connect(): void {
    this.closed = false;
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    const ws = new WebSocket(this.url, { headers, handshakeTimeout: 10_000 });
    this.ws = ws;
    ws.on("open", () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      this.lastMessageAt = Date.now();
      log.info(`ws connected ${this.url}`);
      for (const t of this.topics) this.send({ method: "subscribe", requestId: this.reqId++, params: [t] });
      this.emit("open");
    });
    ws.on("message", (data) => {
      this.lastMessageAt = Date.now();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      this.handle(msg);
    });
    ws.on("close", (code, reason) => {
      this.connected = false;
      log.warn(`ws closed code=${code} ${reason.toString()}`);
      this.emit("close");
      this.scheduleReconnect();
    });
    ws.on("error", (err) => {
      log.warn(`ws error: ${err.message}`);
      this.emit("wsError", err);
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(30_000, this.reconnectDelay * 2);
    setTimeout(() => {
      if (!this.closed) this.connect();
    }, delay).unref();
  }

  private send(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private handle(msg: Record<string, unknown>): void {
    const type = msg.type;
    if (type === "R") {
      if (msg.success === false) log.warn(`ws request ${String(msg.requestId)} failed: ${JSON.stringify(msg.error ?? msg)}`);
      return;
    }
    if (type !== "M") return;
    const topic = String(msg.topic ?? "");
    const data = msg.data;
    if (topic === "heartbeat") {
      this.send({ method: "heartbeat", data });
      return;
    }
    if (topic.startsWith("predictOrderbook/")) {
      const marketId = Number.parseInt(topic.slice("predictOrderbook/".length), 10);
      if (data && typeof data === "object") {
        const book: Book = normalizeBook(data as Record<string, unknown>, marketId);
        this.emit("book", book);
      }
      return;
    }
    if (topic.startsWith("predictWalletEvents/")) {
      const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
      const ev: WalletEvent = {
        type: String(d.type ?? ""),
        ...(d.orderHash !== undefined ? { orderHash: String(d.orderHash) } : {}),
        ...(d.orderId !== undefined ? { orderId: String(d.orderId).replace(/n$/, "") } : {}),
        ...(typeof d.txHash === "string" ? { txHash: d.txHash } : {}),
        ...(typeof d.reason === "string" ? { reason: d.reason } : {}),
        ...(d.details && typeof d.details === "object" ? { details: d.details as WalletEvent["details"] } : {}),
        raw: d,
      };
      this.emit("wallet", ev);
      return;
    }
    this.emit("other", msg);
  }

  subscribe(topic: string): void {
    if (this.topics.has(topic)) return;
    this.topics.add(topic);
    this.send({ method: "subscribe", requestId: this.reqId++, params: [topic] });
  }

  unsubscribe(topic: string): void {
    if (!this.topics.delete(topic)) return;
    this.send({ method: "unsubscribe", requestId: this.reqId++, params: [topic] });
  }

  subscribeOrderbook(marketId: number): void {
    this.subscribe(`predictOrderbook/${marketId}`);
  }

  subscribeWallet(jwt: string): void {
    this.subscribe(`predictWalletEvents/${jwt}`);
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
