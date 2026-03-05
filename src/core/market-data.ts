import ccxt, { type Exchange } from "ccxt";
import backtestCandles from "../../data/backtest-candles.json";
import type {
  FundamentalsData,
  FundamentalsProvider,
  MarketDataProvider,
  MarketDataQuery,
  MarketSnapshot,
  MetricTags,
  NewsEvent,
  NewsProvider,
  OHLCVCandle,
  ProviderFetchResult,
  SentimentProvider,
  SentimentSignal,
  TelemetrySink,
} from "../types";
import { ProviderError } from "../types";
import { clamp, round } from "../utils/common";
import type { HealthMonitor } from "./health";
import { RateLimitGovernor, withRetry, withTimeout } from "./ops";

const DEFAULT_TTL_MS = {
  fundamentals: 10 * 60 * 1000,
  sentiment: 5 * 60 * 1000,
  news: 10 * 60 * 1000,
} as const;

const DEFAULT_RETRY = {
  maxAttempts: 3,
  initialDelayMs: 300,
  backoffFactor: 2,
  maxDelayMs: 5000,
  jitterMs: 120,
} as const;

const noopTelemetrySink: TelemetrySink = {
  emitLog: async () => undefined,
  emitMetric: async () => undefined,
  emitAlert: async () => undefined,
};

interface CacheEntry<T> {
  expiresAt: number;
  value: ProviderFetchResult<T>;
}

export interface RealDataProviderConfig {
  strictRealMode: boolean;
  theNewsApiKey: string;
  coinGeckoApiKey: string;
  theNewsApiBaseUrl: string;
  alternativeMeBaseUrl: string;
  coinGeckoBaseUrl: string;
  providerCacheTtlSeconds?: number;
  exchangeId?: string;
  fetchFn?: typeof fetch;
  nowMs?: () => number;
  marketFetcher?: (query: MarketDataQuery) => Promise<{
    candles: OHLCVCandle[];
    lastPrice: number;
    status: ProviderFetchResult<{ asset: string; timeframe: string }>;
  }>;
  telemetrySink?: TelemetrySink;
  healthMonitor?: HealthMonitor;
  traceId?: string;
  runId?: string;
  mode?: "backtest" | "paper" | "live-sim";
  requestsPerSecond?: number;
  timeoutMs?: number;
  retryPolicy?: {
    maxAttempts: number;
    initialDelayMs: number;
    backoffFactor: number;
    maxDelayMs: number;
    jitterMs: number;
  };
}

const symbolToCoinGeckoId = (asset: string): string => {
  const base = asset.split("/")[0]?.toUpperCase() ?? "";
  const map: Record<string, string> = {
    BTC: "bitcoin",
    ETH: "ethereum",
    SOL: "solana",
    BNB: "binancecoin",
    XRP: "ripple",
    ADA: "cardano",
  };
  const mapped = map[base];
  if (!mapped) {
    throw new ProviderError(
      "asset-mapper",
      400,
      "UNSUPPORTED_ASSET",
      `Unsupported asset mapping for ${asset}`,
    );
  }
  return mapped;
};

const defaultBacktestFundamentals = (lastPrice: number): FundamentalsData => ({
  peRatio: 19,
  earningsGrowthPct: 18,
  debtToEquity: 0.55,
  currentRatio: 1.7,
  revenueGrowthPct: 15,
  marketCapUsd: lastPrice * 19600000,
  fdvUsd: lastPrice * 21000000,
  circulatingSupplyRatio: 19600000 / 21000000,
  volume24hUsd: 1_200_000_000,
  onChainActivityScore: 0.62,
});

const defaultBacktestSentimentSignals = (): SentimentSignal[] => [
  { source: "x", score: 0.32, source_detail: "fixture" },
  { source: "reddit", score: 0.15, source_detail: "fixture" },
  { source: "news-social", score: -0.05, source_detail: "fixture" },
];

const defaultBacktestNewsEvents = (): NewsEvent[] => [
  {
    title: "ETF inflows accelerate",
    sector: "crypto",
    impact: "bullish",
    severity: 0.7,
  },
  {
    title: "Regulatory hearing scheduled",
    sector: "crypto",
    impact: "neutral",
    severity: 0.4,
  },
];

