import ccxt, { type Exchange } from "ccxt";
import type {
  FuturesBalanceAsset,
  FuturesBalanceSnapshot,
  FuturesMarginMode,
  FuturesOrderRequest,
  FuturesOrderResult,
  FuturesPositionMode,
  FuturesPositionSnapshot,
  FuturesQuoteSnapshot,
  FuturesScope,
  FuturesTimeInForce,
  FuturesTradeRecord,
  MetricTags,
  PipelineMode,
  ProtectionSummary,
  TelemetrySink,
} from "../types";
import { FuturesGuardError, ProviderError } from "../types";
import { withTimeout } from "./ops";
import { ProtectionGroupStore, type ProtectionModeRecord } from "./protection-store";

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
  reduceOnly?: boolean;
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
type CcxtPosition = {
  symbol?: string;
  contracts?: number;
  entryPrice?: number;
  markPrice?: number;
  leverage?: number;
  notional?: number;
  unrealizedPnl?: number;
  side?: string;
  marginMode?: string;
};
type FuturesMarket = {
  symbol?: string;
  future?: boolean;
  swap?: boolean;
  linear?: boolean;
  inverse?: boolean;
  contractSize?: number;
  limits?: {
    amount?: { min?: number; max?: number };
    cost?: { min?: number; max?: number };
    price?: { min?: number; max?: number };
  };
};

interface FuturesClientLike {
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
  fetchPositions?: (symbols?: string[], params?: Record<string, unknown>) => Promise<CcxtPosition[]>;
  fetchPosition?: (symbol: string, params?: Record<string, unknown>) => Promise<CcxtPosition>;
  fetchMyTrades: (
    symbol?: string,
    since?: number,
    limit?: number,
    params?: Record<string, unknown>
  ) => Promise<CcxtTrade[]>;
  fetchTicker: (symbol: string, params?: Record<string, unknown>) => Promise<CcxtTicker>;
  fetchOrderBook: (symbol: string, limit?: number, params?: Record<string, unknown>) => Promise<CcxtOrderBook>;
  setLeverage?: (leverage: number, symbol?: string, params?: Record<string, unknown>) => Promise<unknown>;
  setMarginMode?: (
    marginMode: "cross" | "isolated",
    symbol?: string,
    params?: Record<string, unknown>
  ) => Promise<unknown>;
  setPositionMode?: (hedged: boolean, symbol?: string, params?: Record<string, unknown>) => Promise<unknown>;
  amountToPrecision?: (symbol: string, amount: number) => string;
  priceToPrecision?: (symbol: string, price: number) => string;
}

const noopTelemetrySink: TelemetrySink = {
  emitLog: async () => undefined,
  emitMetric: async () => undefined,
  emitAlert: async () => undefined,
};

const asNum = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const asPositive = (value: unknown): number | undefined => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const toIso = (row: { datetime?: string; timestamp?: number }): string => {
  if (row.datetime) return String(row.datetime);
  if (typeof row.timestamp === "number") return new Date(row.timestamp).toISOString();
  return new Date().toISOString();
};

export interface FuturesActionContext {
  runId: string;
  traceId: string;
  mode: PipelineMode;
}

export interface BinanceFuturesTradingServiceConfig {
  enabled: boolean;
  apiKey: string;
  apiSecret: string;
  symbolWhitelist: string[];
  defaultScope: FuturesScope;
  defaultTif: FuturesTimeInForce;
  recvWindow: number;
  timeoutMs: number;
  defaultLeverage: number;
  marginMode: FuturesMarginMode;
  positionMode: FuturesPositionMode;
  protectionDbPath?: string;
  telemetrySink?: TelemetrySink;
  mode?: PipelineMode;
  usdmClient?: FuturesClientLike;
  coinmClient?: FuturesClientLike;
}

export class BinanceFuturesTradingService {
  private static instance: BinanceFuturesTradingService | null = null;

  public static getInstance(config: BinanceFuturesTradingServiceConfig): BinanceFuturesTradingService {
    if (!BinanceFuturesTradingService.instance) {
      BinanceFuturesTradingService.instance = new BinanceFuturesTradingService(config);
    }
    return BinanceFuturesTradingService.instance;
  }

  private readonly telemetrySink: TelemetrySink;
  private readonly recvWindow: number;
  private readonly timeoutMs: number;
  private readonly symbolWhitelist: Set<string>;
  private readonly usdmClient: FuturesClientLike;
  private readonly coinmClient: FuturesClientLike;
  private readonly protectionStore?: ProtectionGroupStore;
  private monitorTimer: NodeJS.Timeout | null = null;
  private readonly markets = new Map<FuturesScope, Map<string, FuturesMarket>>();
  private readonly scopeSetup = new Map<FuturesScope, Set<string>>();
  private lastRunId = "futures-run";
  private lastTraceId = "futures-trace";
  private mode: PipelineMode;

  private constructor(private readonly config: BinanceFuturesTradingServiceConfig) {
    this.telemetrySink = config.telemetrySink ?? noopTelemetrySink;
    this.recvWindow = Math.max(1000, config.recvWindow);
    this.timeoutMs = Math.max(1000, config.timeoutMs);
    this.mode = config.mode ?? "paper";
    this.symbolWhitelist = new Set(config.symbolWhitelist.map((s) => s.trim().toUpperCase()).filter(Boolean));
    this.usdmClient = config.usdmClient ?? this.createClient("usdm");
    this.coinmClient = config.coinmClient ?? this.createClient("coinm");
    if (config.protectionDbPath) {
      this.protectionStore = new ProtectionGroupStore(config.protectionDbPath);
      this.startProtectionMonitor();
    }
    this.markets.set("usdm", new Map());
    this.markets.set("coinm", new Map());
    this.scopeSetup.set("usdm", new Set());
    this.scopeSetup.set("coinm", new Set());
  }

  public setRunContext(ctx: FuturesActionContext): void {
    this.lastRunId = ctx.runId;
    this.lastTraceId = ctx.traceId;
    this.mode = ctx.mode;
  }

