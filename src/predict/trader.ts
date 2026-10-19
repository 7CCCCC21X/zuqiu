import { JsonRpcProvider, Wallet } from "ethers";
import { ChainId, OrderBuilder, Side } from "@predictdotfun/sdk";
import type { ApprovalStep, Order } from "@predictdotfun/sdk";
import { log } from "../logger";
import { priceToWei, qtyToWei, weiToNumber } from "../util/num";
import type { Config, OrderAction, PredictMarketInfo, Secrets, Token } from "../types";
import type { PredictApi } from "./api";

export interface PlacedOrder {
  orderId: string;
  orderHash: string;
  order: Order & { hash: string; signature: string };
  pricePerShare: bigint;
}

export class PredictTrader {
  private constructor(
    private readonly api: PredictApi,
    readonly builder: OrderBuilder,
    readonly makerAddress: string,
    private readonly wallet: Wallet,
    private readonly predictAccount: string | undefined,
  ) {}

  static async create(cfg: Config, secrets: Secrets, api: PredictApi): Promise<PredictTrader | null> {
    if (!secrets.predictPrivateKey) return null;
    const chainId = cfg.network === "testnet" ? ChainId.BnbTestnet : ChainId.BnbMainnet;
    let wallet = new Wallet(secrets.predictPrivateKey);
    if (cfg.predict.rpcUrl) {
      const provider = new JsonRpcProvider(cfg.predict.rpcUrl, chainId);
      provider.pollingInterval = 300;
      wallet = wallet.connect(provider);
    }
    const options = secrets.predictAccount ? { predictAccount: secrets.predictAccount } : {};
    const builder = await OrderBuilder.make(chainId, wallet, options);
    const maker = secrets.predictAccount ?? wallet.address;
    log.info(`trader ready: maker=${maker} signer=${wallet.address} chain=${chainId}${secrets.predictAccount ? " (predict account)" : " (EOA)"}`);
    return new PredictTrader(api, builder, maker, wallet, secrets.predictAccount);
  }

  /** Make sure TRADE + MERGE approvals exist for every market type we touch. */
  async ensureApprovals(markets: PredictMarketInfo[]): Promise<void> {
    const combos = new Map<string, { isNegRisk: boolean; isYieldBearing: boolean }>();
    for (const m of markets) combos.set(`${m.isNegRisk}/${m.isYieldBearing}`, { isNegRisk: m.isNegRisk, isYieldBearing: m.isYieldBearing });
    const steps: ApprovalStep[] = [];
    for (const c of combos.values()) {
      steps.push(...this.builder.getApprovalSteps({ operation: "TRADE", ...c }));
      steps.push(...this.builder.getApprovalSteps({ operation: "MERGE", ...c }));
    }
    if (steps.length === 0) return;
    const report = await this.builder.runApprovals(steps, {
      skipSatisfied: true,
      stopOnError: true,
      onProgress: ({ step, status }) => {
        if (status !== "checking") log.info(`approval ${step.id}: ${status}`);
      },
    });
    if (!report.success) {
      const failed = report.steps.filter((s) => s.status === "failed").map((s) => s.step.id);
      throw new Error(`approvals failed: ${failed.join(", ")}`);
    }
  }

  async placeLimit(market: PredictMarketInfo, token: Token, action: OrderAction, price: number, qty: number, ttlSec: number): Promise<PlacedOrder> {
    const side = action === "BUY" ? Side.BUY : Side.SELL;
    const tokenId = token === "YES" ? market.yesTokenId : market.noTokenId;
    if (!tokenId) throw new Error(`market ${market.id} has no ${token} token id`);
    const amounts = this.builder.getLimitOrderAmounts({
      side,
      pricePerShareWei: priceToWei(price),
      quantityWei: qtyToWei(qty),
    });
    const expiresAt = ttlSec > 0 ? new Date(Date.now() + ttlSec * 1000) : undefined;
    const order = this.builder.buildOrder("LIMIT", {
      side,
      tokenId,
      makerAmount: amounts.makerAmount,
      takerAmount: amounts.takerAmount,
      nonce: 0n,
      feeRateBps: market.feeRateBps,
      ...(this.predictAccount ? {} : { maker: this.wallet.address, signer: this.wallet.address }),
      ...(expiresAt ? { expiresAt } : {}),
    });
    const typedData = this.builder.buildTypedData(order, { isNegRisk: market.isNegRisk, isYieldBearing: market.isYieldBearing });
    const signed = await this.builder.signTypedDataOrder(typedData);
    const hash = this.builder.buildTypedDataHash(typedData);
    const body = {
      data: {
        order: { ...signed, hash },
        pricePerShare: amounts.pricePerShare.toString(),
        strategy: "LIMIT",
      },
    };
    const res = await this.api.createOrder(body);
    log.debug(`placed ${action} ${token} ${qty}@${price} market=${market.id} id=${res.orderId} hash=${res.orderHash}`);
    return { orderId: res.orderId, orderHash: res.orderHash, order: { ...signed, hash }, pricePerShare: amounts.pricePerShare };
  }

  async cancelByIds(ids: string[]): Promise<{ removed: string[]; noop: string[] }> {
    return this.api.removeOrders(ids);
  }

  /** On-chain cancellation (invalidates the signed orders permanently). */
  async cancelOnChain(items: Array<{ order: Order; isNegRisk: boolean; isYieldBearing: boolean }>): Promise<void> {
    const groups = new Map<string, { flags: { isNegRisk: boolean; isYieldBearing: boolean }; orders: Order[] }>();
    for (const it of items) {
      const k = `${it.isNegRisk}/${it.isYieldBearing}`;
      const g = groups.get(k) ?? { flags: { isNegRisk: it.isNegRisk, isYieldBearing: it.isYieldBearing }, orders: [] };
      g.orders.push(it.order);
      groups.set(k, g);
    }
    for (const g of groups.values()) {
      const res = await this.builder.cancelOrders(g.orders, { ...g.flags, withValidation: false });
      if (!res.success) throw new Error(`on-chain cancel failed: ${res.cause?.message ?? "unknown"}`);
      log.info(`on-chain cancelled ${g.orders.length} orders (${JSON.stringify(g.flags)}) tx=${res.receipt?.hash ?? "?"}`);
    }
  }

  async merge(market: PredictMarketInfo, shares: number): Promise<{ success: boolean; txHash?: string; error?: string }> {
    const res = await this.builder.mergePositions({
      conditionId: market.conditionId,
      amount: qtyToWei(shares),
      isNegRisk: market.isNegRisk,
      isYieldBearing: market.isYieldBearing,
    });
    if (!res.success) return { success: false, error: res.cause?.message ?? "merge failed" };
    return { success: true, ...(res.receipt?.hash ? { txHash: res.receipt.hash } : {}) };
  }

  async usdtBalance(): Promise<number> {
    return weiToNumber(await this.builder.balanceOf("USDT", this.makerAddress));
  }

  /** Obtain a JWT (needed for the predictWalletEvents websocket topic). */
  async authenticate(): Promise<string> {
    const message = await this.api.getAuthMessage();
    const signature = this.predictAccount ? await this.builder.signPredictAccountMessage(message) : await this.wallet.signMessage(message);
    return this.api.authenticate(this.makerAddress, signature, message);
  }
}