const classifyImpact = (score: number): "bullish" | "bearish" | "neutral" => {
  if (score > 0.15) return "bullish";
  if (score < -0.15) return "bearish";
  return "neutral";
};

const toStatus = <T>(args: {
  provider: string;
  statusCode: number;
  latencyMs: number;
  recordCount: number;
  data: T;
  message?: string;
}): ProviderFetchResult<T> => ({
  provider: args.provider,
  ok: args.statusCode >= 200 && args.statusCode < 300,
  statusCode: args.statusCode,
  latencyMs: args.latencyMs,
  recordCount: args.recordCount,
  data: args.data,
  message: args.message,
});

class CoinGeckoFundamentalsProvider implements FundamentalsProvider {
  public constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch,
    private readonly governor: RateLimitGovernor,
    private readonly timeoutMs: number,
  ) {}

  public async fetch(
    asset: string,
  ): Promise<ProviderFetchResult<FundamentalsData>> {
    await this.governor.waitTurn("coingecko");
    const id = symbolToCoinGeckoId(asset);
    const url = `${this.baseUrl}/coins/markets?vs_currency=usd&ids=${id}&price_change_percentage=24h`;
    const headers: Record<string, string> = this.apiKey
      ? { "x-cg-demo-api-key": this.apiKey }
      : {};

    const started = Date.now();
    const response = await withTimeout(
      this.fetchFn(url, { headers }),
      this.timeoutMs,
      "PROVIDER_TIMEOUT:coingecko",
    );
    const latencyMs = Date.now() - started;

    if (!response.ok) {
      throw new ProviderError(
        "coingecko",
        response.status,
        "COINGECKO_HTTP_ERROR",
        `CoinGecko request failed (${response.status})`,
      );
    }

    const rows = (await response.json()) as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) {
      throw new ProviderError(
        "coingecko",
        404,
        "COINGECKO_EMPTY",
        `No CoinGecko market row for ${asset}`,
      );
    }

    const marketCapUsd = Number(row.market_cap ?? 0);
    const fdvUsd = Number(row.fully_diluted_valuation ?? marketCapUsd);
    const circulatingSupply = Number(row.circulating_supply ?? 0);
    const totalSupply = Number((row.total_supply ?? circulatingSupply) || 1);
    const volume24hUsd = Number(row.total_volume ?? 0);
    const change24hPct = Number(row.price_change_percentage_24h ?? 0);

    const fundamentals: FundamentalsData = {
      marketCapUsd,
      fdvUsd,
      circulatingSupplyRatio: clamp(
        circulatingSupply / Math.max(totalSupply, 1),
        0,
        1,
      ),
      volume24hUsd,
      onChainActivityScore: clamp(
        (volume24hUsd / Math.max(marketCapUsd, 1)) * 12 +
          (change24hPct / 100) * 0.5 +
          0.5,
        0,
        1,
      ),
    };

    return toStatus({
      provider: "coingecko",
      statusCode: response.status,
      latencyMs,
      recordCount: rows.length,
      data: fundamentals,
    });
  }
}

class AlternativeMeSentimentProvider implements SentimentProvider {
  public constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch,
    private readonly governor: RateLimitGovernor,
    private readonly timeoutMs: number,
  ) {}

  public async fetch(
    _asset: string,
  ): Promise<ProviderFetchResult<SentimentSignal[]>> {
    await this.governor.waitTurn("alternative-me");
    const url = `${this.baseUrl}/fng/?limit=1&format=json`;

    const started = Date.now();
    const response = await withTimeout(
      this.fetchFn(url),
      this.timeoutMs,
      "PROVIDER_TIMEOUT:alternative-me",
    );
    const latencyMs = Date.now() - started;

    if (!response.ok) {
      throw new ProviderError(
        "alternative-me",
        response.status,
        "ALTERNATIVE_ME_HTTP_ERROR",
        `Alternative.me request failed (${response.status})`,
      );
    }

    const raw = (await response.json()) as Record<string, unknown>;
    const rows = Array.isArray(raw.data)
      ? (raw.data as Array<Record<string, unknown>>)
      : [];
    const row = rows[0];
    if (!row) {
      throw new ProviderError(
        "alternative-me",
        404,
        "ALTERNATIVE_ME_EMPTY",
        "No Alternative.me sentiment row available",
      );
    }

    const value = Number(row.value ?? 50);
    const classification = String(row.value_classification ?? "Neutral");
    const score = clamp((value - 50) / 50, -1, 1);

    const signals: SentimentSignal[] = [
      {
        source: "alternative-me-fng",
        source_detail: classification,
        score,
        rawText: `Fear and Greed index=${value} (${classification})`,
      },
    ];

    return toStatus({
      provider: "alternative-me",
      statusCode: response.status,
      latencyMs,
      recordCount: signals.length,
      data: signals,
    });
  }
}