  public async placeOrder(
    request: FuturesOrderRequest,
    ctx: FuturesActionContext
  ): Promise<FuturesOrderResult> {
    this.setRunContext(ctx);
    const scope = request.scope ?? this.config.defaultScope;
    const action = "futures_place_order";
    const started = Date.now();
    try {
      this.assertEnabled();
      const normalized = await this.validateAndNormalizeRequest(request);
      await this.ensureTradingSetup(scope, normalized.symbol);
      const params: Record<string, unknown> = { recvWindow: this.recvWindow };
      if (normalized.type === "limit") {
        params.timeInForce = normalized.tif ?? this.config.defaultTif;
      }
      if (normalized.reduceOnly) {
        params.reduceOnly = true;
      }
      if (normalized.clientOrderId) {
        params.newClientOrderId = normalized.clientOrderId;
      }
      if (this.config.positionMode === "hedge") {
        params.positionSide = normalized.reduceOnly
          ? (normalized.side === "sell" ? "LONG" : "SHORT")
          : (normalized.side === "buy" ? "LONG" : "SHORT");
      }
      if (normalized.stopLoss) {
        params.stopLossPrice = normalized.stopLoss;
      }
      if (normalized.takeProfit) {
        params.takeProfitPrice = normalized.takeProfit;
      }

      const client = this.getClient(scope);
      let row: CcxtOrder;
      let nativeProtectionApplied = false;
      try {
        row = await withTimeout(
          client.createOrder(
            normalized.symbol,
            normalized.type,
            normalized.side,
            normalized.amount,
            normalized.price,
            params
          ),
          this.timeoutMs,
          "BINANCE_FUTURES_CREATE_ORDER_TIMEOUT"
        );
        nativeProtectionApplied = Boolean(normalized.stopLoss || normalized.takeProfit);
      } catch (nativeError) {
        if (!(normalized.stopLoss || normalized.takeProfit)) {
          throw nativeError;
        }
        delete params.stopLossPrice;
        delete params.takeProfitPrice;
        row = await withTimeout(
          client.createOrder(
            normalized.symbol,
            normalized.type,
            normalized.side,
            normalized.amount,
            normalized.price,
            params
          ),
          this.timeoutMs,
          "BINANCE_FUTURES_CREATE_ORDER_TIMEOUT"
        );
      }
      const mapped = this.mapOrder(scope, row, normalized.symbol, normalized.side, normalized.type, normalized.tif);
      try {
        mapped.protection = await this.attachOrQueueProtection(
          scope,
          normalized,
          mapped,
          nativeProtectionApplied ? "native" : "fallback"
        );
      } catch (protectionError) {
        await this.telemetrySink.emitMetric({
          name: "protection_create_failure",
          value: 1,
          timestamp: new Date().toISOString(),
          tags: this.tags("futures_protection_create", { scope, symbol: normalized.symbol }),
        });
        throw protectionError;
      }
      await this.emitActionSuccess(action, started, {
        scope,
        symbol: normalized.symbol,
        side: normalized.side,
        type: normalized.type
      }, mapped as unknown as Record<string, unknown>);
      return mapped;
    } catch (error) {
      await this.emitActionFailure(action, started, error, {
        scope,
        symbol: request.symbol,
        side: request.side,
        type: request.type
      });
      throw this.toFuturesError(error);
    }
  }

  public async fetchOrder(
    scope: FuturesScope,
    orderId: string,
    symbol: string,
    ctx: FuturesActionContext
  ): Promise<FuturesOrderResult> {
    this.setRunContext(ctx);
    return this.runAction("futures_fetch_order", scope, async () => {
      const normalized = symbol.trim().toUpperCase();
      await this.guardSymbol(scope, normalized);
      const row = await withTimeout(
        this.getClient(scope).fetchOrder(orderId, normalized, { recvWindow: this.recvWindow }),
        this.timeoutMs,
        "BINANCE_FUTURES_FETCH_ORDER_TIMEOUT"
      );
      return this.mapOrder(scope, row, normalized, "buy", "limit", undefined);
    }, { symbol: symbol.trim().toUpperCase() });
  }

  public async fetchOpenOrders(
    scope: FuturesScope,
    ctx: FuturesActionContext,
    symbol?: string,
    limit = 50
  ): Promise<FuturesOrderResult[]> {
    this.setRunContext(ctx);
    return this.runAction("futures_fetch_open_orders", scope, async () => {
      const normalized = symbol ? symbol.trim().toUpperCase() : undefined;
      if (normalized) {
        await this.guardSymbol(scope, normalized);
      }
      const rows = await withTimeout(
        this.getClient(scope).fetchOpenOrders(normalized, undefined, Math.max(1, limit), {
          recvWindow: this.recvWindow
        }),
        this.timeoutMs,
        "BINANCE_FUTURES_FETCH_OPEN_ORDERS_TIMEOUT"
      );
      return rows.map((row) => this.mapOrder(scope, row, row.symbol ?? normalized ?? "", "buy", "limit", undefined));
    }, { symbol: symbol ? symbol.trim().toUpperCase() : "ALL" });
  }

  public async fetchClosedOrders(
    scope: FuturesScope,
    ctx: FuturesActionContext,
    symbol?: string,
    limit = 50
  ): Promise<FuturesOrderResult[]> {
    this.setRunContext(ctx);
    return this.runAction("futures_fetch_closed_orders", scope, async () => {
      const normalized = symbol ? symbol.trim().toUpperCase() : undefined;
      if (normalized) {
        await this.guardSymbol(scope, normalized);
      }
      const rows = await withTimeout(
        this.getClient(scope).fetchClosedOrders(normalized, undefined, Math.max(1, limit), {
          recvWindow: this.recvWindow
        }),
        this.timeoutMs,
        "BINANCE_FUTURES_FETCH_CLOSED_ORDERS_TIMEOUT"
      );
      return rows.map((row) => this.mapOrder(scope, row, row.symbol ?? normalized ?? "", "buy", "limit", undefined));
    }, { symbol: symbol ? symbol.trim().toUpperCase() : "ALL" });
  }

