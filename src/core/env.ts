import { config as loadDotEnv } from "dotenv";
import { EnvSecretProvider } from "./secrets";

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
    sloMaxConsecutiveFailures: asInt(process.env.SLO_MAX_CONSECUTIVE_FAILURES, 3)
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

  if (cfg.strictRealMode) {
    failIf(!cfg.theNewsApiKey, "THENEWSAPI_KEY is required when STRICT_REAL_MODE=true");
    failIf(!cfg.openRouterApiKey, "OPENROUTER_API_KEY is required when STRICT_REAL_MODE=true");
  }

  return cfg;
};
