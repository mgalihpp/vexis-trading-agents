import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseDotEnv } from "dotenv";
import type { FuturesMarginMode, FuturesPositionMode, FuturesScope, FuturesTimeInForce, SpotTimeInForce } from "../types";

export const ENV_TEMPLATE = `OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=openai/gpt-4o-mini
LLM_MAX_RETRIES=2
LANGSMITH_TRACING=false

NEWSAPI_KEY=
COINGECKO_API_KEY=
CRYPTOCURRENCY_CV_BASE_URL=https://cryptocurrency.cv
NEWSAPI_BASE_URL=https://newsapi.org/v2
ALTERNATIVE_ME_BASE_URL=https://api.alternative.me
COINGECKO_BASE_URL=https://api.coingecko.com/api/v3
PROVIDER_CACHE_TTL_SECONDS=300
STRICT_REAL_MODE=true

RUN_TIMEOUT_MS=30000
NODE_TIMEOUT_MS=12000
EXTERNAL_REQUESTS_PER_SECOND=3
PROVIDER_RETRY_MAX_ATTEMPTS=3
PROVIDER_RETRY_INITIAL_DELAY_MS=300
PROVIDER_RETRY_MAX_DELAY_MS=5000
PROVIDER_RETRY_BACKOFF_FACTOR=2
PROVIDER_RETRY_JITTER_MS=120
JOURNALING_ENABLED=false
JOURNALING_BASE_URL=https://vexis-log.vercel.app/api
JOURNALING_API_KEY=
JOURNALING_TIMEOUT_MS=5000
JOURNALING_RETRY_MAX_ATTEMPTS=3
JOURNALING_RETRY_INITIAL_DELAY_MS=300
JOURNALING_RETRY_MAX_DELAY_MS=5000
JOURNALING_RETRY_BACKOFF_FACTOR=2
JOURNALING_RETRY_JITTER_MS=120

SLO_P95_RUN_LATENCY_MS=15000
SLO_MAX_FALLBACK_RATIO=0.4
SLO_MAX_CONSECUTIVE_FAILURES=3

OBS_PERSIST_ENABLED=false
OBS_SQLITE_PATH=./data/observability.db
OBS_RETENTION_DAYS=30
OBS_CLEANUP_ENABLED=false

HEALTH_SERVER_ENABLED=false
HEALTH_SERVER_PORT=8787

RUNNER_ENABLED=false
RUNNER_INTERVAL_SECONDS=60
RUNNER_CANDLE_ALIGN=true
RUNNER_MAX_BACKOFF_SECONDS=900

SIM_FEE_BPS=0
SIM_SLIPPAGE_BPS=0
SIM_PARTIAL_FILL_ENABLED=false

BINANCE_API_KEY=
BINANCE_API_SECRET=
BINANCE_ACCOUNT_ENABLED=false
BINANCE_ACCOUNT_SCOPE=spot+usdm+coinm
BINANCE_DEFAULT_EXPOSURE_PCT=8
BINANCE_DEFAULT_DRAWDOWN_PCT=3

BINANCE_SPOT_ENABLED=false
BINANCE_SPOT_SYMBOL_WHITELIST=BTC/USDT,ETH/USDT,SOL/USDT
BINANCE_SPOT_DEFAULT_TIF=GTC
BINANCE_SPOT_RECV_WINDOW=10000

BINANCE_FUTURES_ENABLED=false
BINANCE_FUTURES_SCOPE_DEFAULT=usdm
BINANCE_FUTURES_SYMBOL_WHITELIST=BTC/USDT:USDT,ETH/USDT:USDT
BINANCE_FUTURES_DEFAULT_TIF=GTC
BINANCE_FUTURES_RECV_WINDOW=10000
BINANCE_FUTURES_DEFAULT_LEVERAGE=3
BINANCE_FUTURES_MARGIN_MODE=isolated
BINANCE_FUTURES_POSITION_MODE=hedge

PIPELINE_MODE=paper
OUTPUT_FORMAT=pretty
SHOW_TELEMETRY=false
TELEMETRY_CONSOLE=false
`;

