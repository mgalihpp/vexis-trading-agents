import ccxt, { type Exchange } from "ccxt";
import type {
  AccountStateProvider,
  BinanceAccountSnapshot,
  MetricTags,
  PipelineMode,
  PortfolioState,
  TelemetrySink,
} from "../types";
import { ProviderError } from "../types";
import type { HealthMonitor } from "./health";
import { withTimeout } from "./ops";

const noopTelemetrySink: TelemetrySink = {
  emitLog: async () => undefined,
  emitMetric: async () => undefined,
  emitAlert: async () => undefined,
};

type BalanceShape = {
  free?: Record<string, number>;
  total?: Record<string, number>;
};

interface ExchangeLike {
  fetchBalance: (params?: Record<string, unknown>) => Promise<BalanceShape>;
  fetchTicker?: (
    symbol: string,
  ) => Promise<{ bid?: number; ask?: number; last?: number }>;
  fetchTickers?: (
    symbols?: string[],
  ) => Promise<Record<string, { bid?: number; ask?: number; last?: number }>>;
  loadMarkets?: () => Promise<Record<string, unknown> | unknown>;
  markets?: Record<string, unknown>;
}

export interface BinanceAccountProviderConfig {
  enabled: boolean;
  failHard: boolean;
  apiKey: string;
  apiSecret: string;
  accountScope: "spot+usdm+coinm";
  defaultExposurePct: number;
  defaultDrawdownPct: number;
  telemetrySink?: TelemetrySink;
  healthMonitor?: HealthMonitor;
  mode?: PipelineMode;
  timeoutMs?: number;
  spotClient?: ExchangeLike;
  usdmClient?: ExchangeLike;
  coinmClient?: ExchangeLike;
  nowIso?: () => string;
}

const isStable = (asset: string): boolean =>
  ["USD", "USDT", "USDC", "BUSD", "FDUSD"].includes(asset.toUpperCase());

const toNumber = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const normalizeMode = (value: string): PipelineMode => {
  if (value === "backtest" || value === "paper" || value === "live-sim") {
    return value;
  }
  return "paper";
};

export class StaticPortfolioStateProvider implements AccountStateProvider {
  public constructor(private readonly state: PortfolioState) {}

  public async getPortfolioState(): Promise<PortfolioState> {
    return { ...this.state };
  }

  public getLastSnapshot(): BinanceAccountSnapshot | null {
    return null;
  }

  public setRunContext(): void {
    // no-op
  }
}

export class BinanceAccountProvider implements AccountStateProvider {
  private readonly telemetrySink: TelemetrySink;
  private readonly healthMonitor?: HealthMonitor;
  private readonly nowIso: () => string;
  private readonly timeoutMs: number;
  private readonly rateCacheTtlMs = 30_000;
  private readonly tickerTimeoutMs: number;
  private readonly spotClient: ExchangeLike;
  private readonly usdmClient: ExchangeLike;
  private readonly coinmClient: ExchangeLike;
  private traceId = "trace-unset";
  private runId = "run-unset";
  private mode: PipelineMode;
  private lastSnapshot: BinanceAccountSnapshot | null = null;
  private spotMarketsLoaded = false;
  private spotMarketSymbols = new Set<string>();
  private rateCache:
    | { key: string; expiresAtMs: number; rates: Map<string, number> }
    | null = null;

  public constructor(private readonly config: BinanceAccountProviderConfig) {
    this.telemetrySink = config.telemetrySink ?? noopTelemetrySink;
    this.healthMonitor = config.healthMonitor;
    this.nowIso = config.nowIso ?? (() => new Date().toISOString());
    this.timeoutMs = Math.max(1000, config.timeoutMs ?? 10000);
    this.tickerTimeoutMs = Math.min(this.timeoutMs, 2000);
    this.mode = config.mode ?? "paper";

    this.spotClient = config.spotClient ?? this.createClient("binance");
    this.usdmClient = config.usdmClient ?? this.createClient("binanceusdm");
    this.coinmClient = config.coinmClient ?? this.createClient("binancecoinm");
  }

  public setRunContext(ctx: {
    runId: string;
    traceId: string;
    mode: string;
    asset?: string;
  }): void {
    this.runId = ctx.runId;
    this.traceId = ctx.traceId;
    this.mode = normalizeMode(ctx.mode);
  }

  public getLastSnapshot(): BinanceAccountSnapshot | null {
    return this.lastSnapshot;
  }

