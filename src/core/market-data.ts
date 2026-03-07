import ccxt, { type Exchange } from "ccxt";
import { createRequire } from "node:module";
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

interface CryptoNewsArticle {
  title: string;
  link: string;
  description?: string;
  pubDate: string;
}

interface CryptoNewsClient {
  getLatest(limit?: number): Promise<CryptoNewsArticle[]>;
  search(keywords: string, limit?: number): Promise<CryptoNewsArticle[]>;
}

const requireFromEsm = createRequire(import.meta.url);
const createCryptoNewsClient = (baseUrl: string, timeout: number, fetchFn: typeof fetch): CryptoNewsClient => {
  const sdk = requireFromEsm("@nirholas/crypto-news") as {
    CryptoNews: new (options?: { baseUrl?: string; timeout?: number; fetch?: typeof fetch }) => CryptoNewsClient;
  };
  return new sdk.CryptoNews({
    baseUrl,
    timeout,
    fetch: fetchFn,
  });
};

export interface RealDataProviderConfig {
  strictRealMode: boolean;
  newsApiKey: string;
  coinGeckoApiKey: string;
  cryptocurrencyCvBaseUrl: string;
  newsApiBaseUrl: string;
  alternativeMeBaseUrl: string;
  coinGeckoBaseUrl: string;
  providerCacheTtlSeconds?: number;
  exchangeId?: string;
  fetchFn?: typeof fetch;
  nowMs?: () => number;
  marketFetcher?: (query: MarketDataQuery) => Promise<{
    candles: OHLCVCandle[];
    lastPrice: number;
    marketConstraints?: {
      min_notional_usd?: number;
      precision_step?: number;
      source: "exchange" | "fallback_env";
    };
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

const STATIC_COINGECKO_SYMBOL_MAP: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  BNB: "binancecoin",
  XRP: "ripple",
  ADA: "cardano",
};

const normalizeAssetBase = (asset: string): string =>
  asset.split("/")[0]?.trim().toUpperCase() ?? "";

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
    published_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    recency_hours: 2,
    relevance_score: 0.78,
    market_relevance: "btc_direct",
  },
  {
    title: "Regulatory hearing scheduled",
    sector: "crypto",
    impact: "neutral",
    severity: 0.4,
    published_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    recency_hours: 6,
    relevance_score: 0.55,
    market_relevance: "crypto_thematic",
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
  private readonly idCache = new Map<string, string>(
    Object.entries(STATIC_COINGECKO_SYMBOL_MAP),
  );

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
    const id = await this.resolveCoinGeckoId(asset);
    const url = `${this.baseUrl}/coins/markets?vs_currency=usd&ids=${id}&price_change_percentage=24h`;
    const headers = this.coingeckoHeaders();

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

  private coingeckoHeaders(): Record<string, string> {
    return this.apiKey ? { "x-cg-demo-api-key": this.apiKey } : {};
  }

  private async resolveCoinGeckoId(asset: string): Promise<string> {
    const base = normalizeAssetBase(asset);
    if (!base) {
      throw new ProviderError(
        "asset-mapper",
        400,
        "UNSUPPORTED_ASSET",
        `Unsupported asset mapping for ${asset}`,
      );
    }

    const cached = this.idCache.get(base);
    if (cached) {
      return cached;
    }

    await this.governor.waitTurn("coingecko-search");
    const url = `${this.baseUrl}/search?query=${encodeURIComponent(base)}`;
    const response = await withTimeout(
      this.fetchFn(url, { headers: this.coingeckoHeaders() }),
      this.timeoutMs,
      "PROVIDER_TIMEOUT:coingecko-search",
    );
    if (!response.ok) {
      throw new ProviderError(
        "coingecko",
        response.status,
        "COINGECKO_SEARCH_HTTP_ERROR",
        `CoinGecko search request failed (${response.status})`,
      );
    }

    const raw = (await response.json()) as { coins?: Array<Record<string, unknown>> };
    const coins = Array.isArray(raw.coins) ? raw.coins : [];
    const exact = coins.filter((coin) => {
      const symbol = String(coin.symbol ?? "").toUpperCase();
      return symbol === base;
    });
    const ranked = exact
      .map((coin) => {
        const rankRaw = Number(coin.market_cap_rank ?? Number.MAX_SAFE_INTEGER);
        const rank = Number.isFinite(rankRaw) && rankRaw > 0 ? rankRaw : Number.MAX_SAFE_INTEGER;
        return { coin, rank };
      })
      .sort((a, b) => a.rank - b.rank);
    const best = ranked[0]?.coin ?? exact[0];
    const id = typeof best?.id === "string" ? best.id : undefined;

    if (!id) {
      throw new ProviderError(
        "asset-mapper",
        400,
        "UNSUPPORTED_ASSET",
        `Unsupported asset mapping for ${asset}`,
      );
    }

    this.idCache.set(base, id);
    return id;
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

class CryptocurrencyCvNewsProvider implements NewsProvider {
  private readonly client: CryptoNewsClient;

  public constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch,
    private readonly governor: RateLimitGovernor,
    private readonly timeoutMs: number,
  ) {
    this.client = createCryptoNewsClient(this.baseUrl, this.timeoutMs, this.fetchFn);
  }

  public async fetch(asset: string): Promise<ProviderFetchResult<NewsEvent[]>> {
    await this.governor.waitTurn("cryptocurrency-cv");
    const symbol = asset.split("/")[0]?.toUpperCase() ?? asset.toUpperCase();

    const keywordMap: Record<string, string> = {
      BTC: "bitcoin",
      ETH: "ethereum",
      SOL: "solana",
      BNB: "binance",
      XRP: "xrp",
      ADA: "cardano",
    };
    const keyword = keywordMap[symbol] ?? symbol.toLowerCase();

    const started = Date.now();
    const latest = await withTimeout(
      this.client.getLatest(25),
      this.timeoutMs,
      "PROVIDER_TIMEOUT:cryptocurrency-cv",
    );
    const searched = await withTimeout(
      this.client.search(`${keyword},crypto`, 25),
      this.timeoutMs,
      "PROVIDER_TIMEOUT:cryptocurrency-cv",
    );
    const latencyMs = Date.now() - started;

    const mergedArticles = [...latest, ...searched];
    const unique = new Map<string, CryptoNewsArticle>();
    for (const article of mergedArticles) {
      const key = `${article.title.trim().toLowerCase()}|${article.pubDate ?? ""}`;
      if (!unique.has(key)) unique.set(key, article);
    }

    const events: NewsEvent[] = [...unique.values()].slice(0, 25).map((article) => {
      const title = String(article.title ?? "Untitled");
      const desc = String(article.description ?? "");
      const text = `${title} ${desc}`.toLowerCase();
      const publishedAt = typeof article.pubDate === "string" ? article.pubDate : undefined;
      const recencyHours = publishedAt
        ? Math.max(0, (Date.now() - new Date(publishedAt).getTime()) / (1000 * 60 * 60))
        : undefined;
      const relevanceScore = clamp(
        (text.includes(symbol.toLowerCase()) ? 0.45 : 0.2) +
        (text.includes("bitcoin") || text.includes("btc") ? 0.25 : 0) +
        (text.includes("crypto") ? 0.15 : 0),
        0,
        1,
      );
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
        url: typeof article.link === "string" ? article.link : undefined,
        published_at: publishedAt,
        recency_hours: recencyHours ? round(recencyHours, 3) : undefined,
        relevance_score: round(relevanceScore, 4),
        market_relevance: relevanceScore > 0.6 ? "btc_direct" : relevanceScore > 0.35 ? "crypto_thematic" : "macro",
      };
    });

    return toStatus({
      provider: "cryptocurrency-cv",
      statusCode: 200,
      latencyMs,
      recordCount: events.length,
      data: events,
    });
  }
}