export interface RuntimeConfig {
  openRouterApiKey: string;
  openRouterBaseUrl: string;
  openRouterModel: string;
  llmMaxRetries: number;
  enableLangSmithTracing: boolean;
  strictRealMode: boolean;
  showTelemetry: boolean;
  telemetryConsoleMirror: boolean;
  newsApiKey: string;
  coinGeckoApiKey: string;
  cryptocurrencyCvBaseUrl: string;
  newsApiBaseUrl: string;
  alternativeMeBaseUrl: string;
  coinGeckoBaseUrl: string;
  providerCacheTtlSeconds: number;
  runTimeoutMs: number;
  nodeTimeoutMs: number;
  externalRequestsPerSecond: number;
  providerRetryMaxAttempts: number;
  providerRetryInitialDelayMs: number;
  providerRetryMaxDelayMs: number;
  providerRetryBackoffFactor: number;
  providerRetryJitterMs: number;
  journalingEnabled: boolean;
  journalingBaseUrl: string;
  journalingApiKey: string;
  journalingTimeoutMs: number;
  journalingRetryMaxAttempts: number;
  journalingRetryInitialDelayMs: number;
  journalingRetryMaxDelayMs: number;
  journalingRetryBackoffFactor: number;
  journalingRetryJitterMs: number;
  sloP95RunLatencyMs: number;
  sloMaxFallbackRatio: number;
  sloMaxConsecutiveFailures: number;
  obsPersistEnabled: boolean;
  obsSqlitePath: string;
  obsRetentionDays: number;
  obsCleanupEnabled: boolean;
  runnerEnabled: boolean;
  runnerIntervalSeconds: number;
  runnerCandleAlign: boolean;
  runnerMaxBackoffSeconds: number;
  healthServerEnabled: boolean;
  healthServerPort: number;
  simFeeBps: number;
  simSlippageBps: number;
  simPartialFillEnabled: boolean;
  binanceApiKey: string;
  binanceApiSecret: string;
  binanceAccountEnabled: boolean;
  binanceAccountScope: "spot+usdm+coinm";
  binanceDefaultExposurePct: number;
  binanceDefaultDrawdownPct: number;
  binanceSpotEnabled: boolean;
  binanceSpotSymbolWhitelist: string[];
  binanceSpotDefaultTif: SpotTimeInForce;
  binanceSpotRecvWindow: number;
  binanceFuturesEnabled: boolean;
  binanceFuturesScopeDefault: FuturesScope;
  binanceFuturesSymbolWhitelist: string[];
  binanceFuturesDefaultTif: FuturesTimeInForce;
  binanceFuturesRecvWindow: number;
  binanceFuturesDefaultLeverage: number;
  binanceFuturesMarginMode: FuturesMarginMode;
  binanceFuturesPositionMode: FuturesPositionMode;
}

export type EnvValueSource = "flag" | "process" | "env-file" | "global" | "local" | "default";

interface RuntimeFlagOverrides {
  strictRealMode?: boolean;
}

export interface RuntimeEnvLoadOptions {
  envFile?: string;
  cwd?: string;
  homeDir?: string;
  processEnv?: NodeJS.ProcessEnv;
  flagOverrides?: RuntimeFlagOverrides;
}

export interface RuntimeEnvMeta {
  loadedFiles: string[];
  keySource: Record<string, EnvValueSource>;
  resolvedValues: Record<string, string>;
}

export interface RuntimeConfigWithMeta {
  runtime: RuntimeConfig;
  meta: RuntimeEnvMeta;
}

const asInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const asFloat = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
};

const asBool = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const asSpotTif = (value: string | undefined, fallback: SpotTimeInForce): SpotTimeInForce => {
  if (!value) return fallback;
  const normalized = value.trim().toUpperCase();
  if (normalized === "GTC" || normalized === "IOC" || normalized === "FOK") {
    return normalized;
  }
  return fallback;
};

const asFuturesScope = (value: string | undefined, fallback: FuturesScope): FuturesScope => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === "coinm" ? "coinm" : "usdm";
};

