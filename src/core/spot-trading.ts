import ccxt, { type Exchange } from "ccxt";
import type {
  MetricTags,
  PipelineMode,
  SpotBalanceAsset,
  SpotBalanceSnapshot,
  SpotOrderRequest,
  SpotOrderResult,
  SpotQuoteSnapshot,
  SpotTimeInForce,
  SpotTradeRecord,
  TelemetrySink,
} from "../types";
import { ProviderError, SpotGuardError } from "../types";
import { withTimeout } from "./ops";

type CcxtTicker = { bid?: number; ask?: number; last?: number };
type CcxtOrderBook = { bids?: Array<[number, number]>; asks?: Array<[number, number]> };
type CcxtOrder = {
  id?: string;
  clientOrderId?: string;
  symbol?: string;
  status?: string;
  side?: string;
  type?: string;
  timeInForce?: string;
  amount?: number;
  price?: number;
  average?: number;
  filled?: number;
  remaining?: number;
  cost?: number;
  timestamp?: number;
  datetime?: string;
};
type CcxtTrade = {
  id?: string;
  order?: string;
  symbol?: string;
  side?: string;
  price?: number;
  amount?: number;
  cost?: number;
  fee?: { cost?: number; currency?: string };
  timestamp?: number;
  datetime?: string;
};
type CcxtBalance = {
  free?: Record<string, number>;
  used?: Record<string, number>;
  total?: Record<string, number>;
};
type SpotMarket = {
  symbol?: string;
  spot?: boolean;
  limits?: {
    amount?: { min?: number; max?: number };
    cost?: { min?: number; max?: number };
    price?: { min?: number; max?: number };
  };
};

interface SpotClientLike {
  loadMarkets: () => Promise<Record<string, unknown>>;
  createOrder: (
    symbol: string,
    type: string,
    side: string,
    amount?: number,
    price?: number,
    params?: Record<string, unknown>
  ) => Promise<CcxtOrder>;
  fetchOrder: (id: string, symbol: string, params?: Record<string, unknown>) => Promise<CcxtOrder>;
  fetchOpenOrders: (
    symbol?: string,
    since?: number,
    limit?: number,
    params?: Record<string, unknown>
  ) => Promise<CcxtOrder[]>;
  fetchClosedOrders: (
    symbol?: string,
    since?: number,
    limit?: number,
    params?: Record<string, unknown>
  ) => Promise<CcxtOrder[]>;
  cancelOrder: (id: string, symbol: string, params?: Record<string, unknown>) => Promise<CcxtOrder>;
  cancelAllOrders: (symbol?: string, params?: Record<string, unknown>) => Promise<CcxtOrder[]>;
  fetchBalance: (params?: Record<string, unknown>) => Promise<CcxtBalance>;
  fetchMyTrades: (
    symbol?: string,
    since?: number,
    limit?: number,
    params?: Record<string, unknown>
  ) => Promise<CcxtTrade[]>;
  fetchTicker: (symbol: string, params?: Record<string, unknown>) => Promise<CcxtTicker>;
  fetchTickers?: (symbols?: string[], params?: Record<string, unknown>) => Promise<Record<string, CcxtTicker>>;
  fetchOrderBook: (symbol: string, limit?: number, params?: Record<string, unknown>) => Promise<CcxtOrderBook>;
  amountToPrecision?: (symbol: string, amount: number) => string;
  priceToPrecision?: (symbol: string, price: number) => string;
}

const noopTelemetrySink: TelemetrySink = {
  emitLog: async () => undefined,
  emitMetric: async () => undefined,
  emitAlert: async () => undefined,
};

const stableAssets = new Set(["USD", "USDT", "USDC", "BUSD", "FDUSD"]);

const asNum = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const asPositive = (value: unknown): number | undefined => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const toIso = (orderOrTrade: { datetime?: string; timestamp?: number }): string => {
  if (orderOrTrade.datetime) return String(orderOrTrade.datetime);
  if (typeof orderOrTrade.timestamp === "number" && Number.isFinite(orderOrTrade.timestamp)) {
    return new Date(orderOrTrade.timestamp).toISOString();
  }
  return new Date().toISOString();
};

export interface SpotActionContext {
  runId: string;
  traceId: string;
  mode: PipelineMode;
}