  public async cancelOrder(
    scope: FuturesScope,
    orderId: string,
    symbol: string,
    ctx: FuturesActionContext
  ): Promise<FuturesOrderResult> {
    this.setRunContext(ctx);
    return this.runAction("futures_cancel_order", scope, async () => {
      const normalized = symbol.trim().toUpperCase();
      await this.guardSymbol(scope, normalized);
      const row = await withTimeout(
        this.getClient(scope).cancelOrder(orderId, normalized, { recvWindow: this.recvWindow }),
        this.timeoutMs,
        "BINANCE_FUTURES_CANCEL_ORDER_TIMEOUT"
      );
      return this.mapOrder(scope, row, normalized, "buy", "limit", undefined);
    }, { symbol: symbol.trim().toUpperCase() });
  }

  public async cancelAllOrders(
    scope: FuturesScope,
    ctx: FuturesActionContext,
    symbol?: string
  ): Promise<FuturesOrderResult[]> {
    this.setRunContext(ctx);
    return this.runAction("futures_cancel_all_orders", scope, async () => {
      const normalized = symbol ? symbol.trim().toUpperCase() : undefined;
      if (normalized) {
        await this.guardSymbol(scope, normalized);
      }
      const rows = await withTimeout(
        this.getClient(scope).cancelAllOrders(normalized, { recvWindow: this.recvWindow }),
        this.timeoutMs,
        "BINANCE_FUTURES_CANCEL_ALL_ORDERS_TIMEOUT"
      );
      return rows.map((row) => this.mapOrder(scope, row, row.symbol ?? normalized ?? "", "buy", "limit", undefined));
    }, { symbol: symbol ? symbol.trim().toUpperCase() : "ALL" });
  }

  public async fetchBalanceSnapshot(
    scope: FuturesScope,
    ctx: FuturesActionContext
  ): Promise<FuturesBalanceSnapshot> {
    this.setRunContext(ctx);
    return this.runAction("futures_fetch_balance", scope, async () => {
      const balance = await withTimeout(
        this.getClient(scope).fetchBalance({ recvWindow: this.recvWindow }),
        this.timeoutMs,
        "BINANCE_FUTURES_FETCH_BALANCE_TIMEOUT"
      );
      const free = balance.free ?? {};
      const used = balance.used ?? {};
      const total = balance.total ?? {};
      const keys = new Set<string>([...Object.keys(free), ...Object.keys(used), ...Object.keys(total)]);
      const assets: FuturesBalanceAsset[] = [];
      for (const asset of keys) {
        const totalVal = asNum(total[asset]);
        const freeVal = asNum(free[asset]);
        const usedVal = asNum(used[asset]);
        if (Math.abs(totalVal) <= 0 && Math.abs(freeVal) <= 0 && Math.abs(usedVal) <= 0) continue;
        assets.push({ asset, free: freeVal, used: usedVal, total: totalVal });
      }
      return {
        exchange: "binance",
        scope,
        timestamp: new Date().toISOString(),
        assets: assets.sort((a, b) => a.asset.localeCompare(b.asset))
      };
    });
  }

  public async fetchPositions(
    scope: FuturesScope,
    ctx: FuturesActionContext,
    symbol?: string
  ): Promise<FuturesPositionSnapshot[]> {
    this.setRunContext(ctx);
    return this.runAction("futures_fetch_positions", scope, async () => {
      const client = this.getClient(scope);
      const normalized = symbol ? symbol.trim().toUpperCase() : undefined;
      if (normalized) await this.guardSymbol(scope, normalized);

      let rows: CcxtPosition[] = [];
      if (client.fetchPositions) {
        rows = await withTimeout(
          client.fetchPositions(normalized ? [normalized] : undefined, { recvWindow: this.recvWindow }),
          this.timeoutMs,
          "BINANCE_FUTURES_FETCH_POSITIONS_TIMEOUT"
        );
      } else if (normalized && client.fetchPosition) {
        const row = await withTimeout(
          client.fetchPosition(normalized, { recvWindow: this.recvWindow }),
          this.timeoutMs,
          "BINANCE_FUTURES_FETCH_POSITION_TIMEOUT"
        );
        rows = [row];
      }
      return rows
        .map((row) => ({
          symbol: String(row.symbol ?? normalized ?? ""),
          side: String(row.side).toLowerCase() === "short" ? "short" : "long",
          contracts: asNum(row.contracts),
          entryPrice: asNum(row.entryPrice),
          markPrice: asNum(row.markPrice),
          leverage: asNum(row.leverage),
          notionalUsd: asNum(row.notional),
          unrealizedPnlUsd: asNum(row.unrealizedPnl),
          marginMode: String(row.marginMode).toLowerCase() === "cross" ? "cross" : "isolated",
        }))
        .filter((row) => row.symbol);
    }, { symbol: symbol ? symbol.trim().toUpperCase() : "ALL" });
  }

  public async fetchMyTrades(
    scope: FuturesScope,
    symbol: string,
    ctx: FuturesActionContext,
    limit = 50
  ): Promise<FuturesTradeRecord[]> {
    this.setRunContext(ctx);
    return this.runAction("futures_fetch_my_trades", scope, async () => {
      const normalized = symbol.trim().toUpperCase();
      await this.guardSymbol(scope, normalized);
      const rows = await withTimeout(
        this.getClient(scope).fetchMyTrades(normalized, undefined, Math.max(1, limit), {
          recvWindow: this.recvWindow
        }),
        this.timeoutMs,
        "BINANCE_FUTURES_FETCH_MY_TRADES_TIMEOUT"
      );
      return rows.map((row) => ({
        id: String(row.id ?? ""),
        orderId: row.order ? String(row.order) : undefined,
        symbol: String(row.symbol ?? normalized),
        side: String(row.side).toLowerCase() === "sell" ? "sell" : "buy",
        price: asNum(row.price),
        amount: asNum(row.amount),
        cost: asNum(row.cost),
        feeCost: row.fee?.cost !== undefined ? asNum(row.fee.cost) : undefined,
        feeCurrency: row.fee?.currency,
        timestamp: toIso(row)
      }));
    }, { symbol: symbol.trim().toUpperCase() });
  }