  public async getPortfolioState(ctx: {
    runId: string;
    traceId: string;
    mode: string;
    asset: string;
  }): Promise<PortfolioState> {
    this.setRunContext(ctx);

    if (!this.config.enabled) {
      return {
        equityUsd: 0,
        currentExposurePct: this.config.defaultExposurePct,
        currentDrawdownPct: this.config.defaultDrawdownPct,
        liquidityUsd: 0,
      };
    }

    if (!this.config.apiKey || !this.config.apiSecret) {
      throw new ProviderError(
        "binance-account",
        401,
        "BINANCE_CREDENTIALS_MISSING",
        "BINANCE_API_KEY and BINANCE_API_SECRET are required when BINANCE_ACCOUNT_ENABLED=true.",
      );
    }

    const started = Date.now();
    try {
      await this.ensureSpotMarketsLoaded();
      const [spotBalance, usdmBalance, coinmBalance] = await Promise.all([
        this.fetchBalanceWithMetrics(this.spotClient, "spot", "BINANCE_SPOT_TIMEOUT", ctx.asset),
        this.fetchBalanceWithMetrics(this.usdmClient, "usdm", "BINANCE_USDM_TIMEOUT", ctx.asset),
        this.fetchBalanceWithMetrics(this.coinmClient, "coinm", "BINANCE_COINM_TIMEOUT", ctx.asset),
      ]);

      const priceMap = await this.resolvePriceMap(spotBalance, usdmBalance, coinmBalance);
      const spot = this.toWalletUsd(spotBalance, priceMap);
      const usdm = this.toWalletUsd(usdmBalance, priceMap);
      const coinm = this.toWalletUsd(coinmBalance, priceMap);

      const snapshot: BinanceAccountSnapshot = {
        provider: "binance-account",
        scope: "spot+usdm+coinm",
        spot_equity_usd: spot.totalUsd,
        spot_liquidity_usd: spot.freeUsd,
        usdm_equity_usd: usdm.totalUsd,
        usdm_liquidity_usd: usdm.freeUsd,
        coinm_equity_usd: coinm.totalUsd,
        coinm_liquidity_usd: coinm.freeUsd,
        total_equity_usd: spot.totalUsd + usdm.totalUsd + coinm.totalUsd,
        total_liquidity_usd: spot.freeUsd + usdm.freeUsd + coinm.freeUsd,
        spot_assets_count: spot.assetCount,
        usdm_assets_count: usdm.assetCount,
        coinm_assets_count: coinm.assetCount,
        timestamp: this.nowIso(),
      };
      this.lastSnapshot = snapshot;

      await this.telemetrySink.emitMetric({
        name: "binance_account_latency_ms",
        value: Date.now() - started,
        timestamp: this.nowIso(),
        tags: this.tags(ctx.asset),
      });
      await this.telemetrySink.emitMetric({
        name: "binance_account_fetch_success",
        value: 1,
        timestamp: this.nowIso(),
        tags: this.tags(ctx.asset),
      });
      await this.telemetrySink.emitMetric({
        name: "binance_account_spot_fetch_success",
        value: 1,
        timestamp: this.nowIso(),
        tags: this.tags(ctx.asset),
      });
      await this.telemetrySink.emitMetric({
        name: "binance_account_usdm_fetch_success",
        value: 1,
        timestamp: this.nowIso(),
        tags: this.tags(ctx.asset),
      });
      await this.telemetrySink.emitMetric({
        name: "binance_account_coinm_fetch_success",
        value: 1,
        timestamp: this.nowIso(),
        tags: this.tags(ctx.asset),
      });
      await this.telemetrySink.emitMetric({
        name: "binance_wallet_equity_usd",
        value: snapshot.total_equity_usd,
        timestamp: this.nowIso(),
        tags: this.tags(ctx.asset),
      });
      await this.telemetrySink.emitLog({
        timestamp: this.nowIso(),
        level: "info",
        message: "binance account snapshot fetched",
        trace_id: this.traceId,
        tags: this.tags(ctx.asset),
        data: snapshot,
      });

      this.healthMonitor?.recordProviderHealth({
        target: "binance-account",
        kind: "provider",
        state: "healthy",
        timestamp: this.nowIso(),
        message: "account balances fetched",
        tags: this.tags(ctx.asset),
      });

      return {
        equityUsd: snapshot.total_equity_usd,
        currentExposurePct: this.config.defaultExposurePct,
        currentDrawdownPct: this.config.defaultDrawdownPct,
        liquidityUsd: snapshot.total_liquidity_usd,
      };
    } catch (error) {
      const providerError =
        error instanceof ProviderError
          ? error
          : new ProviderError(
              "binance-account",
              500,
              "BINANCE_ACCOUNT_FETCH_FAILED",
              String(error),
            );

      await this.telemetrySink.emitMetric({
        name: "binance_account_fetch_success",
        value: 0,
        timestamp: this.nowIso(),
        tags: this.tags(ctx.asset),
      });
      await this.telemetrySink.emitMetric({
        name: "binance_account_spot_fetch_success",
        value: 0,
        timestamp: this.nowIso(),
        tags: this.tags(ctx.asset),
      });
      await this.telemetrySink.emitMetric({
        name: "binance_account_usdm_fetch_success",
        value: 0,
        timestamp: this.nowIso(),
        tags: this.tags(ctx.asset),
      });
      await this.telemetrySink.emitMetric({
        name: "binance_account_coinm_fetch_success",
        value: 0,
        timestamp: this.nowIso(),
        tags: this.tags(ctx.asset),
      });
      this.healthMonitor?.recordProviderHealth({
        target: "binance-account",
        kind: "provider",
        state: "down",
        timestamp: this.nowIso(),
        message: providerError.message,
        tags: this.tags(ctx.asset),
      });
      if (this.healthMonitor) {
        await this.healthMonitor.emitProviderFailureAlert({
          traceId: this.traceId,
          runId: this.runId,
          provider: "binance-account",
          code: providerError.code,
          message: providerError.message,
          timestamp: this.nowIso(),
          mode: this.mode,
          asset: ctx.asset,
        });
      }

      if (this.config.failHard) {
        throw providerError;
      }

      return {
        equityUsd: 0,
        currentExposurePct: this.config.defaultExposurePct,
        currentDrawdownPct: this.config.defaultDrawdownPct,
        liquidityUsd: 0,
      };
    }
  }