export interface BinanceSpotTradingServiceConfig {
  enabled: boolean;
  apiKey: string;
  apiSecret: string;
  symbolWhitelist: string[];
  defaultTif: SpotTimeInForce;
  recvWindow: number;
  timeoutMs: number;
  telemetrySink?: TelemetrySink;
  mode?: PipelineMode;
  client?: SpotClientLike;
}

export class BinanceSpotTradingService {
  private static instance: BinanceSpotTradingService | null = null;

  public static getInstance(config: BinanceSpotTradingServiceConfig): BinanceSpotTradingService {
    if (!BinanceSpotTradingService.instance) {
      BinanceSpotTradingService.instance = new BinanceSpotTradingService(config);
    }
    return BinanceSpotTradingService.instance;
  }

  private readonly telemetrySink: TelemetrySink;
  private readonly client: SpotClientLike;
  private readonly symbolWhitelist: Set<string>;
  private readonly timeoutMs: number;
  private readonly recvWindow: number;
  private readonly defaultTif: SpotTimeInForce;
  private marketsLoaded = false;
  private markets = new Map<string, SpotMarket>();
  private lastRunId = "spot-run";
  private lastTraceId = "spot-trace";
  private mode: PipelineMode;

  private constructor(private readonly config: BinanceSpotTradingServiceConfig) {
    this.telemetrySink = config.telemetrySink ?? noopTelemetrySink;
    this.timeoutMs = Math.max(1000, config.timeoutMs);
    this.recvWindow = Math.max(1000, config.recvWindow);
    this.defaultTif = config.defaultTif;
    this.mode = config.mode ?? "paper";
    this.symbolWhitelist = new Set(config.symbolWhitelist.map((s) => s.trim().toUpperCase()).filter(Boolean));
    this.client = config.client ?? this.createClient();
  }

  public setRunContext(ctx: SpotActionContext): void {
    this.lastRunId = ctx.runId;
    this.lastTraceId = ctx.traceId;
    this.mode = ctx.mode;
  }

  public async placeOrder(
    request: SpotOrderRequest,
    ctx: SpotActionContext
  ): Promise<SpotOrderResult> {
    this.setRunContext(ctx);
    const action = "spot_place_order";
    const started = Date.now();
    try {
      this.assertEnabled();
      const normalized = await this.validateAndNormalizeRequest(request);
      const params: Record<string, unknown> = { recvWindow: this.recvWindow };
      if (normalized.type === "limit") {
        params.timeInForce = normalized.tif ?? this.defaultTif;
      }
      if (normalized.clientOrderId) {
        params.newClientOrderId = normalized.clientOrderId;
      }
      if (normalized.side === "buy" && normalized.type === "market" && normalized.quoteCost) {
        params.quoteOrderQty = normalized.quoteCost;
      }

      const raw = await withTimeout(
        this.client.createOrder(
          normalized.symbol,
          normalized.type,
          normalized.side,
          normalized.amount,
          normalized.price,
          params
        ),
        this.timeoutMs,
        "BINANCE_SPOT_CREATE_ORDER_TIMEOUT"
      );
      const result = this.mapOrder(raw, normalized.symbol, normalized.side, normalized.type, normalized.tif);
      await this.emitActionSuccess(action, started, {
        symbol: normalized.symbol,
        side: normalized.side,
        type: normalized.type
      }, result);
      return result;
    } catch (error) {
      await this.emitActionFailure(action, started, error, {
        symbol: request.symbol,
        side: request.side,
        type: request.type
      });
      throw this.toSpotError(error, "spot");
    }
  }

  public async fetchOrder(orderId: string, symbol: string, ctx: SpotActionContext): Promise<SpotOrderResult> {
    this.setRunContext(ctx);
    return this.runAction("spot_fetch_order", async () => {
      const normalizedSymbol = symbol.trim().toUpperCase();
      await this.guardSymbol(normalizedSymbol);
      const raw = await withTimeout(
        this.client.fetchOrder(orderId, normalizedSymbol, { recvWindow: this.recvWindow }),
        this.timeoutMs,
        "BINANCE_SPOT_FETCH_ORDER_TIMEOUT"
      );
      return this.mapOrder(raw, normalizedSymbol, "buy", "limit", undefined);
    }, { symbol: symbol.trim().toUpperCase() });
  }