  public async fetchQuote(
    scope: FuturesScope,
    symbol: string,
    ctx: FuturesActionContext,
    depth = 5
  ): Promise<FuturesQuoteSnapshot> {
    this.setRunContext(ctx);
    return this.runAction("futures_fetch_quote", scope, async () => {
      const normalized = symbol.trim().toUpperCase();
      await this.guardSymbol(scope, normalized);
      const client = this.getClient(scope);
      const [ticker, orderbook] = await Promise.all([
        withTimeout(client.fetchTicker(normalized), this.timeoutMs, "BINANCE_FUTURES_FETCH_TICKER_TIMEOUT"),
        withTimeout(
          client.fetchOrderBook(normalized, Math.max(1, depth)),
          this.timeoutMs,
          "BINANCE_FUTURES_FETCH_ORDERBOOK_TIMEOUT"
        ),
      ]);
      const bid = asNum(ticker.bid);
      const ask = asNum(ticker.ask);
      const last = asNum(ticker.last);
      const spreadBps = bid > 0 && ask > 0 ? Number((((ask - bid) / bid) * 10000).toFixed(4)) : 0;
      return {
        scope,
        symbol: normalized,
        timestamp: new Date().toISOString(),
        bid,
        ask,
        last,
        spread_bps: spreadBps,
        orderbook_top: {
          bids: (orderbook.bids ?? []).slice(0, depth),
          asks: (orderbook.asks ?? []).slice(0, depth)
        }
      };
    }, { symbol: symbol.trim().toUpperCase() });
  }