  private createClient(
    exchangeId: "binance" | "binanceusdm" | "binancecoinm",
  ): ExchangeLike {
    const ctor = (
      ccxt as unknown as Record<
        string,
        new (args: Record<string, unknown>) => Exchange
      >
    )[exchangeId];
    return new ctor({
      apiKey: this.config.apiKey,
      secret: this.config.apiSecret,
      enableRateLimit: true,
      timeout: this.timeoutMs,
      options: {
        adjustForTimeDifference: true,
        recvWindow: 10000,
        fetchCurrencies: false,
      },
    }) as unknown as ExchangeLike;
  }

  private tags(asset: string): MetricTags {
    return {
      run_id: this.runId,
      trace_id: this.traceId,
      mode: this.mode,
      asset,
      node: "BinanceAccountProvider",
      source: "system",
      provider: "binance-account",
    };
  }

  private async fetchBalanceWithMetrics(
    client: ExchangeLike,
    source: "spot" | "usdm" | "coinm",
    timeoutCode: string,
    asset: string,
  ): Promise<BalanceShape> {
    const started = Date.now();
    const result = await withTimeout(
      client.fetchBalance(),
      this.timeoutMs,
      timeoutCode,
    );
    await this.telemetrySink.emitMetric({
      name: `binance_account_${source}_latency_ms`,
      value: Date.now() - started,
      timestamp: this.nowIso(),
      tags: this.tags(asset),
    });
    return result;
  }

  private async ensureSpotMarketsLoaded(): Promise<void> {
    if (this.spotMarketsLoaded) return;
    if (!this.spotClient.loadMarkets) {
      this.spotMarketsLoaded = true;
      return;
    }

    const loaded = await withTimeout(
      this.spotClient.loadMarkets(),
      this.timeoutMs,
      "BINANCE_LOAD_MARKETS_TIMEOUT",
    );
    const fromReturn =
      loaded && typeof loaded === "object"
        ? Object.keys(loaded as Record<string, unknown>)
        : [];
    const fromClient = this.spotClient.markets
      ? Object.keys(this.spotClient.markets)
      : [];
    for (const symbol of [...fromReturn, ...fromClient]) {
      this.spotMarketSymbols.add(symbol);
    }
    this.spotMarketsLoaded = true;
  }