class TheNewsApiProvider implements NewsProvider {
  public constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch,
    private readonly governor: RateLimitGovernor,
    private readonly timeoutMs: number,
  ) {}

  public async fetch(asset: string): Promise<ProviderFetchResult<NewsEvent[]>> {
    await this.governor.waitTurn("thenewsapi");
    const symbol = asset.split("/")[0]?.toUpperCase() ?? asset.toUpperCase();
    const url = `${this.baseUrl}/all?api_token=${encodeURIComponent(this.apiKey)}&search=${encodeURIComponent(`${symbol} OR crypto`)}&language=en&limit=10`;

    const started = Date.now();
    const response = await withTimeout(
      this.fetchFn(url),
      this.timeoutMs,
      "PROVIDER_TIMEOUT:thenewsapi",
    );
    const latencyMs = Date.now() - started;

    if (!response.ok) {
      throw new ProviderError(
        "thenewsapi",
        response.status,
        "THENEWSAPI_HTTP_ERROR",
        `TheNewsAPI request failed (${response.status})`,
      );
    }

    const raw = (await response.json()) as Record<string, unknown>;
    const rows = Array.isArray(raw.data)
      ? (raw.data as Array<Record<string, unknown>>)
      : [];

    const events: NewsEvent[] = rows.slice(0, 8).map((article) => {
      const title = String(article.title ?? "Untitled");
      const desc = String(article.description ?? article.snippet ?? "");
      const text = `${title} ${desc}`.toLowerCase();
      const score =
        (text.includes("surge") ||
        text.includes("adoption") ||
        text.includes("approval")
          ? 0.3
          : 0) +
        (text.includes("ban") ||
        text.includes("hack") ||
        text.includes("lawsuit")
          ? -0.35
          : 0);

      return {
        title,
        sector: "crypto",
        impact: classifyImpact(score),
        severity: round(clamp(Math.abs(score) + 0.35, 0.2, 0.95), 3),
        url: typeof article.url === "string" ? article.url : undefined,
      };
    });

    return toStatus({
      provider: "thenewsapi",
      statusCode: response.status,
      latencyMs,
      recordCount: events.length,
      data: events,
    });
  }
}

export class BacktestDataProvider implements MarketDataProvider {
  public async getSnapshot(query: MarketDataQuery): Promise<MarketSnapshot> {
    const candles = (backtestCandles as OHLCVCandle[]).slice(-query.limit);
    const lastPrice = candles[candles.length - 1]?.close ?? 0;

    return {
      asset: query.asset,
      candles,
      fundamentals: defaultBacktestFundamentals(lastPrice),
      sentimentSignals: defaultBacktestSentimentSignals(),
      newsEvents: defaultBacktestNewsEvents(),
      lastPrice,
      providerStatus: [
        toStatus({
          provider: "backtest-fixture",
          statusCode: 200,
          latencyMs: 0,
          recordCount: candles.length,
          data: { source: "fixture" },
        }),
      ],
    };
  }

  public setRunContext(
    _ctx: { runId: string; traceId: string; mode: string; asset?: string },
  ): void {
    // No-op for deterministic fixtures.
  }

  public async *streamCandles(
    query: MarketDataQuery,
  ): AsyncIterable<OHLCVCandle> {
    const candles = (backtestCandles as OHLCVCandle[]).slice(-query.limit);
    for (const candle of candles) {
      yield candle;
    }
  }
}