  public async fetchOpenOrders(
    ctx: SpotActionContext,
    symbol?: string,
    limit = 50
  ): Promise<SpotOrderResult[]> {
    this.setRunContext(ctx);
    return this.runAction("spot_fetch_open_orders", async () => {
      const normalizedSymbol = symbol ? symbol.trim().toUpperCase() : undefined;
      if (normalizedSymbol) {
        await this.guardSymbol(normalizedSymbol);
      }
      const rows = await withTimeout(
        this.client.fetchOpenOrders(normalizedSymbol, undefined, Math.max(1, limit), {
          recvWindow: this.recvWindow,
        }),
        this.timeoutMs,
        "BINANCE_SPOT_FETCH_OPEN_ORDERS_TIMEOUT"
      );
      return rows.map((row) => this.mapOrder(row, row.symbol ?? normalizedSymbol ?? "", "buy", "limit", undefined));
    }, { symbol: symbol ? symbol.trim().toUpperCase() : "ALL" });
  }

  public async fetchClosedOrders(
    ctx: SpotActionContext,
    symbol?: string,
    limit = 50
  ): Promise<SpotOrderResult[]> {
    this.setRunContext(ctx);
    return this.runAction("spot_fetch_closed_orders", async () => {
      const normalizedSymbol = symbol ? symbol.trim().toUpperCase() : undefined;
      if (normalizedSymbol) {
        await this.guardSymbol(normalizedSymbol);
      }
      const rows = await withTimeout(
        this.client.fetchClosedOrders(normalizedSymbol, undefined, Math.max(1, limit), {
          recvWindow: this.recvWindow,
        }),
        this.timeoutMs,
        "BINANCE_SPOT_FETCH_CLOSED_ORDERS_TIMEOUT"
      );
      return rows.map((row) => this.mapOrder(row, row.symbol ?? normalizedSymbol ?? "", "buy", "limit", undefined));
    }, { symbol: symbol ? symbol.trim().toUpperCase() : "ALL" });
  }

  public async cancelOrder(orderId: string, symbol: string, ctx: SpotActionContext): Promise<SpotOrderResult> {
    this.setRunContext(ctx);
    return this.runAction("spot_cancel_order", async () => {
      const normalizedSymbol = symbol.trim().toUpperCase();
      await this.guardSymbol(normalizedSymbol);
      const raw = await withTimeout(
        this.client.cancelOrder(orderId, normalizedSymbol, { recvWindow: this.recvWindow }),
        this.timeoutMs,
        "BINANCE_SPOT_CANCEL_ORDER_TIMEOUT"
      );
      return this.mapOrder(raw, normalizedSymbol, "buy", "limit", undefined);
    }, { symbol: symbol.trim().toUpperCase() });
  }

  public async cancelAllOrders(ctx: SpotActionContext, symbol?: string): Promise<SpotOrderResult[]> {
    this.setRunContext(ctx);
    return this.runAction("spot_cancel_all_orders", async () => {
      const normalizedSymbol = symbol ? symbol.trim().toUpperCase() : undefined;
      if (normalizedSymbol) {
        await this.guardSymbol(normalizedSymbol);
      }
      const rows = await withTimeout(
        this.client.cancelAllOrders(normalizedSymbol, { recvWindow: this.recvWindow }),
        this.timeoutMs,
        "BINANCE_SPOT_CANCEL_ALL_ORDERS_TIMEOUT"
      );
      return rows.map((row) => this.mapOrder(row, row.symbol ?? normalizedSymbol ?? "", "buy", "limit", undefined));
    }, { symbol: symbol ? symbol.trim().toUpperCase() : "ALL" });
  }