class NewsApiOrgProvider implements NewsProvider {
  public constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch,
    private readonly governor: RateLimitGovernor,
    private readonly timeoutMs: number,
  ) {}

  public async fetch(asset: string): Promise<ProviderFetchResult<NewsEvent[]>> {
    await this.governor.waitTurn("newsapi");
    const symbol = asset.split("/")[0]?.toUpperCase() ?? asset.toUpperCase();
    const url = `${this.baseUrl}/everything?q=${encodeURIComponent(`${symbol} OR crypto`)}` +
      `&language=en&pageSize=20&sortBy=publishedAt`;

    const started = Date.now();
    const response = await withTimeout(
      this.fetchFn(url, { headers: { "X-Api-Key": this.apiKey } }),
      this.timeoutMs,
      "PROVIDER_TIMEOUT:newsapi",
    );
    const latencyMs = Date.now() - started;

    if (!response.ok) {
      throw new ProviderError(
        "newsapi",
        response.status,
        "NEWSAPI_HTTP_ERROR",
        `NewsAPI request failed (${response.status})`,
      );
    }

    const raw = (await response.json()) as Record<string, unknown>;
    const rows = Array.isArray(raw.articles)
      ? (raw.articles as Array<Record<string, unknown>>)
      : [];

    const events: NewsEvent[] = rows.slice(0, 20).map((article) => {
      const title = String(article.title ?? "Untitled");
      const desc = String(article.description ?? "");
      const text = `${title} ${desc}`.toLowerCase();
      const publishedAt = typeof article.publishedAt === "string"
        ? article.publishedAt
        : typeof article.published_at === "string"
          ? article.published_at
          : undefined;
      const recencyHours = publishedAt
        ? Math.max(0, (Date.now() - new Date(publishedAt).getTime()) / (1000 * 60 * 60))
        : undefined;
      const relevanceScore = clamp(
        (text.includes(symbol.toLowerCase()) ? 0.45 : 0.2) +
        (text.includes("bitcoin") || text.includes("btc") ? 0.25 : 0) +
        (text.includes("crypto") ? 0.15 : 0),
        0,
        1,
      );
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
        published_at: publishedAt,
        recency_hours: recencyHours ? round(recencyHours, 3) : undefined,
        relevance_score: round(relevanceScore, 4),
        market_relevance: relevanceScore > 0.6 ? "btc_direct" : relevanceScore > 0.35 ? "crypto_thematic" : "macro",
      };
    });

    return toStatus({
      provider: "newsapi",
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
  private readonly cryptocurrencyCvProvider: CryptocurrencyCvNewsProvider;
  private readonly newsApiOrgProvider: NewsApiOrgProvider;
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
    this.cryptocurrencyCvProvider = new CryptocurrencyCvNewsProvider(
      config.cryptocurrencyCvBaseUrl,
      this.fetchFn,
      this.governor,
      this.timeoutMs,
    );
    this.newsApiOrgProvider = new NewsApiOrgProvider(
      config.newsApiKey,
      config.newsApiBaseUrl,
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
    if (this.strictRealMode) {
      this.ensureRequiredKeys();
    }

    if (!this.marketFetcher && !this.marketsLoaded) {
      await this.exchange.loadMarkets();
      this.marketsLoaded = true;
    }

    const market = await this.fetchMarket(query);

    const disabledNewsStatus = (provider: string): ProviderFetchResult<NewsEvent[]> => ({
      provider,
      ok: true,
      statusCode: 204,
      latencyMs: 0,
      recordCount: 0,
      data: [],
      message: "disabled: missing api key",
    });

    const [fundamentalsResult, sentimentResult, cryptocurrencyCvResult, newsApiResult] = await Promise.all(
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
          `news:cryptocurrency-cv:${query.asset}`,
          this.ttlMs.news,
          () => this.cryptocurrencyCvProvider.fetch(query.asset),
          "cryptocurrency-cv",
          [],
        ),
        this.config.newsApiKey
          ? this.resolveWithPolicy(
            `news:newsapi:${query.asset}`,
            this.ttlMs.news,
            () => this.newsApiOrgProvider.fetch(query.asset),
            "newsapi",
            [],
          )
          : Promise.resolve(disabledNewsStatus("newsapi")),
      ],
    );
    const newsResult = this.mergeNewsResults(cryptocurrencyCvResult, newsApiResult);

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
      market_constraints: market.marketConstraints,
      fundamentals: fundamentalsResult.data,
      sentimentSignals: sentimentResult.data,
      newsEvents: newsResult.data,
      providerStatus: [
        market.status,
        fundamentalsResult,
        sentimentResult,
        cryptocurrencyCvResult,
        newsApiResult,
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
    // newsapi key is optional because cryptocurrency.cv provides public news feed.
  }

  private mergeNewsResults(
    a: ProviderFetchResult<NewsEvent[]>,
    b: ProviderFetchResult<NewsEvent[]>,
  ): ProviderFetchResult<NewsEvent[]> {
    const merged = [...a.data, ...b.data];
    const seen = new Set<string>();
    const deduped: NewsEvent[] = [];
    for (const event of merged) {
      const key = `${event.title.trim().toLowerCase()}|${event.published_at ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(event);
    }
    deduped.sort((x, y) => (x.recency_hours ?? Number.MAX_SAFE_INTEGER) - (y.recency_hours ?? Number.MAX_SAFE_INTEGER));
    return {
      provider: "news-aggregate",
      ok: a.ok || b.ok,
      statusCode: a.ok || b.ok ? 200 : Math.max(a.statusCode, b.statusCode),
      latencyMs: Math.max(a.latencyMs, b.latencyMs),
      recordCount: deduped.length,
      data: deduped,
      message: [a.message, b.message].filter(Boolean).join(" | ") || undefined,
    };
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
    marketConstraints?: {
      min_notional_usd?: number;
      precision_step?: number;
      source: "exchange" | "fallback_env";
    };
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
        const market = (this.exchange as unknown as {
          market?: (symbol: string) => {
            limits?: { cost?: { min?: number } };
            precision?: { amount?: number };
          };
        }).market?.(query.asset);
        const minNotionalUsd = Number(market?.limits?.cost?.min ?? 0);
        const precisionStep = Number(market?.precision?.amount ?? 0);

        return {
          candles,
          lastPrice,
          marketConstraints: {
            min_notional_usd: Number.isFinite(minNotionalUsd) && minNotionalUsd > 0 ? minNotionalUsd : undefined,
            precision_step: Number.isFinite(precisionStep) && precisionStep > 0 ? precisionStep : undefined,
            source: "exchange",
          },
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

