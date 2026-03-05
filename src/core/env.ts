import fs from "node:fs";
import path from "node:path";
import { config as loadDotEnv } from "dotenv";
import { EnvSecretProvider } from "./secrets";
import type { SpotTimeInForce } from "../types";

loadDotEnv();

export interface RuntimeConfig {
  openRouterApiKey: string;
  openRouterBaseUrl: string;
  openRouterModel: string;
  llmMaxRetries: number;
  enableLangSmithTracing: boolean;
  strictRealMode: boolean;
  theNewsApiKey: string;
  coinGeckoApiKey: string;
  theNewsApiBaseUrl: string;
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

const failIf = (condition: boolean, message: string): void => {
  if (condition) {
    throw new Error(`Runtime config validation failed: ${message}`);
  }
};

export const loadRuntimeConfig = (): RuntimeConfig => {
  const secrets = new EnvSecretProvider();

  const cfg: RuntimeConfig = {
    openRouterApiKey: secrets.get("OPENROUTER_API_KEY") ?? "",
    openRouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    openRouterModel: process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini",
    llmMaxRetries: asInt(process.env.LLM_MAX_RETRIES, 2),
    enableLangSmithTracing: asBool(process.env.LANGSMITH_TRACING, false),
    strictRealMode: asBool(process.env.STRICT_REAL_MODE, true),
    theNewsApiKey: secrets.get("THENEWSAPI_KEY") ?? "",
    coinGeckoApiKey: secrets.get("COINGECKO_API_KEY") ?? "",
    theNewsApiBaseUrl: process.env.THENEWSAPI_BASE_URL ?? "https://api.thenewsapi.com/v1/news",
    alternativeMeBaseUrl: process.env.ALTERNATIVE_ME_BASE_URL ?? "https://api.alternative.me",
    coinGeckoBaseUrl: process.env.COINGECKO_BASE_URL ?? "https://api.coingecko.com/api/v3",
    providerCacheTtlSeconds: asInt(process.env.PROVIDER_CACHE_TTL_SECONDS, 300),
    runTimeoutMs: asInt(process.env.RUN_TIMEOUT_MS, 30000),
    nodeTimeoutMs: asInt(process.env.NODE_TIMEOUT_MS, 12000),
    externalRequestsPerSecond: asFloat(process.env.EXTERNAL_REQUESTS_PER_SECOND, 3),
    providerRetryMaxAttempts: asInt(process.env.PROVIDER_RETRY_MAX_ATTEMPTS, 3),
    providerRetryInitialDelayMs: asInt(process.env.PROVIDER_RETRY_INITIAL_DELAY_MS, 300),
    providerRetryMaxDelayMs: asInt(process.env.PROVIDER_RETRY_MAX_DELAY_MS, 5000),
    providerRetryBackoffFactor: asFloat(process.env.PROVIDER_RETRY_BACKOFF_FACTOR, 2),
    providerRetryJitterMs: asInt(process.env.PROVIDER_RETRY_JITTER_MS, 120),
    sloP95RunLatencyMs: asInt(process.env.SLO_P95_RUN_LATENCY_MS, 15000),
    sloMaxFallbackRatio: asFloat(process.env.SLO_MAX_FALLBACK_RATIO, 0.4),
    sloMaxConsecutiveFailures: asInt(process.env.SLO_MAX_CONSECUTIVE_FAILURES, 3),
    obsPersistEnabled: asBool(process.env.OBS_PERSIST_ENABLED, false),
    obsSqlitePath: process.env.OBS_SQLITE_PATH ?? "./data/observability.db",
    obsRetentionDays: asInt(process.env.OBS_RETENTION_DAYS, 30),
    obsCleanupEnabled: asBool(process.env.OBS_CLEANUP_ENABLED, false),
    runnerEnabled: asBool(process.env.RUNNER_ENABLED, false),
    runnerIntervalSeconds: asInt(process.env.RUNNER_INTERVAL_SECONDS, 60),
    runnerCandleAlign: asBool(process.env.RUNNER_CANDLE_ALIGN, true),
    runnerMaxBackoffSeconds: asInt(process.env.RUNNER_MAX_BACKOFF_SECONDS, 900),
    healthServerEnabled: asBool(process.env.HEALTH_SERVER_ENABLED, false),
    healthServerPort: asInt(process.env.HEALTH_SERVER_PORT, 8787),
    simFeeBps: asFloat(process.env.SIM_FEE_BPS, 0),
    simSlippageBps: asFloat(process.env.SIM_SLIPPAGE_BPS, 0),
    simPartialFillEnabled: asBool(process.env.SIM_PARTIAL_FILL_ENABLED, false),
    binanceApiKey: secrets.get("BINANCE_API_KEY") ?? "",
    binanceApiSecret: secrets.get("BINANCE_API_SECRET") ?? "",
    binanceAccountEnabled: asBool(process.env.BINANCE_ACCOUNT_ENABLED, false),
    binanceAccountScope:
      process.env.BINANCE_ACCOUNT_SCOPE === "spot+usdm+coinm"
        ? "spot+usdm+coinm"
        : "spot+usdm+coinm",
    binanceDefaultExposurePct: asFloat(process.env.BINANCE_DEFAULT_EXPOSURE_PCT, 8),
    binanceDefaultDrawdownPct: asFloat(process.env.BINANCE_DEFAULT_DRAWDOWN_PCT, 3),
    binanceSpotEnabled: asBool(process.env.BINANCE_SPOT_ENABLED, false),
    binanceSpotSymbolWhitelist: (process.env.BINANCE_SPOT_SYMBOL_WHITELIST ?? "BTC/USDT,ETH/USDT,SOL/USDT")
      .split(",")
      .map((v) => v.trim().toUpperCase())
      .filter(Boolean),
    binanceSpotDefaultTif: asSpotTif(process.env.BINANCE_SPOT_DEFAULT_TIF, "GTC"),
    binanceSpotRecvWindow: asInt(process.env.BINANCE_SPOT_RECV_WINDOW, 10000)
  };

  cfg.openRouterBaseUrl = asHttpUrl(cfg.openRouterBaseUrl, "OPENROUTER_BASE_URL");
  cfg.theNewsApiBaseUrl = asHttpUrl(cfg.theNewsApiBaseUrl, "THENEWSAPI_BASE_URL");
  cfg.alternativeMeBaseUrl = asHttpUrl(cfg.alternativeMeBaseUrl, "ALTERNATIVE_ME_BASE_URL");
  cfg.coinGeckoBaseUrl = asHttpUrl(cfg.coinGeckoBaseUrl, "COINGECKO_BASE_URL");

  failIf(cfg.llmMaxRetries < 0, "LLM_MAX_RETRIES must be >= 0");
  failIf(cfg.providerCacheTtlSeconds < 0, "PROVIDER_CACHE_TTL_SECONDS must be >= 0");
  failIf(cfg.runTimeoutMs < 1000, "RUN_TIMEOUT_MS must be >= 1000");
  failIf(cfg.nodeTimeoutMs < 500, "NODE_TIMEOUT_MS must be >= 500");
  failIf(cfg.externalRequestsPerSecond <= 0, "EXTERNAL_REQUESTS_PER_SECOND must be > 0");
  failIf(cfg.providerRetryMaxAttempts < 1, "PROVIDER_RETRY_MAX_ATTEMPTS must be >= 1");
  failIf(cfg.providerRetryInitialDelayMs < 0, "PROVIDER_RETRY_INITIAL_DELAY_MS must be >= 0");
  failIf(cfg.providerRetryMaxDelayMs < cfg.providerRetryInitialDelayMs, "PROVIDER_RETRY_MAX_DELAY_MS must be >= PROVIDER_RETRY_INITIAL_DELAY_MS");
  failIf(cfg.providerRetryBackoffFactor < 1, "PROVIDER_RETRY_BACKOFF_FACTOR must be >= 1");
  failIf(cfg.providerRetryJitterMs < 0, "PROVIDER_RETRY_JITTER_MS must be >= 0");
  failIf(cfg.sloP95RunLatencyMs <= 0, "SLO_P95_RUN_LATENCY_MS must be > 0");
  failIf(cfg.sloMaxFallbackRatio < 0 || cfg.sloMaxFallbackRatio > 1, "SLO_MAX_FALLBACK_RATIO must be 0..1");
  failIf(cfg.sloMaxConsecutiveFailures < 1, "SLO_MAX_CONSECUTIVE_FAILURES must be >= 1");

  failIf(cfg.runnerIntervalSeconds < 5, "RUNNER_INTERVAL_SECONDS must be >= 5");
  failIf(cfg.runnerMaxBackoffSeconds < cfg.runnerIntervalSeconds, "RUNNER_MAX_BACKOFF_SECONDS must be >= RUNNER_INTERVAL_SECONDS");
  failIf(cfg.obsRetentionDays < 1, "OBS_RETENTION_DAYS must be >= 1");
  failIf(cfg.healthServerPort < 1 || cfg.healthServerPort > 65535, "HEALTH_SERVER_PORT must be within 1..65535");
  failIf(cfg.simFeeBps < 0, "SIM_FEE_BPS must be >= 0");
  failIf(cfg.simSlippageBps < 0, "SIM_SLIPPAGE_BPS must be >= 0");
  failIf(cfg.binanceAccountScope !== "spot+usdm+coinm", "BINANCE_ACCOUNT_SCOPE currently supports only 'spot+usdm+coinm'");
  failIf(cfg.binanceDefaultExposurePct < 0 || cfg.binanceDefaultExposurePct > 100, "BINANCE_DEFAULT_EXPOSURE_PCT must be within 0..100");
  failIf(cfg.binanceDefaultDrawdownPct < 0 || cfg.binanceDefaultDrawdownPct > 100, "BINANCE_DEFAULT_DRAWDOWN_PCT must be within 0..100");
  failIf(cfg.binanceSpotRecvWindow < 1000, "BINANCE_SPOT_RECV_WINDOW must be >= 1000");

  if (cfg.obsPersistEnabled) {
    const resolvedDbPath = path.resolve(cfg.obsSqlitePath);
    const dbDir = path.dirname(resolvedDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
  }

  if (cfg.strictRealMode) {
    failIf(!cfg.theNewsApiKey, "THENEWSAPI_KEY is required when STRICT_REAL_MODE=true");
    failIf(!cfg.openRouterApiKey, "OPENROUTER_API_KEY is required when STRICT_REAL_MODE=true");
  }

  if (cfg.binanceAccountEnabled) {
    failIf(!cfg.binanceApiKey, "BINANCE_API_KEY is required when BINANCE_ACCOUNT_ENABLED=true");
    failIf(!cfg.binanceApiSecret, "BINANCE_API_SECRET is required when BINANCE_ACCOUNT_ENABLED=true");
  }

  if (cfg.binanceSpotEnabled) {
    failIf(!cfg.binanceApiKey, "BINANCE_API_KEY is required when BINANCE_SPOT_ENABLED=true");
    failIf(!cfg.binanceApiSecret, "BINANCE_API_SECRET is required when BINANCE_SPOT_ENABLED=true");
    failIf(cfg.binanceSpotSymbolWhitelist.length === 0, "BINANCE_SPOT_SYMBOL_WHITELIST must include at least one symbol when BINANCE_SPOT_ENABLED=true");
  }

  return cfg;
};