  public async fetchBalanceSnapshot(ctx: SpotActionContext): Promise<SpotBalanceSnapshot> {
    this.setRunContext(ctx);
    return this.runAction("spot_fetch_balance", async () => {
      this.assertEnabled();
      const balance = await withTimeout(
        this.client.fetchBalance({ recvWindow: this.recvWindow }),
        this.timeoutMs,
        "BINANCE_SPOT_FETCH_BALANCE_TIMEOUT"
      );
      const free = balance.free ?? {};
      const used = balance.used ?? {};
      const total = balance.total ?? {};
      const assets = new Set<string>([...Object.keys(free), ...Object.keys(used), ...Object.keys(total)]);
      const rows: SpotBalanceAsset[] = [];
      for (const asset of assets) {
        const totalVal = asNum(total[asset]);
        const freeVal = asNum(free[asset]);
        const usedVal = asNum(used[asset]);
        if (Math.abs(totalVal) <= 0 && Math.abs(freeVal) <= 0 && Math.abs(usedVal) <= 0) {
          continue;
        }
        rows.push({
          asset,
          free: freeVal,
          used: usedVal,
          total: totalVal,
          usdt_estimate: stableAssets.has(asset.toUpperCase()) ? totalVal : 0,
        });
      }
      const rates = await this.resolveAssetRates(rows.map((r) => r.asset));
      for (const row of rows) {
        if (stableAssets.has(row.asset.toUpperCase())) continue;
        const rate = rates.get(row.asset.toUpperCase()) ?? 0;
        row.usdt_estimate = Number((row.total * rate).toFixed(8));
      }
      const totalUsdtEstimate = Number(rows.reduce((acc, item) => acc + item.usdt_estimate, 0).toFixed(8));
      const topExposure = [...rows]
        .sort((a, b) => Math.abs(b.usdt_estimate) - Math.abs(a.usdt_estimate))
        .slice(0, 10);
      return {
        exchange: "binance",
        timestamp: new Date().toISOString(),
        total_assets: rows.length,
        total_usdt_estimate: totalUsdtEstimate,
        assets: rows.sort((a, b) => a.asset.localeCompare(b.asset)),
        top_exposure: topExposure,
      };
    });
  }

  public async fetchMyTrades(
    symbol: string,
    ctx: SpotActionContext,
    limit = 50
  ): Promise<SpotTradeRecord[]> {
    this.setRunContext(ctx);
    return this.runAction("spot_fetch_my_trades", async () => {
      const normalizedSymbol = symbol.trim().toUpperCase();
      await this.guardSymbol(normalizedSymbol);
      const rows = await withTimeout(
        this.client.fetchMyTrades(normalizedSymbol, undefined, Math.max(1, limit), {
          recvWindow: this.recvWindow,
        }),
        this.timeoutMs,
        "BINANCE_SPOT_FETCH_MY_TRADES_TIMEOUT"
      );
      return rows.map((row) => ({
        id: String(row.id ?? ""),
        orderId: row.order ? String(row.order) : undefined,
        symbol: String(row.symbol ?? normalizedSymbol),
        side: String(row.side).toLowerCase() === "sell" ? "sell" : "buy",
        price: asNum(row.price),
        amount: asNum(row.amount),
        cost: asNum(row.cost),
        feeCost: row.fee?.cost !== undefined ? asNum(row.fee.cost) : undefined,
        feeCurrency: row.fee?.currency,
        timestamp: toIso(row),
      }));
    }, { symbol: symbol.trim().toUpperCase() });
  }

  public async fetchQuote(
    symbol: string,
    ctx: SpotActionContext,
    depth = 5
  ): Promise<SpotQuoteSnapshot> {
    this.setRunContext(ctx);
    return this.runAction("spot_fetch_quote", async () => {
      const normalizedSymbol = symbol.trim().toUpperCase();
      await this.guardSymbol(normalizedSymbol);
      const [ticker, orderbook] = await Promise.all([
        withTimeout(
          this.client.fetchTicker(normalizedSymbol),
          this.timeoutMs,
          "BINANCE_SPOT_FETCH_TICKER_TIMEOUT"
        ),
        withTimeout(
          this.client.fetchOrderBook(normalizedSymbol, Math.max(1, depth)),
          this.timeoutMs,
          "BINANCE_SPOT_FETCH_ORDERBOOK_TIMEOUT"
        ),
      ]);
      const bid = asNum(ticker.bid);
      const ask = asNum(ticker.ask);
      const last = asNum(ticker.last);
      const spreadBps = bid > 0 && ask > 0 ? Number((((ask - bid) / bid) * 10000).toFixed(4)) : 0;
      return {
        symbol: normalizedSymbol,
        timestamp: new Date().toISOString(),
        bid,
        ask,
        last,
        spread_bps: spreadBps,
        orderbook_top: {
          bids: (orderbook.bids ?? []).slice(0, depth),
          asks: (orderbook.asks ?? []).slice(0, depth),
        },
      };
    }, { symbol: symbol.trim().toUpperCase() });
  }