export class RealCryptoDataProvider implements MarketDataProvider {
  private readonly exchange: Exchange;
  private readonly strictRealMode: boolean;
  private readonly fetchFn: typeof fetch;
  private readonly nowMs: () => number;
  private readonly fundamentalsProvider: CoinGeckoFundamentalsProvider;
  private readonly sentimentProvider: AlternativeMeSentimentProvider;
  private readonly newsProvider: TheNewsApiProvider;
  private readonly marketFetcher?: RealDataProviderConfig["marketFetcher"];
  private readonly telemetrySink: TelemetrySink;
  private readonly healthMonitor?: HealthMonitor;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly ttlMs: {
    fundamentals: number;
    sentiment: number;
    news: number;
  };
  private readonly retryProfile: Required<
    NonNullable<RealDataProviderConfig["retryPolicy"]>
  >;
  private readonly governor: RateLimitGovernor;
  private readonly timeoutMs: number;
  private traceId: string;
  private runId: string;
  private mode: "backtest" | "paper" | "live-sim";
  private marketsLoaded = false;

  public constructor(private readonly config: RealDataProviderConfig) {
    this.strictRealMode = config.strictRealMode;
    this.fetchFn = config.fetchFn ?? fetch;
    this.nowMs = config.nowMs ?? (() => Date.now());
    this.telemetrySink = config.telemetrySink ?? noopTelemetrySink;
    this.healthMonitor = config.healthMonitor;
    this.traceId = config.traceId ?? "trace-unset";
    this.runId = config.runId ?? "run-unset";
    this.mode = config.mode ?? "paper";
    this.timeoutMs = config.timeoutMs ?? 10000;
    this.retryProfile = {
      maxAttempts: config.retryPolicy?.maxAttempts ?? DEFAULT_RETRY.maxAttempts,
      initialDelayMs:
        config.retryPolicy?.initialDelayMs ?? DEFAULT_RETRY.initialDelayMs,
      backoffFactor:
        config.retryPolicy?.backoffFactor ?? DEFAULT_RETRY.backoffFactor,
      maxDelayMs: config.retryPolicy?.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
      jitterMs: config.retryPolicy?.jitterMs ?? DEFAULT_RETRY.jitterMs,
    };
    this.governor = new RateLimitGovernor(
      config.requestsPerSecond ?? 3,
      this.nowMs,
    );

    const exchangeId = config.exchangeId ?? "binance";
    const ExchangeCtor = (
      ccxt as unknown as Record<
        string,
        new (params: Record<string, unknown>) => Exchange
      >
    )[exchangeId];
    if (!ExchangeCtor) {
      throw new ProviderError(
        "ccxt",
        400,
        "CCXT_UNSUPPORTED_EXCHANGE",
        `Exchange '${exchangeId}' is not supported by ccxt.`,
      );
    }

    this.exchange = new ExchangeCtor({ enableRateLimit: true });
    this.fundamentalsProvider = new CoinGeckoFundamentalsProvider(
      config.coinGeckoApiKey,
      config.coinGeckoBaseUrl,
      this.fetchFn,
      this.governor,
      this.timeoutMs,
    );
    this.sentimentProvider = new AlternativeMeSentimentProvider(
      config.alternativeMeBaseUrl,
      this.fetchFn,
      this.governor,
      this.timeoutMs,
    );
    this.newsProvider = new TheNewsApiProvider(
      config.theNewsApiKey,
      config.theNewsApiBaseUrl,
      this.fetchFn,
      this.governor,
      this.timeoutMs,
    );
    this.marketFetcher = config.marketFetcher;

    const overrideTtlMs =
      config.providerCacheTtlSeconds && config.providerCacheTtlSeconds > 0
        ? config.providerCacheTtlSeconds * 1000
        : null;

    this.ttlMs = {
      fundamentals: overrideTtlMs ?? DEFAULT_TTL_MS.fundamentals,
      sentiment: overrideTtlMs ?? DEFAULT_TTL_MS.sentiment,
      news: overrideTtlMs ?? DEFAULT_TTL_MS.news,
    };
  }