  private hasSpotSymbol(symbol: string): boolean {
    if (!this.spotMarketsLoaded) return true;
    if (this.spotMarketSymbols.size === 0) return true;
    return this.spotMarketSymbols.has(symbol);
  }

  private async resolvePriceMap(
    spot: BalanceShape,
    usdm: BalanceShape,
    coinm: BalanceShape,
  ): Promise<Map<string, number>> {
    const assets = new Set<string>();
    for (const key of Object.keys(spot.total ?? {})) assets.add(key);
    for (const key of Object.keys(spot.free ?? {})) assets.add(key);
    for (const key of Object.keys(usdm.total ?? {})) assets.add(key);
    for (const key of Object.keys(usdm.free ?? {})) assets.add(key);
    for (const key of Object.keys(coinm.total ?? {})) assets.add(key);
    for (const key of Object.keys(coinm.free ?? {})) assets.add(key);

    const nonStable = [...assets].filter((a) => !isStable(a));
    if (nonStable.length === 0) {
      return new Map();
    }

    const cacheKey = [...nonStable].sort().join("|");
    const nowMs = Date.now();
    if (
      this.rateCache &&
      this.rateCache.key === cacheKey &&
      this.rateCache.expiresAtMs > nowMs
    ) {
      return new Map(this.rateCache.rates);
    }

    const pairs = new Set<string>();
    for (const asset of nonStable) {
      pairs.add(`${asset}/USDT`);
      pairs.add(`${asset}/USDC`);
      pairs.add(`${asset}/BUSD`);
      pairs.add(`${asset}/FDUSD`);
      pairs.add(`${asset}/USD`);
    }

    const symbols = [...pairs].filter((symbol) => this.hasSpotSymbol(symbol));
    let tickerMap: Record<
      string,
      { bid?: number; ask?: number; last?: number }
    > = {};
    if (this.spotClient.fetchTickers) {
      try {
        tickerMap = await withTimeout(
          this.spotClient.fetchTickers(symbols),
          this.tickerTimeoutMs,
          "BINANCE_TICKER_TIMEOUT",
        );
      } catch {
        // Fallback to all tickers once, then filter locally.
        try {
          tickerMap = await withTimeout(
            this.spotClient.fetchTickers(),
            this.timeoutMs,
            "BINANCE_TICKERS_ALL_TIMEOUT",
          );
        } catch {
          tickerMap = {};
        }
      }
    }

    const rates = new Map<string, number>();
    for (const asset of nonStable) {
      const quote =
        tickerMap[`${asset}/USDT`] ??
        tickerMap[`${asset}/USDC`] ??
        tickerMap[`${asset}/BUSD`] ??
        tickerMap[`${asset}/FDUSD`] ??
        tickerMap[`${asset}/USD`];
      const bid = toNumber(quote?.bid);
      const ask = toNumber(quote?.ask);
      const last = toNumber(quote?.last);
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
      if (mid > 0) {
        rates.set(asset, mid);
      }
    }

    this.rateCache = {
      key: cacheKey,
      expiresAtMs: nowMs + this.rateCacheTtlMs,
      rates: new Map(rates),
    };

    return rates;
  }

  private toWalletUsd(
    balance: BalanceShape,
    rates: Map<string, number>,
  ): { totalUsd: number; freeUsd: number; assetCount: number } {
    const total = balance.total ?? {};
    const free = balance.free ?? {};
    const assets = new Set<string>([
      ...Object.keys(total),
      ...Object.keys(free),
    ]);
    let totalUsd = 0;
    let freeUsd = 0;
    let assetCount = 0;

    for (const asset of assets) {
      const totalQty = toNumber(total[asset]);
      const freeQty = toNumber(free[asset]);
      if (Math.abs(totalQty) <= 0 && Math.abs(freeQty) <= 0) {
        continue;
      }

      let rate = 1;
      if (!isStable(asset)) {
        rate = toNumber(rates.get(asset));
        if (rate <= 0) {
          if (this.config.failHard) {
            throw new ProviderError(
              "binance-account",
              422,
              "BINANCE_PRICE_MISSING",
              `Missing USD conversion price for asset ${asset}`,
            );
          }
          continue;
        }
      }

      totalUsd += totalQty * rate;
      freeUsd += freeQty * rate;
      assetCount += 1;
    }

    return {
      totalUsd: Number(totalUsd.toFixed(6)),
      freeUsd: Number(freeUsd.toFixed(6)),
      assetCount,
    };
  }
}