  private async runAction<T>(
    action: string,
    fn: () => Promise<T>,
    tags: Record<string, string> = {}
  ): Promise<T> {
    const started = Date.now();
    try {
      this.assertEnabled();
      const output = await fn();
      await this.emitActionSuccess(action, started, tags, output as unknown as Record<string, unknown>);
      return output;
    } catch (error) {
      await this.emitActionFailure(action, started, error, tags);
      throw this.toSpotError(error, "spot");
    }
  }

  private createClient(): SpotClientLike {
    const ctor = (ccxt as unknown as Record<string, new (args: Record<string, unknown>) => Exchange>).binance;
    return new ctor({
      apiKey: this.config.apiKey,
      secret: this.config.apiSecret,
      enableRateLimit: true,
      timeout: this.timeoutMs,
      options: {
        defaultType: "spot",
        adjustForTimeDifference: true,
        recvWindow: this.recvWindow,
      },
    }) as unknown as SpotClientLike;
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new ProviderError(
        "binance-spot",
        403,
        "BINANCE_SPOT_DISABLED",
        "BINANCE_SPOT_ENABLED must be true for spot actions."
      );
    }
    if (!this.config.apiKey || !this.config.apiSecret) {
      throw new ProviderError(
        "binance-spot",
        401,
        "BINANCE_SPOT_CREDENTIALS_MISSING",
        "BINANCE_API_KEY and BINANCE_API_SECRET are required for spot actions."
      );
    }
  }

  private async ensureMarketsLoaded(): Promise<void> {
    if (this.marketsLoaded) return;
    const markets = await withTimeout(
      this.client.loadMarkets(),
      this.timeoutMs,
      "BINANCE_SPOT_LOAD_MARKETS_TIMEOUT"
    );
    this.markets.clear();
    for (const [symbol, market] of Object.entries(markets)) {
      this.markets.set(symbol.toUpperCase(), market as SpotMarket);
    }
    this.marketsLoaded = true;
  }

  private async guardSymbol(symbol: string): Promise<SpotMarket> {
    await this.ensureMarketsLoaded();
    const normalized = symbol.trim().toUpperCase();
    if (!normalized.includes("/")) {
      throw new SpotGuardError("SPOT_SYMBOL_INVALID", `Invalid spot symbol: ${symbol}`);
    }
    if (this.symbolWhitelist.size > 0 && !this.symbolWhitelist.has(normalized)) {
      throw new SpotGuardError("SPOT_SYMBOL_NOT_WHITELISTED", `Symbol ${normalized} is not whitelisted.`);
    }
    const market = this.markets.get(normalized);
    if (!market) {
      throw new SpotGuardError("SPOT_SYMBOL_NOT_FOUND", `Market ${normalized} is not available on Binance spot.`);
    }
    if (market.spot !== true) {
      throw new SpotGuardError("SPOT_MARKET_REQUIRED", `Market ${normalized} is not a spot market.`);
    }
    return market;
  }

  private async validateAndNormalizeRequest(request: SpotOrderRequest): Promise<SpotOrderRequest> {
    const symbol = request.symbol.trim().toUpperCase();
    const market = await this.guardSymbol(symbol);
    const side = request.side === "sell" ? "sell" : "buy";
    const type = request.type === "limit" ? "limit" : "market";
    const tif = request.tif ?? this.defaultTif;
    const amount = asPositive(request.amount);
    const quoteCost = asPositive(request.quoteCost);
    const price = asPositive(request.price);

    if (type === "limit") {
      if (!amount) {
        throw new SpotGuardError("SPOT_AMOUNT_REQUIRED", "Limit order requires amount > 0.");
      }
      if (!price) {
        throw new SpotGuardError("SPOT_PRICE_REQUIRED", "Limit order requires price > 0.");
      }
    } else if (quoteCost) {
      if (side !== "buy") {
        throw new SpotGuardError("SPOT_QUOTE_COST_ONLY_BUY", "quoteCost is supported only for market buy.");
      }
    } else if (!amount) {
      throw new SpotGuardError("SPOT_AMOUNT_REQUIRED", "Market order requires amount > 0 or quoteCost > 0.");
    }

    if (amount) {
      this.assertAmountGuard(symbol, amount, market);
    }
    if (price) {
      this.assertPriceGuard(symbol, price, market);
    }
    await this.assertNotionalGuard(market, symbol, amount, quoteCost, price);

    return {
      symbol,
      side,
      type,
      amount,
      quoteCost,
      price,
      tif,
      clientOrderId: request.clientOrderId,
    };
  }

  private assertAmountGuard(symbol: string, amount: number, market: SpotMarket): void {
    const min = asPositive(market.limits?.amount?.min);
    const max = asPositive(market.limits?.amount?.max);
    if (min && amount < min) {
      throw new SpotGuardError("SPOT_AMOUNT_BELOW_MIN", `Amount ${amount} < min ${min}.`);
    }
    if (max && amount > max) {
      throw new SpotGuardError("SPOT_AMOUNT_ABOVE_MAX", `Amount ${amount} > max ${max}.`);
    }
    if (this.client.amountToPrecision) {
      const rounded = Number(this.client.amountToPrecision(symbol, amount));
      if (Math.abs(rounded - amount) > 1e-12) {
        throw new SpotGuardError(
          "SPOT_AMOUNT_PRECISION_INVALID",
          `Amount ${amount} does not match market precision.`,
          { rounded }
        );
      }
    }
  }

  private assertPriceGuard(symbol: string, price: number, market: SpotMarket): void {
    const min = asPositive(market.limits?.price?.min);
    const max = asPositive(market.limits?.price?.max);
    if (min && price < min) {
      throw new SpotGuardError("SPOT_PRICE_BELOW_MIN", `Price ${price} < min ${min}.`);
    }
    if (max && price > max) {
      throw new SpotGuardError("SPOT_PRICE_ABOVE_MAX", `Price ${price} > max ${max}.`);
    }
    if (this.client.priceToPrecision) {
      const rounded = Number(this.client.priceToPrecision(symbol, price));
      if (Math.abs(rounded - price) > 1e-12) {
        throw new SpotGuardError(
          "SPOT_PRICE_PRECISION_INVALID",
          `Price ${price} does not match market precision.`,
          { rounded }
        );
      }
    }
  }

  private async assertNotionalGuard(
    market: SpotMarket,
    symbol: string,
    amount?: number,
    quoteCost?: number,
    price?: number
  ): Promise<void> {
    const minCost = asPositive(market.limits?.cost?.min);
    if (!minCost) return;
    let estimatedCost = quoteCost ?? 0;
    if (!estimatedCost && amount) {
      let px = price ?? 0;
      if (!px) {
        const ticker = await withTimeout(
          this.client.fetchTicker(symbol),
          this.timeoutMs,
          "BINANCE_SPOT_TICKER_FOR_GUARD_TIMEOUT"
        );
        px = asNum(ticker.last) || asNum(ticker.bid) || asNum(ticker.ask);
      }
      estimatedCost = amount * px;
    }
    if (estimatedCost > 0 && estimatedCost < minCost) {
      throw new SpotGuardError(
        "SPOT_NOTIONAL_BELOW_MIN",
        `Estimated notional ${estimatedCost.toFixed(8)} < min ${minCost}.`
      );
    }
  }

  private mapOrder(
    row: CcxtOrder,
    fallbackSymbol: string,
    fallbackSide: "buy" | "sell",
    fallbackType: "market" | "limit",
    fallbackTif?: SpotTimeInForce
  ): SpotOrderResult {
    const side = row.side === "sell" ? "sell" : fallbackSide;
    const type = row.type === "market" ? "market" : row.type === "limit" ? "limit" : fallbackType;
    const tifRaw = row.timeInForce ? row.timeInForce.toUpperCase() : fallbackTif;
    const tif: SpotTimeInForce | undefined =
      tifRaw === "GTC" || tifRaw === "IOC" || tifRaw === "FOK" ? tifRaw : undefined;
    return {
      exchange: "binance",
      symbol: String(row.symbol ?? fallbackSymbol),
      orderId: String(row.id ?? ""),
      clientOrderId: row.clientOrderId ? String(row.clientOrderId) : undefined,
      status: String(row.status ?? "unknown"),
      side,
      type,
      timeInForce: tif,
      amount: row.amount !== undefined ? asNum(row.amount) : null,
      price: row.price !== undefined ? asNum(row.price) : null,
      average: row.average !== undefined ? asNum(row.average) : null,
      filled: row.filled !== undefined ? asNum(row.filled) : null,
      remaining: row.remaining !== undefined ? asNum(row.remaining) : null,
      cost: row.cost !== undefined ? asNum(row.cost) : null,
      timestamp: toIso(row),
    };
  }

  private async resolveAssetRates(assets: string[]): Promise<Map<string, number>> {
    const unique = [...new Set(assets.map((a) => a.toUpperCase()))].filter((a) => !stableAssets.has(a));
    if (unique.length === 0) {
      return new Map();
    }

    const symbolCandidates: string[] = [];
    for (const asset of unique) {
      symbolCandidates.push(`${asset}/USDT`);
      symbolCandidates.push(`${asset}/USDC`);
      symbolCandidates.push(`${asset}/BUSD`);
      symbolCandidates.push(`${asset}/FDUSD`);
      symbolCandidates.push(`${asset}/USD`);
    }

    const tickerMap = this.client.fetchTickers
      ? await withTimeout(
          this.client.fetchTickers(),
          this.timeoutMs,
          "BINANCE_SPOT_FETCH_TICKERS_TIMEOUT"
        )
      : {};

    const rates = new Map<string, number>();
    for (const asset of unique) {
      const quote =
        tickerMap[`${asset}/USDT`] ??
        tickerMap[`${asset}/USDC`] ??
        tickerMap[`${asset}/BUSD`] ??
        tickerMap[`${asset}/FDUSD`] ??
        tickerMap[`${asset}/USD`];
      if (!quote) continue;
      const bid = asNum(quote.bid);
      const ask = asNum(quote.ask);
      const last = asNum(quote.last);
      const px = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
      if (px > 0) {
        rates.set(asset, px);
      }
    }
    return rates;
  }

  private async emitActionSuccess(
    action: string,
    startedMs: number,
    extraTags: Record<string, string>,
    output: Record<string, unknown>
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const tags = this.tags(action, extraTags);
    await this.telemetrySink.emitMetric({
      name: "spot_action_latency_ms",
      value: Date.now() - startedMs,
      timestamp: nowIso,
      tags,
    });
    await this.telemetrySink.emitMetric({
      name: "spot_action_success",
      value: 1,
      timestamp: nowIso,
      tags,
    });
    await this.telemetrySink.emitLog({
      timestamp: nowIso,
      level: "info",
      message: `${action} success`,
      trace_id: this.lastTraceId,
      tags,
      data: output as unknown as Record<string, unknown>,
    });
  }

  private async emitActionFailure(
    action: string,
    startedMs: number,
    error: unknown,
    extraTags: Record<string, string>
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const err = this.toSpotError(error, "spot");
    const tags = this.tags(action, { ...extraTags, error_code: err.code });
    await this.telemetrySink.emitMetric({
      name: "spot_action_latency_ms",
      value: Date.now() - startedMs,
      timestamp: nowIso,
      tags,
    });
    await this.telemetrySink.emitMetric({
      name: "spot_action_success",
      value: 0,
      timestamp: nowIso,
      tags,
    });
    await this.telemetrySink.emitAlert({
      timestamp: nowIso,
      name: "spot_action_failed",
      severity: "critical",
      trace_id: this.lastTraceId,
      tags,
      message: err.message,
      error_code: err.code,
      provider: "binance-spot",
      node: "BinanceSpotTradingService",
      last_successful_run: this.lastRunId,
    });
  }

  private tags(action: string, extra: Record<string, string> = {}): MetricTags {
    return {
      run_id: this.lastRunId,
      trace_id: this.lastTraceId,
      mode: this.mode,
      node: "BinanceSpotTradingService",
      provider: "binance-spot",
      source: "system",
      action,
      ...extra,
    };
  }

  private toSpotError(error: unknown, source: string): ProviderError | SpotGuardError {
    if (error instanceof ProviderError || error instanceof SpotGuardError) {
      return error;
    }
    const message = String(error);
    return new ProviderError("binance-spot", 500, `${source.toUpperCase()}_ACTION_FAILED`, message);
  }
}