  public async getSnapshot(query: MarketDataQuery): Promise<MarketSnapshot> {
    const started = this.nowMs();
    if (!this.marketsLoaded) {
      await this.exchange.loadMarkets();
      this.marketsLoaded = true;
    }

    if (this.strictRealMode) {
      this.ensureRequiredKeys();
    }

    const market = await this.fetchMarket(query);

    const [fundamentalsResult, sentimentResult, newsResult] = await Promise.all(
      [
        this.resolveWithPolicy(
          `fundamentals:${query.asset}`,
          this.ttlMs.fundamentals,
          () => this.fundamentalsProvider.fetch(query.asset),
          "coingecko",
          defaultBacktestFundamentals(market.lastPrice),
        ),
        this.resolveWithPolicy(
          `sentiment:${query.asset}`,
          this.ttlMs.sentiment,
          () => this.sentimentProvider.fetch(query.asset),
          "alternative-me",
          [
            {
              source: "fallback-neutral",
              score: 0,
              source_detail: "non-strict fallback",
            },
          ],
        ),
        this.resolveWithPolicy(
          `news:${query.asset}`,
          this.ttlMs.news,
          () => this.newsProvider.fetch(query.asset),
          "thenewsapi",
          [],
        ),
      ],
    );

    await this.telemetrySink.emitMetric({
      name: "provider_fetch_bundle_latency_ms",
      value: this.nowMs() - started,
      timestamp: new Date().toISOString(),
      tags: this.tags(query.asset, "RealCryptoDataProvider", "system"),
    });

    return {
      asset: query.asset,
      candles: market.candles,
      lastPrice: market.lastPrice,
      fundamentals: fundamentalsResult.data,
      sentimentSignals: sentimentResult.data,
      newsEvents: newsResult.data,
      providerStatus: [
        market.status,
        fundamentalsResult,
        sentimentResult,
        newsResult,
      ],
    };
  }

  public setRunContext(ctx: {
    runId: string;
    traceId: string;
    mode: string;
    asset?: string;
  }): void {
    this.runId = ctx.runId;
    this.traceId = ctx.traceId;
    this.mode =
      ctx.mode === "live-sim"
        ? "live-sim"
        : ctx.mode === "backtest"
          ? "backtest"
          : "paper";
  }

  public async *streamCandles(
    _query: MarketDataQuery,
  ): AsyncIterable<OHLCVCandle> {
    throw new Error(
      "streamCandles is WebSocket-ready but not implemented for RealCryptoDataProvider.",
    );
  }

  private ensureRequiredKeys(): void {
    if (!this.config.theNewsApiKey) {
      throw new ProviderError(
        "thenewsapi",
        401,
        "THENEWSAPI_KEY_MISSING",
        "THENEWSAPI_KEY is required in strict real mode.",
      );
    }
  }

  private tags(
    asset: string,
    node: string,
    source: string,
    provider?: string,
  ): MetricTags {
    return {
      trace_id: this.traceId,
      run_id: this.runId,
      mode: this.mode,
      asset,
      node,
      source,
      provider: provider ?? "",
    };
  }