  public async armProtectionManual(
    input: {
      scope: FuturesScope;
      symbol: string;
      side: "buy" | "sell";
      amount: number;
      stopLoss?: number;
      takeProfit?: number;
    },
    ctx: FuturesActionContext
  ): Promise<ProtectionSummary> {
    this.setRunContext(ctx);
    return this.runAction("futures_arm_protection", input.scope, async () => {
      if (!this.protectionStore) {
        throw new FuturesGuardError("FUTURES_PROTECTION_STORE_DISABLED", "Protection requires protectionDbPath configuration.");
      }
      const symbol = input.symbol.trim().toUpperCase();
      const amount = asPositive(input.amount);
      const stopLoss = asPositive(input.stopLoss);
      const takeProfit = asPositive(input.takeProfit);
      if (!amount) {
        throw new FuturesGuardError("FUTURES_AMOUNT_REQUIRED", "Manual protection requires amount > 0.");
      }
      if (!stopLoss && !takeProfit) {
        throw new FuturesGuardError("FUTURES_PROTECTION_TARGET_REQUIRED", "Provide stopLoss and/or takeProfit.");
      }
      const market = await this.guardSymbol(input.scope, symbol);
      const normalizedAmount = await this.normalizeOrderAmount(input.scope, symbol, market, amount);
      if (stopLoss) this.assertPriceGuard(symbol, stopLoss, market);
      if (takeProfit) this.assertPriceGuard(symbol, takeProfit, market);
      await this.assertProtectionPriceDirection({
        scope: input.scope,
        symbol,
        side: input.side,
        stopLoss,
        takeProfit,
      });
      const parentOrderId = `manual-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
      const group = this.protectionStore.upsertPending({
        scope: input.scope,
        symbol,
        parentOrderId,
        parentSide: input.side,
        parentType: "market",
        slPrice: stopLoss,
        tpPrice: takeProfit,
      });
      const created = await this.createFuturesProtectionOrders(input.scope, symbol, input.side, normalizedAmount, stopLoss, takeProfit);
      this.protectionStore.markActive(group.id, {
        mode: created.mode,
        slOrderId: created.slOrderId,
        tpOrderId: created.tpOrderId,
      });
      return {
        enabled: true,
        mode: created.mode,
        parentOrderId,
        slOrderId: created.slOrderId,
        tpOrderId: created.tpOrderId,
      };
    }, { symbol: input.symbol.trim().toUpperCase() });
  }

  private createClient(scope: FuturesScope): FuturesClientLike {
    const exchangeId = scope === "usdm" ? "binanceusdm" : "binancecoinm";
    const ctor = (ccxt as unknown as Record<string, new (args: Record<string, unknown>) => Exchange>)[exchangeId];
    return new ctor({
      apiKey: this.config.apiKey,
      secret: this.config.apiSecret,
      enableRateLimit: true,
      timeout: this.timeoutMs,
      options: {
        adjustForTimeDifference: true,
        recvWindow: this.recvWindow
      }
    }) as unknown as FuturesClientLike;
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new ProviderError(
        "binance-futures",
        403,
        "BINANCE_FUTURES_DISABLED",
        "BINANCE_FUTURES_ENABLED must be true for futures actions."
      );
    }
    if (!this.config.apiKey || !this.config.apiSecret) {
      throw new ProviderError(
        "binance-futures",
        401,
        "BINANCE_FUTURES_CREDENTIALS_MISSING",
        "BINANCE_API_KEY and BINANCE_API_SECRET are required for futures actions."
      );
    }
  }

  private getClient(scope: FuturesScope): FuturesClientLike {
    return scope === "usdm" ? this.usdmClient : this.coinmClient;
  }

  private async ensureMarketsLoaded(scope: FuturesScope): Promise<void> {
    const scopeMap = this.markets.get(scope)!;
    if (scopeMap.size > 0) return;
    const rows = await withTimeout(
      this.getClient(scope).loadMarkets(),
      this.timeoutMs,
      `BINANCE_FUTURES_LOAD_MARKETS_TIMEOUT:${scope}`
    );
    for (const [symbol, market] of Object.entries(rows)) {
      scopeMap.set(symbol.toUpperCase(), market as FuturesMarket);
    }
  }

  private async guardSymbol(scope: FuturesScope, symbol: string): Promise<FuturesMarket> {
    await this.ensureMarketsLoaded(scope);
    const normalized = symbol.trim().toUpperCase();
    if (!normalized.includes("/")) {
      throw new FuturesGuardError("FUTURES_SYMBOL_INVALID", `Invalid futures symbol: ${symbol}`);
    }
    if (this.symbolWhitelist.size > 0 && !this.symbolWhitelist.has(normalized)) {
      throw new FuturesGuardError("FUTURES_SYMBOL_NOT_WHITELISTED", `Symbol ${normalized} is not whitelisted.`);
    }
    const market = this.markets.get(scope)!.get(normalized);
    if (!market) {
      throw new FuturesGuardError("FUTURES_SYMBOL_NOT_FOUND", `Market ${normalized} not available on ${scope}.`);
    }
    if (!(market.future || market.swap)) {
      throw new FuturesGuardError("FUTURES_MARKET_REQUIRED", `Market ${normalized} is not a futures market.`);
    }
    return market;
  }

  private async validateAndNormalizeRequest(request: FuturesOrderRequest): Promise<FuturesOrderRequest> {
    const scope = request.scope ?? this.config.defaultScope;
    const symbol = request.symbol.trim().toUpperCase();
    const market = await this.guardSymbol(scope, symbol);
    const side = request.side === "sell" ? "sell" : "buy";
    const type = request.type === "limit" ? "limit" : "market";
    const amount = asPositive(request.amount);
    const price = asPositive(request.price);
    const stopLoss = asPositive(request.stopLoss);
    const takeProfit = asPositive(request.takeProfit);
    const tif = request.tif ?? this.config.defaultTif;
    if (!amount) {
      throw new FuturesGuardError("FUTURES_AMOUNT_REQUIRED", "Futures order requires amount > 0.");
    }
    if (type === "limit" && !price) {
      throw new FuturesGuardError("FUTURES_PRICE_REQUIRED", "Limit futures order requires price > 0.");
    }
    const normalizedAmount = await this.normalizeOrderAmount(scope, symbol, market, amount, price);
    if (price) this.assertPriceGuard(symbol, price, market);
    if (stopLoss) this.assertPriceGuard(symbol, stopLoss, market);
    if (takeProfit) this.assertPriceGuard(symbol, takeProfit, market);
    await this.assertNotionalGuard(scope, market, symbol, normalizedAmount, price);
    await this.assertProtectionPriceDirection({
      scope,
      symbol,
      side,
      basePrice: price,
      stopLoss,
      takeProfit,
    });
    return {
      ...request,
      scope,
      symbol,
      side,
      type,
      amount: normalizedAmount,
      price,
      stopLoss,
      takeProfit,
      tif
    };
  }

  private assertAmountGuard(symbol: string, amount: number, market: FuturesMarket): void {
    const min = asPositive(market.limits?.amount?.min);
    const max = asPositive(market.limits?.amount?.max);
    if (min && amount < min) {
      throw new FuturesGuardError("FUTURES_AMOUNT_BELOW_MIN", `Amount ${amount} < min ${min}.`);
    }
    if (max && amount > max) {
      throw new FuturesGuardError("FUTURES_AMOUNT_ABOVE_MAX", `Amount ${amount} > max ${max}.`);
    }
    const client = market.inverse ? this.coinmClient : this.usdmClient;
    if (client.amountToPrecision) {
      const rounded = Number(client.amountToPrecision(symbol, amount));
      if (Math.abs(rounded - amount) > 1e-12) {
        throw new FuturesGuardError("FUTURES_AMOUNT_PRECISION_INVALID", `Amount ${amount} violates precision.`, { rounded });
      }
    }
  }

  private async normalizeOrderAmount(
    scope: FuturesScope,
    symbol: string,
    market: FuturesMarket,
    amount: number,
    price?: number
  ): Promise<number> {
    const min = asPositive(market.limits?.amount?.min);
    if (!min || amount >= min) {
      this.assertAmountGuard(symbol, amount, market);
      return amount;
    }
    const contractSize = asPositive(market.contractSize);
    if (!contractSize) {
      this.assertAmountGuard(symbol, amount, market);
      return amount;
    }
    let converted = amount;
    if (market.inverse) {
      let refPrice = price ?? 0;
      if (!(refPrice > 0)) {
        const ticker = await withTimeout(
          this.getClient(scope).fetchTicker(symbol),
          this.timeoutMs,
          "BINANCE_FUTURES_TICKER_FOR_AMOUNT_NORMALIZE_TIMEOUT"
        );
        refPrice = asNum(ticker.last) || asNum(ticker.bid) || asNum(ticker.ask);
      }
      if (!(refPrice > 0)) {
        throw new FuturesGuardError("FUTURES_AMOUNT_CONVERSION_REFERENCE_PRICE_MISSING", "Cannot convert base amount to contracts without reference price.");
      }
      converted = (amount * refPrice) / contractSize;
    } else {
      converted = amount / contractSize;
    }
    const client = market.inverse ? this.coinmClient : this.usdmClient;
    if (client.amountToPrecision) {
      converted = Number(client.amountToPrecision(symbol, converted));
    }
    this.assertAmountGuard(symbol, converted, market);
    return converted;
  }

  private assertPriceGuard(symbol: string, price: number, market: FuturesMarket): void {
    const min = asPositive(market.limits?.price?.min);
    const max = asPositive(market.limits?.price?.max);
    if (min && price < min) {
      throw new FuturesGuardError("FUTURES_PRICE_BELOW_MIN", `Price ${price} < min ${min}.`);
    }
    if (max && price > max) {
      throw new FuturesGuardError("FUTURES_PRICE_ABOVE_MAX", `Price ${price} > max ${max}.`);
    }
    const client = market.inverse ? this.coinmClient : this.usdmClient;
    if (client.priceToPrecision) {
      const rounded = Number(client.priceToPrecision(symbol, price));
      if (Math.abs(rounded - price) > 1e-12) {
        throw new FuturesGuardError("FUTURES_PRICE_PRECISION_INVALID", `Price ${price} violates precision.`, { rounded });
      }
    }
  }

  private async assertNotionalGuard(
    scope: FuturesScope,
    market: FuturesMarket,
    symbol: string,
    amount: number,
    price?: number
  ): Promise<void> {
    const minCost = asPositive(market.limits?.cost?.min);
    if (!minCost) return;
    let px = price ?? 0;
    if (!px) {
      const ticker = await withTimeout(
        this.getClient(scope).fetchTicker(symbol),
        this.timeoutMs,
        "BINANCE_FUTURES_TICKER_FOR_GUARD_TIMEOUT"
      );
      px = asNum(ticker.last) || asNum(ticker.bid) || asNum(ticker.ask);
    }
    const notional = amount * px;
    if (notional < minCost) {
      throw new FuturesGuardError(
        "FUTURES_NOTIONAL_BELOW_MIN",
        `Estimated notional ${notional.toFixed(8)} < min ${minCost}.`
      );
    }
  }

  private async assertProtectionPriceDirection(input: {
    scope: FuturesScope;
    symbol: string;
    side: "buy" | "sell";
    basePrice?: number;
    stopLoss?: number;
    takeProfit?: number;
  }): Promise<void> {
    if (!input.stopLoss && !input.takeProfit) return;
    let refPrice = input.basePrice ?? 0;
    if (!(refPrice > 0)) {
      const ticker = await withTimeout(
        this.getClient(input.scope).fetchTicker(input.symbol),
        this.timeoutMs,
        "BINANCE_FUTURES_TICKER_FOR_PROTECTION_GUARD_TIMEOUT"
      );
      refPrice = asNum(ticker.last) || asNum(ticker.bid) || asNum(ticker.ask);
    }
    if (!(refPrice > 0)) {
      throw new FuturesGuardError("FUTURES_PROTECTION_REFERENCE_PRICE_MISSING", "Unable to infer reference price for SL/TP validation.");
    }
    if (input.side === "buy") {
      if (input.stopLoss && input.stopLoss >= refPrice) {
        throw new FuturesGuardError("FUTURES_STOP_LOSS_INVALID", `Stop-loss ${input.stopLoss} must be below reference price ${refPrice}.`);
      }
      if (input.takeProfit && input.takeProfit <= refPrice) {
        throw new FuturesGuardError("FUTURES_TAKE_PROFIT_INVALID", `Take-profit ${input.takeProfit} must be above reference price ${refPrice}.`);
      }
      return;
    }
    if (input.stopLoss && input.stopLoss <= refPrice) {
      throw new FuturesGuardError("FUTURES_STOP_LOSS_INVALID", `Stop-loss ${input.stopLoss} must be above reference price ${refPrice}.`);
    }
    if (input.takeProfit && input.takeProfit >= refPrice) {
      throw new FuturesGuardError("FUTURES_TAKE_PROFIT_INVALID", `Take-profit ${input.takeProfit} must be below reference price ${refPrice}.`);
    }
  }

  private async attachOrQueueProtection(
    scope: FuturesScope,
    request: FuturesOrderRequest,
    parent: FuturesOrderResult,
    preferredMode: ProtectionModeRecord
  ): Promise<ProtectionSummary | undefined> {
    if (!request.stopLoss && !request.takeProfit) return undefined;
    if (!this.protectionStore) {
      throw new FuturesGuardError("FUTURES_PROTECTION_STORE_DISABLED", "Protection requires protectionDbPath configuration.");
    }
    const parentId = parent.orderId;
    if (!parentId) {
      throw new FuturesGuardError("FUTURES_PARENT_ORDER_ID_MISSING", "Parent order id missing while creating protections.");
    }
    const group = this.protectionStore.upsertPending({
      scope,
      symbol: request.symbol,
      parentOrderId: parentId,
      parentSide: request.side,
      parentType: request.type,
      slPrice: request.stopLoss,
      tpPrice: request.takeProfit,
    });
    const filled = asNum(parent.filled);
    if (request.type === "limit" && filled <= 0) {
      return {
        enabled: true,
        mode: preferredMode,
        parentOrderId: parentId,
      };
    }
    const quantity = filled > 0 ? filled : asNum(request.amount);
    if (!(quantity > 0)) {
      throw new FuturesGuardError("FUTURES_PROTECTION_AMOUNT_UNKNOWN", "Unable to determine filled amount for SL/TP.");
    }
    const created = await this.createFuturesProtectionOrders(scope, request.symbol, request.side, quantity, request.stopLoss, request.takeProfit);
    this.protectionStore.markActive(group.id, {
      mode: created.mode,
      slOrderId: created.slOrderId,
      tpOrderId: created.tpOrderId,
    });
    await this.telemetrySink.emitMetric({
      name: "protection_create_success",
      value: 1,
      timestamp: new Date().toISOString(),
      tags: this.tags("futures_protection_create", { scope, symbol: request.symbol, mode: created.mode }),
    });
    if (created.mode === "fallback") {
      await this.telemetrySink.emitMetric({
        name: "protection_fallback_used",
        value: 1,
        timestamp: new Date().toISOString(),
        tags: this.tags("futures_protection_create", { scope, symbol: request.symbol }),
      });
    }
    return {
      enabled: true,
      mode: created.mode,
      parentOrderId: parentId,
      slOrderId: created.slOrderId,
      tpOrderId: created.tpOrderId,
    };
  }

  private async createFuturesProtectionOrders(
    scope: FuturesScope,
    symbol: string,
    parentSide: "buy" | "sell",
    amount: number,
    stopLoss?: number,
    takeProfit?: number
  ): Promise<{ mode: ProtectionModeRecord; slOrderId?: string; tpOrderId?: string }> {
    const client = this.getClient(scope);
    const closeSide: "buy" | "sell" = parentSide === "buy" ? "sell" : "buy";
    const positionSide = parentSide === "buy" ? "LONG" : "SHORT";
    const hedgeMode = this.config.positionMode === "hedge";
    const sharedNativeParams = {
      recvWindow: this.recvWindow,
      closePosition: true,
      ...(hedgeMode ? { positionSide } : {}),
    };
    const created: { mode: ProtectionModeRecord; slOrderId?: string; tpOrderId?: string } = { mode: "fallback" };
    let mode: ProtectionModeRecord = "fallback";
    try {
      if (stopLoss) {
        const sl = await withTimeout(
          client.createOrder(symbol, "STOP_MARKET", closeSide, undefined, undefined, {
            stopPrice: stopLoss,
            ...sharedNativeParams,
          }),
          this.timeoutMs,
          "BINANCE_FUTURES_CREATE_SL_TIMEOUT"
        );
        created.slOrderId = sl.id ? String(sl.id) : undefined;
      }
      if (takeProfit) {
        const tp = await withTimeout(
          client.createOrder(symbol, "TAKE_PROFIT_MARKET", closeSide, undefined, undefined, {
            stopPrice: takeProfit,
            ...sharedNativeParams,
          }),
          this.timeoutMs,
          "BINANCE_FUTURES_CREATE_TP_TIMEOUT"
        );
        created.tpOrderId = tp.id ? String(tp.id) : undefined;
      }
      mode = "native";
    } catch {
      mode = "fallback";
      if (stopLoss) {
        const sl = await withTimeout(
          client.createOrder(symbol, "market", closeSide, amount, undefined, {
            recvWindow: this.recvWindow,
            triggerPrice: stopLoss,
            ...(hedgeMode ? { positionSide } : { reduceOnly: true }),
          }),
          this.timeoutMs,
          "BINANCE_FUTURES_CREATE_SL_FALLBACK_TIMEOUT"
        );
        created.slOrderId = sl.id ? String(sl.id) : undefined;
      }
      if (takeProfit) {
        const tp = await withTimeout(
          client.createOrder(symbol, "market", closeSide, amount, undefined, {
            recvWindow: this.recvWindow,
            triggerPrice: takeProfit,
            ...(hedgeMode ? { positionSide } : { reduceOnly: true }),
          }),
          this.timeoutMs,
          "BINANCE_FUTURES_CREATE_TP_FALLBACK_TIMEOUT"
        );
        created.tpOrderId = tp.id ? String(tp.id) : undefined;
      }
    }
    return { mode, slOrderId: created.slOrderId, tpOrderId: created.tpOrderId };
  }

  private startProtectionMonitor(): void {
    if (!this.protectionStore || this.monitorTimer) return;
    this.monitorTimer = setInterval(() => {
      void this.monitorProtectionGroups();
    }, 5000);
    this.monitorTimer.unref();
  }

  private async monitorProtectionGroups(): Promise<void> {
    if (!this.protectionStore) return;
    const started = Date.now();
    const nowIso = new Date().toISOString();
    try {
      const pendingRows = this.protectionStore
        .listByStatuses(["pending_parent"], 200)
        .filter((row) => row.scope === "usdm" || row.scope === "coinm");
      for (const row of pendingRows) {
        const scope = row.scope as FuturesScope;
        try {
          const parent = await this.getClient(scope).fetchOrder(row.parentOrderId, row.symbol, { recvWindow: this.recvWindow });
          const status = String(parent.status ?? "").toLowerCase();
          const filled = asNum(parent.filled);
          if (status === "closed" || filled > 0) {
            const amount = filled > 0 ? filled : asNum(parent.amount);
            if (!(amount > 0)) {
              this.protectionStore.markError(row.id, "FUTURES_PROTECTION_AMOUNT_UNKNOWN");
              continue;
            }
            const created = await this.createFuturesProtectionOrders(scope, row.symbol, row.parentSide, amount, row.slPrice, row.tpPrice);
            this.protectionStore.markActive(row.id, {
              mode: created.mode,
              slOrderId: created.slOrderId,
              tpOrderId: created.tpOrderId,
            });
          } else if (["canceled", "cancelled", "expired", "rejected"].includes(status)) {
            this.protectionStore.markClosed(row.id);
          }
        } catch (error) {
          this.protectionStore.markError(row.id, String(error));
        }
      }

      const activeRows = this.protectionStore
        .listByStatuses(["active"], 200)
        .filter((row) => row.scope === "usdm" || row.scope === "coinm");
      for (const row of activeRows) {
        const scope = row.scope as FuturesScope;
        try {
          if (!row.slOrderId && !row.tpOrderId) {
            this.protectionStore.markError(row.id, "FUTURES_PROTECTION_ORPHAN");
            continue;
          }
          const slStatus = row.slOrderId
            ? await this.getClient(scope).fetchOrder(row.slOrderId, row.symbol, { recvWindow: this.recvWindow })
            : undefined;
          const tpStatus = row.tpOrderId
            ? await this.getClient(scope).fetchOrder(row.tpOrderId, row.symbol, { recvWindow: this.recvWindow })
            : undefined;
          const slClosed = slStatus ? ["closed", "filled"].includes(String(slStatus.status ?? "").toLowerCase()) : false;
          const tpClosed = tpStatus ? ["closed", "filled"].includes(String(tpStatus.status ?? "").toLowerCase()) : false;
          if (slClosed && row.tpOrderId) {
            await this.getClient(scope).cancelOrder(row.tpOrderId, row.symbol, { recvWindow: this.recvWindow });
            await this.telemetrySink.emitMetric({
              name: "protection_pair_cancel_success",
              value: 1,
              timestamp: nowIso,
              tags: this.tags("futures_protection_pair_cancel", { scope, symbol: row.symbol }),
            });
            this.protectionStore.markClosed(row.id);
          } else if (tpClosed && row.slOrderId) {
            await this.getClient(scope).cancelOrder(row.slOrderId, row.symbol, { recvWindow: this.recvWindow });
            await this.telemetrySink.emitMetric({
              name: "protection_pair_cancel_success",
              value: 1,
              timestamp: nowIso,
              tags: this.tags("futures_protection_pair_cancel", { scope, symbol: row.symbol }),
            });
            this.protectionStore.markClosed(row.id);
          }
        } catch (error) {
          await this.telemetrySink.emitMetric({
            name: "protection_pair_cancel_failure",
            value: 1,
            timestamp: nowIso,
            tags: this.tags("futures_protection_pair_cancel", { scope, symbol: row.symbol }),
          });
          this.protectionStore.markError(row.id, String(error));
        }
      }

      await this.telemetrySink.emitMetric({
        name: "protection_monitor_cycle_latency_ms",
        value: Date.now() - started,
        timestamp: nowIso,
        tags: this.tags("futures_protection_monitor"),
      });
    } catch (error) {
      await this.telemetrySink.emitAlert({
        timestamp: nowIso,
        name: "futures_protection_monitor_failed",
        severity: "warning",
        trace_id: this.lastTraceId,
        tags: this.tags("futures_protection_monitor"),
        message: String(error),
      });
    }
  }

  private async ensureTradingSetup(scope: FuturesScope, symbol: string): Promise<void> {
    const done = this.scopeSetup.get(scope)!;
    if (done.has(symbol)) return;
    const client = this.getClient(scope);
    const params = { recvWindow: this.recvWindow };
    if (client.setPositionMode) {
      await withTimeout(
        client.setPositionMode(this.config.positionMode === "hedge", symbol, params),
        this.timeoutMs,
        "BINANCE_FUTURES_SET_POSITION_MODE_TIMEOUT"
      );
    }
    if (client.setMarginMode) {
      await withTimeout(
        client.setMarginMode(this.config.marginMode, symbol, params),
        this.timeoutMs,
        "BINANCE_FUTURES_SET_MARGIN_MODE_TIMEOUT"
      );
    }
    if (client.setLeverage) {
      await withTimeout(
        client.setLeverage(this.config.defaultLeverage, symbol, params),
        this.timeoutMs,
        "BINANCE_FUTURES_SET_LEVERAGE_TIMEOUT"
      );
    }
    done.add(symbol);
  }

  private mapOrder(
    scope: FuturesScope,
    row: CcxtOrder,
    fallbackSymbol: string,
    fallbackSide: "buy" | "sell",
    fallbackType: "market" | "limit",
    fallbackTif?: FuturesTimeInForce
  ): FuturesOrderResult {
    const side = row.side === "sell" ? "sell" : fallbackSide;
    const type = row.type === "market" ? "market" : row.type === "limit" ? "limit" : fallbackType;
    const tifRaw = row.timeInForce ? row.timeInForce.toUpperCase() : fallbackTif;
    const tif: FuturesTimeInForce | undefined =
      tifRaw === "GTC" || tifRaw === "IOC" || tifRaw === "FOK" ? tifRaw : undefined;
    return {
      exchange: "binance",
      scope,
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
      reduceOnly: Boolean(row.reduceOnly),
      timestamp: toIso(row)
    };
  }

  private async runAction<T>(
    action: string,
    scope: FuturesScope,
    fn: () => Promise<T>,
    extraTags: Record<string, string> = {}
  ): Promise<T> {
    const started = Date.now();
    try {
      this.assertEnabled();
      const output = await fn();
      await this.emitActionSuccess(action, started, { scope, ...extraTags }, output as unknown as Record<string, unknown>);
      return output;
    } catch (error) {
      await this.emitActionFailure(action, started, error, { scope, ...extraTags });
      throw this.toFuturesError(error);
    }
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
      name: "futures_action_latency_ms",
      value: Date.now() - startedMs,
      timestamp: nowIso,
      tags
    });
    await this.telemetrySink.emitMetric({
      name: "futures_action_success",
      value: 1,
      timestamp: nowIso,
      tags
    });
    await this.telemetrySink.emitLog({
      timestamp: nowIso,
      level: "info",
      message: `${action} success`,
      trace_id: this.lastTraceId,
      tags,
      data: output as unknown as Record<string, unknown>
    });
  }

  private async emitActionFailure(
    action: string,
    startedMs: number,
    error: unknown,
    extraTags: Record<string, string>
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const err = this.toFuturesError(error);
    const tags = this.tags(action, { ...extraTags, error_code: err.code });
    await this.telemetrySink.emitMetric({
      name: "futures_action_latency_ms",
      value: Date.now() - startedMs,
      timestamp: nowIso,
      tags
    });
    await this.telemetrySink.emitMetric({
      name: "futures_action_success",
      value: 0,
      timestamp: nowIso,
      tags
    });
    await this.telemetrySink.emitAlert({
      timestamp: nowIso,
      name: "futures_action_failed",
      severity: "critical",
      trace_id: this.lastTraceId,
      tags,
      message: err.message,
      error_code: err.code,
      provider: "binance-futures",
      node: "BinanceFuturesTradingService",
      last_successful_run: this.lastRunId
    });
  }

  private tags(action: string, extra: Record<string, string> = {}): MetricTags {
    return {
      run_id: this.lastRunId,
      trace_id: this.lastTraceId,
      mode: this.mode,
      node: "BinanceFuturesTradingService",
      provider: "binance-futures",
      source: "system",
      action,
      ...extra
    };
  }

  private toFuturesError(error: unknown): ProviderError | FuturesGuardError {
    if (error instanceof ProviderError || error instanceof FuturesGuardError) {
      return error;
    }
    return new ProviderError("binance-futures", 500, "FUTURES_ACTION_FAILED", String(error));
  }
}