const asFuturesTif = (value: string | undefined, fallback: FuturesTimeInForce): FuturesTimeInForce => {
  if (!value) return fallback;
  const normalized = value.trim().toUpperCase();
  if (normalized === "GTC" || normalized === "IOC" || normalized === "FOK") return normalized;
  return fallback;
};

const asFuturesMarginMode = (
  value: string | undefined,
  fallback: FuturesMarginMode
): FuturesMarginMode => {
  if (!value) return fallback;
  return value.trim().toLowerCase() === "cross" ? "cross" : "isolated";
};

const asFuturesPositionMode = (
  value: string | undefined,
  fallback: FuturesPositionMode
): FuturesPositionMode => {
  if (!value) return fallback;
  return value.trim().toLowerCase() === "oneway" ? "oneway" : "hedge";
};

const asSecret = (value: string | undefined): string => {
  if (!value) return "";
  return value.trim();
};

const asHttpUrl = (value: string, envName: string): string => {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`${envName} must be http(s)`);
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid URL for ${envName}: ${value}`);
  }
};

const formatRuntimeConfigError = (message: string, meta: RuntimeEnvMeta): string => {
  const loadedFiles = meta.loadedFiles.length > 0 ? meta.loadedFiles.join(", ") : "(none)";
  return `Runtime config validation failed: ${message}. Loaded env files: ${loadedFiles}. Fix: run 'vexis env init --scope local' or 'vexis env init --scope global', then run 'vexis env check'.`;
};

const failIf = (condition: boolean, message: string, meta: RuntimeEnvMeta): void => {
  if (condition) {
    throw new Error(formatRuntimeConfigError(message, meta));
  }
};

const readEnvFile = (filePath: string): Record<string, string> => {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8");
  return parseDotEnv(raw);
};

const dedupePaths = (items: Array<{ source: EnvValueSource; path: string }>): Array<{ source: EnvValueSource; path: string }> => {
  const seen = new Set<string>();
  const out: Array<{ source: EnvValueSource; path: string }> = [];
  for (const item of items) {
    const normalized = path.resolve(item.path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ source: item.source, path: normalized });
  }
  return out;
};

const buildResolvedEnv = (options: RuntimeEnvLoadOptions): RuntimeEnvMeta => {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? os.homedir();
  const processEnv = options.processEnv ?? process.env;

  const localFile = path.resolve(cwd, ".env");
  const globalFile = path.resolve(homeDir, ".vexis", ".env");
  const explicitFile = options.envFile ? path.resolve(cwd, options.envFile) : undefined;

  const candidates = dedupePaths([
    { source: "local", path: localFile },
    { source: "global", path: globalFile },
    ...(explicitFile ? [{ source: "env-file" as const, path: explicitFile }] : [])
  ]);

  const resolvedValues: Record<string, string> = {};
  const keySource: Record<string, EnvValueSource> = {};
  const loadedFiles: string[] = [];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.path)) continue;
    const parsed = readEnvFile(candidate.path);
    loadedFiles.push(candidate.path);
    for (const [key, value] of Object.entries(parsed)) {
      resolvedValues[key] = value;
      keySource[key] = candidate.source;
    }
  }

  for (const [key, value] of Object.entries(processEnv)) {
    if (value === undefined) continue;
    resolvedValues[key] = value;
    keySource[key] = "process";
  }

  if (options.flagOverrides?.strictRealMode !== undefined) {
    resolvedValues.STRICT_REAL_MODE = String(options.flagOverrides.strictRealMode);
    keySource.STRICT_REAL_MODE = "flag";
  }

  return {
    loadedFiles,
    keySource,
    resolvedValues
  };
};

export const loadRuntimeConfigWithMeta = (options: RuntimeEnvLoadOptions = {}): RuntimeConfigWithMeta => {
  const meta = buildResolvedEnv(options);

  const getRaw = (name: string): string | undefined => {
    const value = meta.resolvedValues[name];
    if (value === undefined && meta.keySource[name] === undefined) {
      meta.keySource[name] = "default";
    }
    return value;
  };

  const cfg: RuntimeConfig = {
    openRouterApiKey: asSecret(getRaw("OPENROUTER_API_KEY")),
    openRouterBaseUrl: getRaw("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1",
    openRouterModel: getRaw("OPENROUTER_MODEL") ?? "openai/gpt-4o-mini",
    llmMaxRetries: asInt(getRaw("LLM_MAX_RETRIES"), 2),
    enableLangSmithTracing: asBool(getRaw("LANGSMITH_TRACING"), false),
    strictRealMode: asBool(getRaw("STRICT_REAL_MODE"), true),
    showTelemetry: asBool(getRaw("SHOW_TELEMETRY"), false),
    telemetryConsoleMirror: asBool(getRaw("TELEMETRY_CONSOLE"), false),
    newsApiKey: asSecret(getRaw("NEWSAPI_KEY")),
    coinGeckoApiKey: asSecret(getRaw("COINGECKO_API_KEY")),
    cryptocurrencyCvBaseUrl: getRaw("CRYPTOCURRENCY_CV_BASE_URL") ?? "https://cryptocurrency.cv",
    newsApiBaseUrl: getRaw("NEWSAPI_BASE_URL") ?? "https://newsapi.org/v2",
    alternativeMeBaseUrl: getRaw("ALTERNATIVE_ME_BASE_URL") ?? "https://api.alternative.me",
    coinGeckoBaseUrl: getRaw("COINGECKO_BASE_URL") ?? "https://api.coingecko.com/api/v3",
    providerCacheTtlSeconds: asInt(getRaw("PROVIDER_CACHE_TTL_SECONDS"), 300),
    runTimeoutMs: asInt(getRaw("RUN_TIMEOUT_MS"), 30000),
    nodeTimeoutMs: asInt(getRaw("NODE_TIMEOUT_MS"), 12000),
    externalRequestsPerSecond: asFloat(getRaw("EXTERNAL_REQUESTS_PER_SECOND"), 3),
    providerRetryMaxAttempts: asInt(getRaw("PROVIDER_RETRY_MAX_ATTEMPTS"), 3),
    providerRetryInitialDelayMs: asInt(getRaw("PROVIDER_RETRY_INITIAL_DELAY_MS"), 300),
    providerRetryMaxDelayMs: asInt(getRaw("PROVIDER_RETRY_MAX_DELAY_MS"), 5000),
    providerRetryBackoffFactor: asFloat(getRaw("PROVIDER_RETRY_BACKOFF_FACTOR"), 2),
    providerRetryJitterMs: asInt(getRaw("PROVIDER_RETRY_JITTER_MS"), 120),
    journalingEnabled: asBool(getRaw("JOURNALING_ENABLED"), false),
    journalingBaseUrl: getRaw("JOURNALING_BASE_URL") ?? "https://vexis-log.vercel.app/api",
    journalingApiKey: asSecret(getRaw("JOURNALING_API_KEY")),
    journalingTimeoutMs: asInt(getRaw("JOURNALING_TIMEOUT_MS"), 5000),
    journalingRetryMaxAttempts: asInt(getRaw("JOURNALING_RETRY_MAX_ATTEMPTS"), 3),
    journalingRetryInitialDelayMs: asInt(getRaw("JOURNALING_RETRY_INITIAL_DELAY_MS"), 300),
    journalingRetryMaxDelayMs: asInt(getRaw("JOURNALING_RETRY_MAX_DELAY_MS"), 5000),
    journalingRetryBackoffFactor: asFloat(getRaw("JOURNALING_RETRY_BACKOFF_FACTOR"), 2),
    journalingRetryJitterMs: asInt(getRaw("JOURNALING_RETRY_JITTER_MS"), 120),
    sloP95RunLatencyMs: asInt(getRaw("SLO_P95_RUN_LATENCY_MS"), 15000),
    sloMaxFallbackRatio: asFloat(getRaw("SLO_MAX_FALLBACK_RATIO"), 0.4),
    sloMaxConsecutiveFailures: asInt(getRaw("SLO_MAX_CONSECUTIVE_FAILURES"), 3),
    obsPersistEnabled: asBool(getRaw("OBS_PERSIST_ENABLED"), false),
    obsSqlitePath: getRaw("OBS_SQLITE_PATH") ?? "./data/observability.db",
    obsRetentionDays: asInt(getRaw("OBS_RETENTION_DAYS"), 30),
    obsCleanupEnabled: asBool(getRaw("OBS_CLEANUP_ENABLED"), false),
    runnerEnabled: asBool(getRaw("RUNNER_ENABLED"), false),
    runnerIntervalSeconds: asInt(getRaw("RUNNER_INTERVAL_SECONDS"), 60),
    runnerCandleAlign: asBool(getRaw("RUNNER_CANDLE_ALIGN"), true),
    runnerMaxBackoffSeconds: asInt(getRaw("RUNNER_MAX_BACKOFF_SECONDS"), 900),
    healthServerEnabled: asBool(getRaw("HEALTH_SERVER_ENABLED"), false),
    healthServerPort: asInt(getRaw("HEALTH_SERVER_PORT"), 8787),
    simFeeBps: asFloat(getRaw("SIM_FEE_BPS"), 0),
    simSlippageBps: asFloat(getRaw("SIM_SLIPPAGE_BPS"), 0),
    simPartialFillEnabled: asBool(getRaw("SIM_PARTIAL_FILL_ENABLED"), false),
    binanceApiKey: asSecret(getRaw("BINANCE_API_KEY")),
    binanceApiSecret: asSecret(getRaw("BINANCE_API_SECRET")),
    binanceAccountEnabled: asBool(getRaw("BINANCE_ACCOUNT_ENABLED"), false),
    binanceAccountScope:
      getRaw("BINANCE_ACCOUNT_SCOPE") === "spot+usdm+coinm"
        ? "spot+usdm+coinm"
        : "spot+usdm+coinm",
    binanceDefaultExposurePct: asFloat(getRaw("BINANCE_DEFAULT_EXPOSURE_PCT"), 8),
    binanceDefaultDrawdownPct: asFloat(getRaw("BINANCE_DEFAULT_DRAWDOWN_PCT"), 3),
    binanceSpotEnabled: asBool(getRaw("BINANCE_SPOT_ENABLED"), false),
    binanceSpotSymbolWhitelist: (getRaw("BINANCE_SPOT_SYMBOL_WHITELIST") ?? "BTC/USDT,ETH/USDT,SOL/USDT")
      .split(",")
      .map((v) => v.trim().toUpperCase())
      .filter(Boolean),
    binanceSpotDefaultTif: asSpotTif(getRaw("BINANCE_SPOT_DEFAULT_TIF"), "GTC"),
    binanceSpotRecvWindow: asInt(getRaw("BINANCE_SPOT_RECV_WINDOW"), 10000),
    binanceFuturesEnabled: asBool(getRaw("BINANCE_FUTURES_ENABLED"), false),
    binanceFuturesScopeDefault: asFuturesScope(getRaw("BINANCE_FUTURES_SCOPE_DEFAULT"), "usdm"),
    binanceFuturesSymbolWhitelist: (getRaw("BINANCE_FUTURES_SYMBOL_WHITELIST") ?? "BTC/USDT:USDT,ETH/USDT:USDT")
      .split(",")
      .map((v) => v.trim().toUpperCase())
      .filter(Boolean),
    binanceFuturesDefaultTif: asFuturesTif(getRaw("BINANCE_FUTURES_DEFAULT_TIF"), "GTC"),
    binanceFuturesRecvWindow: asInt(getRaw("BINANCE_FUTURES_RECV_WINDOW"), 10000),
    binanceFuturesDefaultLeverage: asInt(getRaw("BINANCE_FUTURES_DEFAULT_LEVERAGE"), 3),
    binanceFuturesMarginMode: asFuturesMarginMode(getRaw("BINANCE_FUTURES_MARGIN_MODE"), "isolated"),
    binanceFuturesPositionMode: asFuturesPositionMode(getRaw("BINANCE_FUTURES_POSITION_MODE"), "hedge")
  };

  try {
    cfg.openRouterBaseUrl = asHttpUrl(cfg.openRouterBaseUrl, "OPENROUTER_BASE_URL");
    cfg.cryptocurrencyCvBaseUrl = asHttpUrl(cfg.cryptocurrencyCvBaseUrl, "CRYPTOCURRENCY_CV_BASE_URL");
    cfg.newsApiBaseUrl = asHttpUrl(cfg.newsApiBaseUrl, "NEWSAPI_BASE_URL");
    cfg.alternativeMeBaseUrl = asHttpUrl(cfg.alternativeMeBaseUrl, "ALTERNATIVE_ME_BASE_URL");
    cfg.coinGeckoBaseUrl = asHttpUrl(cfg.coinGeckoBaseUrl, "COINGECKO_BASE_URL");
    cfg.journalingBaseUrl = asHttpUrl(cfg.journalingBaseUrl, "JOURNALING_BASE_URL");
  } catch (error) {
    throw new Error(formatRuntimeConfigError(String(error), meta));
  }

  failIf(cfg.llmMaxRetries < 0, "LLM_MAX_RETRIES must be >= 0", meta);
  failIf(cfg.providerCacheTtlSeconds < 0, "PROVIDER_CACHE_TTL_SECONDS must be >= 0", meta);
  failIf(cfg.runTimeoutMs < 1000, "RUN_TIMEOUT_MS must be >= 1000", meta);
  failIf(cfg.nodeTimeoutMs < 500, "NODE_TIMEOUT_MS must be >= 500", meta);
  failIf(cfg.externalRequestsPerSecond <= 0, "EXTERNAL_REQUESTS_PER_SECOND must be > 0", meta);
  failIf(cfg.providerRetryMaxAttempts < 1, "PROVIDER_RETRY_MAX_ATTEMPTS must be >= 1", meta);
  failIf(cfg.providerRetryInitialDelayMs < 0, "PROVIDER_RETRY_INITIAL_DELAY_MS must be >= 0", meta);
  failIf(cfg.providerRetryMaxDelayMs < cfg.providerRetryInitialDelayMs, "PROVIDER_RETRY_MAX_DELAY_MS must be >= PROVIDER_RETRY_INITIAL_DELAY_MS", meta);
  failIf(cfg.providerRetryBackoffFactor < 1, "PROVIDER_RETRY_BACKOFF_FACTOR must be >= 1", meta);
  failIf(cfg.providerRetryJitterMs < 0, "PROVIDER_RETRY_JITTER_MS must be >= 0", meta);
  failIf(cfg.journalingTimeoutMs < 500, "JOURNALING_TIMEOUT_MS must be >= 500", meta);
  failIf(cfg.journalingRetryMaxAttempts < 1, "JOURNALING_RETRY_MAX_ATTEMPTS must be >= 1", meta);
  failIf(cfg.journalingRetryInitialDelayMs < 0, "JOURNALING_RETRY_INITIAL_DELAY_MS must be >= 0", meta);
  failIf(cfg.journalingRetryMaxDelayMs < cfg.journalingRetryInitialDelayMs, "JOURNALING_RETRY_MAX_DELAY_MS must be >= JOURNALING_RETRY_INITIAL_DELAY_MS", meta);
  failIf(cfg.journalingRetryBackoffFactor < 1, "JOURNALING_RETRY_BACKOFF_FACTOR must be >= 1", meta);
  failIf(cfg.journalingRetryJitterMs < 0, "JOURNALING_RETRY_JITTER_MS must be >= 0", meta);
  failIf(cfg.sloP95RunLatencyMs <= 0, "SLO_P95_RUN_LATENCY_MS must be > 0", meta);
  failIf(cfg.sloMaxFallbackRatio < 0 || cfg.sloMaxFallbackRatio > 1, "SLO_MAX_FALLBACK_RATIO must be 0..1", meta);
  failIf(cfg.sloMaxConsecutiveFailures < 1, "SLO_MAX_CONSECUTIVE_FAILURES must be >= 1", meta);

  failIf(cfg.runnerIntervalSeconds < 5, "RUNNER_INTERVAL_SECONDS must be >= 5", meta);
  failIf(cfg.runnerMaxBackoffSeconds < cfg.runnerIntervalSeconds, "RUNNER_MAX_BACKOFF_SECONDS must be >= RUNNER_INTERVAL_SECONDS", meta);
  failIf(cfg.obsRetentionDays < 1, "OBS_RETENTION_DAYS must be >= 1", meta);
  failIf(cfg.healthServerPort < 1 || cfg.healthServerPort > 65535, "HEALTH_SERVER_PORT must be within 1..65535", meta);
  failIf(cfg.simFeeBps < 0, "SIM_FEE_BPS must be >= 0", meta);
  failIf(cfg.simSlippageBps < 0, "SIM_SLIPPAGE_BPS must be >= 0", meta);
  failIf(cfg.binanceAccountScope !== "spot+usdm+coinm", "BINANCE_ACCOUNT_SCOPE currently supports only 'spot+usdm+coinm'", meta);
  failIf(cfg.binanceDefaultExposurePct < 0 || cfg.binanceDefaultExposurePct > 100, "BINANCE_DEFAULT_EXPOSURE_PCT must be within 0..100", meta);
  failIf(cfg.binanceDefaultDrawdownPct < 0 || cfg.binanceDefaultDrawdownPct > 100, "BINANCE_DEFAULT_DRAWDOWN_PCT must be within 0..100", meta);
  failIf(cfg.binanceSpotRecvWindow < 1000, "BINANCE_SPOT_RECV_WINDOW must be >= 1000", meta);
  failIf(cfg.binanceFuturesRecvWindow < 1000, "BINANCE_FUTURES_RECV_WINDOW must be >= 1000", meta);
  failIf(cfg.binanceFuturesDefaultLeverage < 1 || cfg.binanceFuturesDefaultLeverage > 125, "BINANCE_FUTURES_DEFAULT_LEVERAGE must be in 1..125", meta);

  if (cfg.obsPersistEnabled) {
    const resolvedDbPath = path.resolve(cfg.obsSqlitePath);
    const dbDir = path.dirname(resolvedDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
  }

  if (cfg.strictRealMode) {
    failIf(!cfg.openRouterApiKey, "OPENROUTER_API_KEY is required when STRICT_REAL_MODE=true", meta);
  }

  if (cfg.journalingEnabled) {
    failIf(!cfg.journalingApiKey, "JOURNALING_API_KEY is required when JOURNALING_ENABLED=true", meta);
  }

  if (cfg.binanceAccountEnabled) {
    failIf(!cfg.binanceApiKey, "BINANCE_API_KEY is required when BINANCE_ACCOUNT_ENABLED=true", meta);
    failIf(!cfg.binanceApiSecret, "BINANCE_API_SECRET is required when BINANCE_ACCOUNT_ENABLED=true", meta);
  }

  if (cfg.binanceSpotEnabled) {
    failIf(!cfg.binanceApiKey, "BINANCE_API_KEY is required when BINANCE_SPOT_ENABLED=true", meta);
    failIf(!cfg.binanceApiSecret, "BINANCE_API_SECRET is required when BINANCE_SPOT_ENABLED=true", meta);
    failIf(cfg.binanceSpotSymbolWhitelist.length === 0, "BINANCE_SPOT_SYMBOL_WHITELIST must include at least one symbol when BINANCE_SPOT_ENABLED=true", meta);
  }

  if (cfg.binanceFuturesEnabled) {
    failIf(!cfg.binanceApiKey, "BINANCE_API_KEY is required when BINANCE_FUTURES_ENABLED=true", meta);
    failIf(!cfg.binanceApiSecret, "BINANCE_API_SECRET is required when BINANCE_FUTURES_ENABLED=true", meta);
    failIf(cfg.binanceFuturesSymbolWhitelist.length === 0, "BINANCE_FUTURES_SYMBOL_WHITELIST must include at least one symbol when BINANCE_FUTURES_ENABLED=true", meta);
  }

  return { runtime: cfg, meta };
};

export const loadRuntimeConfig = (options: RuntimeEnvLoadOptions = {}): RuntimeConfig => {
  return loadRuntimeConfigWithMeta(options).runtime;
};