  private async resolveWithPolicy<T>(
    cacheKey: string,
    ttlMs: number,
    fetcher: () => Promise<ProviderFetchResult<T>>,
    provider: string,
    fallbackData: T,
  ): Promise<ProviderFetchResult<T>> {
    const cached = this.getCache<T>(cacheKey);
    if (cached) {
      await this.telemetrySink.emitMetric({
        name: "cache_hit_rate",
        value: 1,
        timestamp: new Date().toISOString(),
        tags: this.tags(
          cacheKey.split(":")[1] ?? "",
          "RealCryptoDataProvider",
          "system",
          provider,
        ),
      });
      return {
        ...cached,
        message: cached.message ? `${cached.message}; cache-hit` : "cache-hit",
      };
    }

    await this.telemetrySink.emitMetric({
      name: "cache_hit_rate",
      value: 0,
      timestamp: new Date().toISOString(),
      tags: this.tags(
        cacheKey.split(":")[1] ?? "",
        "RealCryptoDataProvider",
        "system",
        provider,
      ),
    });

    try {
      const result = await withRetry(
        async () => fetcher(),
        this.retryProfile,
        (error) =>
          error instanceof ProviderError ? error.statusCode >= 429 : true,
        async ({ attempt, nextDelayMs, error }) => {
          await this.telemetrySink.emitLog({
            timestamp: new Date().toISOString(),
            level: "warn",
            message: `provider retry ${provider} attempt=${attempt} next_delay_ms=${nextDelayMs}`,
            trace_id: this.traceId,
            tags: this.tags(
              cacheKey.split(":")[1] ?? "",
              "RealCryptoDataProvider",
              "system",
              provider,
            ),
            data: { error: String(error) },
          });
        },
      );

      this.setCache(cacheKey, ttlMs, result);
      return result;
    } catch (error) {
      const providerError =
        error instanceof ProviderError
          ? error
          : new ProviderError(
              provider,
              500,
              "PROVIDER_FETCH_FAILED",
              String(error),
            );

      if (this.healthMonitor) {
        this.healthMonitor.recordProviderHealth({
          target: provider,
          kind: "provider",
          state: "down",
          timestamp: new Date().toISOString(),
          message: providerError.message,
          tags: this.tags(
            cacheKey.split(":")[1] ?? "",
            "RealCryptoDataProvider",
            "system",
            provider,
          ),
        });

        await this.healthMonitor.emitProviderFailureAlert({
          traceId: this.traceId,
          runId: this.runId,
          provider,
          code: providerError.code,
          message: providerError.message,
          timestamp: new Date().toISOString(),
          mode: this.mode,
          asset: cacheKey.split(":")[1] ?? "",
        });
      }

      if (this.strictRealMode) {
        throw providerError;
      }

      return toStatus({
        provider,
        statusCode: providerError.statusCode,
        latencyMs: 0,
        recordCount: Array.isArray(fallbackData) ? fallbackData.length : 1,
        data: fallbackData,
        message: `non-strict fallback: ${providerError.message}`,
      });
    }
  }

  private getCache<T>(key: string): ProviderFetchResult<T> | null {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    if (entry.expiresAt <= this.nowMs()) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  private setCache<T>(
    key: string,
    ttlMs: number,
    value: ProviderFetchResult<T>,
  ): void {
    this.cache.set(key, {
      expiresAt: this.nowMs() + Math.max(0, ttlMs),
      value,
    });
  }

  private async fetchMarket(query: MarketDataQuery): Promise<{
    candles: OHLCVCandle[];
    lastPrice: number;
    status: ProviderFetchResult<{ asset: string; timeframe: string }>;
  }> {
    if (this.marketFetcher) {
      return this.marketFetcher(query);
    }

    return withRetry(
      async () => {
        await this.governor.waitTurn("ccxt");
        const started = this.nowMs();
        const ohlcvRows = await withTimeout(
          this.exchange.fetchOHLCV(
            query.asset,
            query.timeframe,
            query.since,
            query.limit,
          ),
          this.timeoutMs,
          "PROVIDER_TIMEOUT:ccxt:ohlcv",
        );
        const candles: OHLCVCandle[] = ohlcvRows.map((row) => ({
          timestamp: new Date(row[0] as number).toISOString(),
          open: row[1] as number,
          high: row[2] as number,
          low: row[3] as number,
          close: row[4] as number,
          volume: row[5] as number,
        }));

        const ticker = await withTimeout(
          this.exchange.fetchTicker(query.asset),
          this.timeoutMs,
          "PROVIDER_TIMEOUT:ccxt:ticker",
        );
        const lastPrice =
          ticker.last ?? candles[candles.length - 1]?.close ?? 0;
        const latencyMs = this.nowMs() - started;

        return {
          candles,
          lastPrice,
          status: toStatus({
            provider: "ccxt",
            statusCode: 200,
            latencyMs,
            recordCount: candles.length,
            data: { asset: query.asset, timeframe: query.timeframe },
          }),
        };
      },
      this.retryProfile,
      () => true,
    );
  }
}

