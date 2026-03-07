#!/usr/bin/env node

import { confirm, input, select } from "@inquirer/prompts";
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BinanceAccountProvider, StaticPortfolioStateProvider } from "./core/account-state";
import { BinanceFuturesTradingService } from "./core/futures-trading";
import { HealthMonitor } from "./core/health";
import { HealthServer } from "./core/health-server";
import { BinanceSpotTradingService } from "./core/spot-trading";
import { InMemoryTelemetrySink, SqliteTelemetrySink } from "./core/telemetry";
import { ENV_TEMPLATE, loadRuntimeConfigWithMeta, type RuntimeConfig } from "./core/env";
import { runApp, type AppRunOverrides } from "./main";
import { runOpsTail } from "./scripts/ops-tail";
import { runDeterministicChecks } from "./scripts/validate";
import type {
  CliCommandResult,
  CliGlobalOptions,
  EffectiveConfigView,
  FuturesScope,
  FuturesTimeInForce,
  JSONValue,
  OutputFormat,
  PipelineMode,
  RunnerState,
  SpotOrderRequest,
  SpotTimeInForce
} from "./types";

interface CommonRunOptions {
  asset?: string;
  timeframe?: string;
  limit?: number;
  showTelemetry?: boolean;
}

interface RunnerOptions extends CommonRunOptions {
  interval?: number;
  candleAlign?: boolean;
  maxBackoff?: number;
}

interface HealthOptions {
  check?: "healthz" | "readyz";
  port?: number;
  serve?: boolean;
}

interface EnvInitOptions {
  scope?: "global" | "local";
  path?: string;
  force?: boolean;
}

interface TailOptions {
  runId?: string;
  traceId?: string;
  since?: string;
  severity?: "info" | "warning" | "critical";
  limit?: number;
  json?: boolean;
}

interface SpotPlaceOptions {
  symbol: string;
  type?: "market" | "limit";
  amount?: number;
  price?: number;
  quoteCost?: number;
  stopLoss?: number;
  takeProfit?: number;
  tif?: SpotTimeInForce;
}

interface SpotOrderGetOptions {
  symbol: string;
  orderId: string;
}

interface SpotOrdersListOptions {
  symbol?: string;
  limit?: number;
}

interface SpotOrderCancelOptions {
  symbol: string;
  orderId: string;
}

interface SpotTradesOptions {
  symbol: string;
  limit?: number;
}

interface SpotQuoteOptions {
  symbol: string;
  depth?: number;
}

interface SpotProtectOptions {
  symbol: string;
  amount: number;
  stopLoss?: number;
  takeProfit?: number;
}

interface FuturesPlaceOptions {
  scope?: FuturesScope;
  symbol: string;
  type?: "market" | "limit";
  amount?: number;
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  tif?: FuturesTimeInForce;
  reduceOnly?: boolean;
}

interface FuturesOrderGetOptions {
  scope?: FuturesScope;
  symbol: string;
  orderId: string;
}

interface FuturesOrdersListOptions {
  scope?: FuturesScope;
  symbol?: string;
  limit?: number;
}

interface FuturesOrderCancelOptions {
  scope?: FuturesScope;
  symbol: string;
  orderId: string;
}

interface FuturesPositionsOptions {
  scope?: FuturesScope;
  symbol?: string;
}

interface FuturesTradesOptions {
  scope?: FuturesScope;
  symbol: string;
  limit?: number;
}

interface FuturesQuoteOptions {
  scope?: FuturesScope;
  symbol: string;
  depth?: number;
}

interface FuturesProtectOptions {
  scope?: FuturesScope;
  symbol: string;
  side: "buy" | "sell";
  amount: number;
  stopLoss?: number;
  takeProfit?: number;
}

interface DashboardServerHandle {
  server: HealthServer;
  port: number;
}

const SPINNER_FRAMES = ["|", "/", "-", "\\"];

const formatElapsed = (startedMs: number): string => {
  const totalSec = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
  const m = Math.floor(totalSec / 60)
    .toString()
    .padStart(2, "0");
  const s = (totalSec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
};

const withLoading = async <T>(
  label: string,
  action: () => Promise<T>,
): Promise<T> => {
  const startedMs = Date.now();
  let frameIdx = 0;
  let spinnerVisible = false;
  let internalWrite = false;

  const safeErrWrite = (text: string): void => {
    internalWrite = true;
    process.stderr.write(text);
    internalWrite = false;
  };

  const clearSpinnerLine = (): void => {
    if (!spinnerVisible) return;
    safeErrWrite("\r\x1b[2K");
    spinnerVisible = false;
  };

  const wrapStream = (stream: NodeJS.WriteStream): (() => void) => {
    const original = stream.write.bind(stream);
    (stream.write as unknown as (...args: unknown[]) => unknown) = (
      chunk: unknown,
      ...args: unknown[]
    ): unknown => {
      if (!internalWrite) {
        clearSpinnerLine();
      }
      return original(chunk as never, ...(args as []));
    };
    return () => {
      (stream.write as unknown as (...args: unknown[]) => unknown) = original as unknown as (
        ...args: unknown[]
      ) => unknown;
    };
  };

  const restoreStdout = wrapStream(process.stdout);
  const restoreStderr = wrapStream(process.stderr);

  const interval = setInterval(() => {
    const frame = SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length];
    frameIdx += 1;
    safeErrWrite(
      `\r${frame} ${label} (elapsed ${formatElapsed(startedMs)})`,
    );
    spinnerVisible = true;
  }, 120);

  try {
    const result = await action();
    clearInterval(interval);
    clearSpinnerLine();
    safeErrWrite(
      `\r[OK] ${label} completed in ${formatElapsed(startedMs)}\n`,
    );
    restoreStdout();
    restoreStderr();
    return result;
  } catch (error) {
    clearInterval(interval);
    clearSpinnerLine();
    safeErrWrite(
      `\r[FAIL] ${label} failed after ${formatElapsed(startedMs)}\n`,
    );
    restoreStdout();
    restoreStderr();
    throw error;
  }

};
const parseMode = (value: string | undefined): PipelineMode | undefined => {
  if (!value) return undefined;
  if (["backtest", "paper", "live-sim"].includes(value)) {
    return value as PipelineMode;
  }
  return undefined;
};

const parseOutput = (value: string | undefined): OutputFormat | undefined => {
  if (!value) return undefined;
  if (value === "pretty" || value === "json") {
    return value;
  }
  return undefined;
};

const normalizeGlobalOptions = (command: Command): CliGlobalOptions => {
  const raw = typeof (command as unknown as { optsWithGlobals?: () => Record<string, unknown> }).optsWithGlobals === "function"
    ? (command as unknown as { optsWithGlobals: () => Record<string, unknown> }).optsWithGlobals()
    : command.opts();

  return {
    json: Boolean(raw.json),
    output: parseOutput(typeof raw.output === "string" ? raw.output : undefined),
    mode: parseMode(typeof raw.mode === "string" ? raw.mode : undefined),
    envFile: typeof raw.envFile === "string" ? raw.envFile : undefined
  };
};

const maskSecret = (value: string): string => {
  if (!value) return "";
  if (value.length <= 6) return "***";
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
};

interface ResolvedRuntime {
  runtime: RuntimeConfig;
  view: EffectiveConfigView;
}

const makeSpotContext = (mode: PipelineMode): { runId: string; traceId: string; mode: PipelineMode } => ({
  runId: `spot-op-${Date.now()}`,
  traceId: randomUUID(),
  mode
});

const makeFuturesContext = (mode: PipelineMode): { runId: string; traceId: string; mode: PipelineMode } => ({
  runId: `futures-op-${Date.now()}`,
  traceId: randomUUID(),
  mode
});

const getSpotService = (runtime: RuntimeConfig, mode: PipelineMode): BinanceSpotTradingService => {
  const telemetrySink = runtime.obsPersistEnabled
    ? new SqliteTelemetrySink(runtime.obsSqlitePath)
    : new InMemoryTelemetrySink(false);
  const protectionDbPath = runtime.obsPersistEnabled ? runtime.obsSqlitePath : undefined;
  return BinanceSpotTradingService.getInstance({
    enabled: runtime.binanceSpotEnabled,
    apiKey: runtime.binanceApiKey,
    apiSecret: runtime.binanceApiSecret,
    symbolWhitelist: runtime.binanceSpotSymbolWhitelist,
    defaultTif: runtime.binanceSpotDefaultTif,
    recvWindow: runtime.binanceSpotRecvWindow,
    timeoutMs: runtime.nodeTimeoutMs,
    protectionDbPath,
    mode,
    telemetrySink
  });
};

const normalizeFuturesScope = (runtime: RuntimeConfig, scope?: FuturesScope): FuturesScope =>
  scope ?? runtime.binanceFuturesScopeDefault;

const normalizeFuturesSymbol = (symbol: string): string => {
  const raw = symbol.trim().toUpperCase();
  return raw.includes(":") ? raw : `${raw}:USDT`;
};

const getFuturesService = (runtime: RuntimeConfig, mode: PipelineMode): BinanceFuturesTradingService => {
  const telemetrySink = runtime.obsPersistEnabled
    ? new SqliteTelemetrySink(runtime.obsSqlitePath)
    : new InMemoryTelemetrySink(false);
  const protectionDbPath = runtime.obsPersistEnabled ? runtime.obsSqlitePath : undefined;
  return BinanceFuturesTradingService.getInstance({
    enabled: runtime.binanceFuturesEnabled,
    apiKey: runtime.binanceApiKey,
    apiSecret: runtime.binanceApiSecret,
    symbolWhitelist: runtime.binanceFuturesSymbolWhitelist,
    defaultScope: runtime.binanceFuturesScopeDefault,
    defaultTif: runtime.binanceFuturesDefaultTif,
    recvWindow: runtime.binanceFuturesRecvWindow,
    timeoutMs: runtime.nodeTimeoutMs,
    defaultLeverage: runtime.binanceFuturesDefaultLeverage,
    marginMode: runtime.binanceFuturesMarginMode,
    positionMode: runtime.binanceFuturesPositionMode,
    protectionDbPath,
    mode,
    telemetrySink
  });
};

const asJsonValue = (value: unknown): JSONValue => value as JSONValue;

const resolveRuntimeConfig = (
  global: CliGlobalOptions,
  overrides: Partial<AppRunOverrides>
): ResolvedRuntime => {
  const { runtime, meta } = loadRuntimeConfigWithMeta({ envFile: global.envFile });
  const envOrDefault = (name: string): "env" | "default" =>
    meta.keySource[name] && meta.keySource[name] !== "default" ? "env" : "default";
  const modeFromEnv = parseMode(meta.resolvedValues.PIPELINE_MODE) ?? "backtest";
  const outputFromEnv = parseOutput(meta.resolvedValues.OUTPUT_FORMAT) ?? "pretty";

  const effective: Record<string, JSONValue> = {
    mode: global.mode ?? modeFromEnv,
    output: global.output ?? outputFromEnv,
    env_file: global.envFile ?? "",
    env_files_loaded: meta.loadedFiles,
    show_telemetry: overrides.showTelemetry ?? runtime.showTelemetry,
    runner_enabled: overrides.runnerEnabled ?? runtime.runnerEnabled,
    runner_interval_seconds: overrides.runnerIntervalSeconds ?? runtime.runnerIntervalSeconds,
    runner_candle_align: overrides.runnerCandleAlign ?? runtime.runnerCandleAlign,
    runner_max_backoff_seconds: overrides.runnerMaxBackoffSeconds ?? runtime.runnerMaxBackoffSeconds,
    binance_account_enabled: runtime.binanceAccountEnabled,
    strict_real_mode: runtime.strictRealMode,
    obs_persist_enabled: runtime.obsPersistEnabled,
    obs_sqlite_path: runtime.obsSqlitePath,
    binance_spot_enabled: runtime.binanceSpotEnabled,
    binance_spot_symbol_whitelist: runtime.binanceSpotSymbolWhitelist,
    binance_spot_default_tif: runtime.binanceSpotDefaultTif,
    binance_spot_recv_window: runtime.binanceSpotRecvWindow,
    binance_futures_enabled: runtime.binanceFuturesEnabled,
    binance_futures_scope_default: runtime.binanceFuturesScopeDefault,
    binance_futures_symbol_whitelist: runtime.binanceFuturesSymbolWhitelist,
    binance_futures_default_tif: runtime.binanceFuturesDefaultTif,
    binance_futures_recv_window: runtime.binanceFuturesRecvWindow,
    binance_futures_default_leverage: runtime.binanceFuturesDefaultLeverage,
    binance_futures_margin_mode: runtime.binanceFuturesMarginMode,
    binance_futures_position_mode: runtime.binanceFuturesPositionMode,
    openrouter_model: runtime.openRouterModel,
    binance_api_key: maskSecret(runtime.binanceApiKey),
    binance_api_secret: maskSecret(runtime.binanceApiSecret),
    openrouter_api_key: maskSecret(runtime.openRouterApiKey),
    thenewsapi_key: maskSecret(runtime.theNewsApiKey)
  };

  const source: Record<string, "flag" | "env" | "default"> = {
    mode: global.mode ? "flag" : envOrDefault("PIPELINE_MODE"),
    output: global.output ? "flag" : envOrDefault("OUTPUT_FORMAT"),
    env_file: global.envFile ? "flag" : "default",
    env_files_loaded: meta.loadedFiles.length > 0 ? "env" : "default",
    show_telemetry:
      overrides.showTelemetry !== undefined
        ? "flag"
        : envOrDefault("SHOW_TELEMETRY"),
    runner_enabled:
      overrides.runnerEnabled !== undefined
        ? "flag"
        : envOrDefault("RUNNER_ENABLED"),
    runner_interval_seconds:
      overrides.runnerIntervalSeconds !== undefined
        ? "flag"
        : envOrDefault("RUNNER_INTERVAL_SECONDS"),
    runner_candle_align:
      overrides.runnerCandleAlign !== undefined
        ? "flag"
        : envOrDefault("RUNNER_CANDLE_ALIGN"),
    runner_max_backoff_seconds:
      overrides.runnerMaxBackoffSeconds !== undefined
        ? "flag"
        : envOrDefault("RUNNER_MAX_BACKOFF_SECONDS"),
    binance_account_enabled: envOrDefault("BINANCE_ACCOUNT_ENABLED"),
    strict_real_mode: envOrDefault("STRICT_REAL_MODE"),
    obs_persist_enabled: envOrDefault("OBS_PERSIST_ENABLED"),
    obs_sqlite_path: envOrDefault("OBS_SQLITE_PATH"),
    binance_spot_enabled: envOrDefault("BINANCE_SPOT_ENABLED"),
    binance_spot_symbol_whitelist: envOrDefault("BINANCE_SPOT_SYMBOL_WHITELIST"),
    binance_spot_default_tif: envOrDefault("BINANCE_SPOT_DEFAULT_TIF"),
    binance_spot_recv_window: envOrDefault("BINANCE_SPOT_RECV_WINDOW"),
    binance_futures_enabled: envOrDefault("BINANCE_FUTURES_ENABLED"),
    binance_futures_scope_default: envOrDefault("BINANCE_FUTURES_SCOPE_DEFAULT"),
    binance_futures_symbol_whitelist: envOrDefault("BINANCE_FUTURES_SYMBOL_WHITELIST"),
    binance_futures_default_tif: envOrDefault("BINANCE_FUTURES_DEFAULT_TIF"),
    binance_futures_recv_window: envOrDefault("BINANCE_FUTURES_RECV_WINDOW"),
    binance_futures_default_leverage: envOrDefault("BINANCE_FUTURES_DEFAULT_LEVERAGE"),
    binance_futures_margin_mode: envOrDefault("BINANCE_FUTURES_MARGIN_MODE"),
    binance_futures_position_mode: envOrDefault("BINANCE_FUTURES_POSITION_MODE"),
    openrouter_model: envOrDefault("OPENROUTER_MODEL"),
    binance_api_key: envOrDefault("BINANCE_API_KEY"),
    binance_api_secret: envOrDefault("BINANCE_API_SECRET"),
    openrouter_api_key: envOrDefault("OPENROUTER_API_KEY"),
    thenewsapi_key: envOrDefault("THENEWSAPI_KEY")
  };

  return { runtime, view: { effective, source } };
};

const doHealthCheck = async (options: HealthOptions, fallbackPort: number): Promise<CliCommandResult> => {
  const check = options.check ?? "readyz";
  const port = options.port ?? fallbackPort;
  const url = `http://127.0.0.1:${port}/${check}`;

  try {
    const response = await fetch(url);
    const text = await response.text();
    const payload = text ? JSON.parse(text) : { status: "empty" };
    const ok = response.ok && (check === "healthz" || payload.status === "ready");
    return {
      exitCode: ok ? 0 : 1,
      message: ok ? "health check passed" : "health check failed",
      data: payload
    };
  } catch (error) {
    return { exitCode: 1, message: `health check error: ${String(error)}` };
  }
};

const createDashboardServer = (runtime: RuntimeConfig, portOverride?: number): DashboardServerHandle => {
  if (!runtime.obsPersistEnabled) {
    throw new Error("Dashboard requires OBS_PERSIST_ENABLED=true so metrics can be read from SQLite telemetry.");
  }
  const telemetry = new InMemoryTelemetrySink(false);
  const monitor = new HealthMonitor(telemetry, {
    maxP95RunLatencyMs: runtime.sloP95RunLatencyMs,
    maxFallbackRatio: runtime.sloMaxFallbackRatio,
    maxConsecutiveFailures: runtime.sloMaxConsecutiveFailures,
  });
  const sqliteSink = new SqliteTelemetrySink(runtime.obsSqlitePath);
  let runnerState: RunnerState | null = null;
  const port = portOverride ?? runtime.healthServerPort;
  const server = new HealthServer({
    config: { enabled: true, port },
    monitor,
    getRunnerState: () => runnerState,
    getLastRun: () => monitor.getLastRunSample(),
    getMetricsView: (limit = 500) => ({
      metrics: sqliteSink.getMetrics({ limit }),
      summary: sqliteSink.getMetricSummary(Math.max(1, limit)),
      alerts: sqliteSink.getAlerts({ limit: Math.max(50, Math.min(limit, 1000)) }),
    }),
  });
  return { server, port };
};

const doHealthServe = async (runtime: RuntimeConfig, portOverride?: number): Promise<void> => {
  const { server, port } = createDashboardServer(runtime, portOverride);
  await server.start();
  console.log(`Dashboard server running on http://127.0.0.1:${port}/metricsz`);
  console.log("Press Ctrl+C to stop.");

  await new Promise<void>((resolve) => {
    let stopped = false;
    const shutdown = async () => {
      if (stopped) return;
      stopped = true;
      await server.stop();
      resolve();
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  });
};

const doDoctor = (runtime: RuntimeConfig, mode: PipelineMode): CliCommandResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (runtime.strictRealMode && mode !== "backtest" && !runtime.theNewsApiKey) {
    errors.push("THENEWSAPI_KEY missing while STRICT_REAL_MODE=true.");
  }
  if (runtime.strictRealMode && !runtime.openRouterApiKey) {
    errors.push("OPENROUTER_API_KEY missing while STRICT_REAL_MODE=true.");
  }
  if (runtime.binanceAccountEnabled && mode !== "backtest") {
    if (!runtime.binanceApiKey || !runtime.binanceApiSecret) {
      errors.push("BINANCE_API_KEY/BINANCE_API_SECRET required when BINANCE_ACCOUNT_ENABLED=true.");
    }
  }
  if (runtime.binanceSpotEnabled) {
    if (!runtime.binanceApiKey || !runtime.binanceApiSecret) {
      errors.push("BINANCE_API_KEY/BINANCE_API_SECRET required when BINANCE_SPOT_ENABLED=true.");
    }
    if (runtime.binanceSpotSymbolWhitelist.length === 0) {
      errors.push("BINANCE_SPOT_SYMBOL_WHITELIST must contain at least one symbol.");
    }
  }
  if (runtime.binanceFuturesEnabled) {
    if (!runtime.binanceApiKey || !runtime.binanceApiSecret) {
      errors.push("BINANCE_API_KEY/BINANCE_API_SECRET required when BINANCE_FUTURES_ENABLED=true.");
    }
    if (runtime.binanceFuturesSymbolWhitelist.length === 0) {
      errors.push("BINANCE_FUTURES_SYMBOL_WHITELIST must contain at least one symbol.");
    }
  }
  if (runtime.obsPersistEnabled && !runtime.obsSqlitePath) {
    errors.push("OBS_SQLITE_PATH is required when OBS_PERSIST_ENABLED=true.");
  }
  if (!runtime.healthServerEnabled) {
    warnings.push("HEALTH_SERVER_ENABLED=false; /healthz and /readyz are disabled.");
  }

  return {
    exitCode: errors.length > 0 ? 1 : 0,
    message: errors.length > 0 ? "doctor found blocking issues" : "doctor checks passed",
    data: {
      mode,
      errors,
      warnings,
      checks: {
        strict_real_mode: runtime.strictRealMode,
        binance_account_enabled: runtime.binanceAccountEnabled,
        binance_spot_enabled: runtime.binanceSpotEnabled,
        binance_futures_enabled: runtime.binanceFuturesEnabled,
        obs_persist_enabled: runtime.obsPersistEnabled,
        health_server_enabled: runtime.healthServerEnabled
      }
    }
  };
};

const doEnvInit = (options: EnvInitOptions): CliCommandResult => {
  const scope = options.scope === "local" ? "local" : "global";
  const targetPath = options.path
    ? path.resolve(process.cwd(), options.path)
    : scope === "local"
      ? path.resolve(process.cwd(), ".env")
      : path.resolve(os.homedir(), ".vexis", ".env");
  const existedBefore = fs.existsSync(targetPath);

  const parentDir = path.dirname(targetPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  if (fs.existsSync(targetPath) && !options.force) {
    return {
      exitCode: 1,
      message: `env file already exists at ${targetPath}. Use --force to overwrite.`,
      data: {
        target: targetPath,
        scope,
        overwritten: false
      }
    };
  }

  fs.writeFileSync(targetPath, ENV_TEMPLATE, "utf8");

  return {
    exitCode: 0,
    message: `env template written to ${targetPath}`,
      data: {
        target: targetPath,
        scope,
        overwritten: existedBefore
      }
  };
};

const doAccountCheck = async (
  runtime: RuntimeConfig,
  mode: PipelineMode
): Promise<CliCommandResult> => {
  const asset = "SOL/USDT";
  const runId = `account-check-${Date.now()}`;
  const traceId = randomUUID();

  const provider =
    runtime.binanceAccountEnabled && mode !== "backtest"
      ? new BinanceAccountProvider({
          enabled: true,
          failHard: true,
          apiKey: runtime.binanceApiKey,
          apiSecret: runtime.binanceApiSecret,
          accountScope: runtime.binanceAccountScope,
          defaultExposurePct: runtime.binanceDefaultExposurePct,
          defaultDrawdownPct: runtime.binanceDefaultDrawdownPct,
          mode,
          timeoutMs: runtime.nodeTimeoutMs
        })
      : new StaticPortfolioStateProvider({
          equityUsd: 50,
          currentExposurePct: runtime.binanceDefaultExposurePct,
          currentDrawdownPct: runtime.binanceDefaultDrawdownPct,
          liquidityUsd: 1400000
        });

  const portfolio = await provider.getPortfolioState({
    runId,
    traceId,
    mode,
    asset
  });
  const snapshot = provider.getLastSnapshot();

  return {
    exitCode: 0,
    message:
      snapshot !== null
        ? "account check success"
        : "account check success (static portfolio provider)",
    data: {
      mode,
      asset,
      portfolio: { ...portfolio },
      account_snapshot: snapshot ? { ...snapshot } : null
    }
  };
};

const parseSpotType = (value?: string): "market" | "limit" => {
  return value?.toLowerCase() === "limit" ? "limit" : "market";
};

const buildSpotOrderRequest = (
  side: "buy" | "sell",
  options: SpotPlaceOptions,
  defaultTif: SpotTimeInForce
): SpotOrderRequest => ({
  symbol: options.symbol.trim().toUpperCase(),
  side,
  type: parseSpotType(options.type),
  amount: options.amount,
  price: options.price,
  quoteCost: options.quoteCost,
  stopLoss: options.stopLoss,
  takeProfit: options.takeProfit,
  tif: options.tif ?? defaultTif
});

const doSpotBuy = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  options: SpotPlaceOptions
): Promise<CliCommandResult> => {
  const service = getSpotService(runtime, mode);
  const order = await service.placeOrder(
    buildSpotOrderRequest("buy", options, runtime.binanceSpotDefaultTif),
    makeSpotContext(mode)
  );
  return { exitCode: 0, message: "spot buy success", data: asJsonValue(order) };
};

const doSpotSell = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  options: SpotPlaceOptions
): Promise<CliCommandResult> => {
  const service = getSpotService(runtime, mode);
  const order = await service.placeOrder(
    buildSpotOrderRequest("sell", options, runtime.binanceSpotDefaultTif),
    makeSpotContext(mode)
  );
  return { exitCode: 0, message: "spot sell success", data: asJsonValue(order) };
};

const doSpotOrderGet = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  options: SpotOrderGetOptions
): Promise<CliCommandResult> => {
  const service = getSpotService(runtime, mode);
  const order = await service.fetchOrder(options.orderId, options.symbol.trim().toUpperCase(), makeSpotContext(mode));
  return { exitCode: 0, message: "spot order fetched", data: asJsonValue(order) };
};

const doSpotOrdersOpen = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  options: SpotOrdersListOptions
): Promise<CliCommandResult> => {
  const service = getSpotService(runtime, mode);
  const orders = await service.fetchOpenOrders(
    makeSpotContext(mode),
    options.symbol?.trim().toUpperCase(),
    options.limit
  );
  return { exitCode: 0, message: "spot open orders fetched", data: asJsonValue(orders) };
};

const doSpotOrdersClosed = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  options: SpotOrdersListOptions
): Promise<CliCommandResult> => {
  const service = getSpotService(runtime, mode);
  const orders = await service.fetchClosedOrders(
    makeSpotContext(mode),
    options.symbol?.trim().toUpperCase(),
    options.limit
  );
  return { exitCode: 0, message: "spot closed orders fetched", data: asJsonValue(orders) };
};

const doSpotOrderCancel = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  options: SpotOrderCancelOptions
): Promise<CliCommandResult> => {
  const service = getSpotService(runtime, mode);
  const order = await service.cancelOrder(
    options.orderId,
    options.symbol.trim().toUpperCase(),
    makeSpotContext(mode)
  );
  return { exitCode: 0, message: "spot order canceled", data: asJsonValue(order) };
};

const doSpotOrderCancelAll = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  symbol?: string
): Promise<CliCommandResult> => {
  const service = getSpotService(runtime, mode);
  const orders = await service.cancelAllOrders(makeSpotContext(mode), symbol?.trim().toUpperCase());
  return { exitCode: 0, message: "spot cancel-all completed", data: asJsonValue(orders) };
};

const doSpotBalance = async (runtime: RuntimeConfig, mode: PipelineMode): Promise<CliCommandResult> => {
  const service = getSpotService(runtime, mode);
  const snapshot = await service.fetchBalanceSnapshot(makeSpotContext(mode));
  return { exitCode: 0, message: "spot balance fetched", data: asJsonValue(snapshot) };
};

const doSpotTrades = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  options: SpotTradesOptions
): Promise<CliCommandResult> => {
  const service = getSpotService(runtime, mode);
  const trades = await service.fetchMyTrades(
    options.symbol.trim().toUpperCase(),
    makeSpotContext(mode),
    options.limit
  );
  return { exitCode: 0, message: "spot trades fetched", data: asJsonValue(trades) };
};

const doSpotQuote = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  options: SpotQuoteOptions
): Promise<CliCommandResult> => {
  const service = getSpotService(runtime, mode);
  const quote = await service.fetchQuote(
    options.symbol.trim().toUpperCase(),
    makeSpotContext(mode),
    options.depth
  );
  return { exitCode: 0, message: "spot quote fetched", data: asJsonValue(quote) };
};

const doSpotProtect = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  options: SpotProtectOptions
): Promise<CliCommandResult> => {
  const service = getSpotService(runtime, mode);
  const summary = await service.armProtectionManual(
    {
      symbol: options.symbol.trim().toUpperCase(),
      side: "buy",
      amount: Number(options.amount),
      stopLoss: options.stopLoss,
      takeProfit: options.takeProfit,
    },
    makeSpotContext(mode)
  );
  return { exitCode: 0, message: "spot protection armed", data: asJsonValue(summary) };
};

const parseFuturesType = (value?: string): "market" | "limit" =>
  value?.toLowerCase() === "limit" ? "limit" : "market";

const doFuturesBuy = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  options: FuturesPlaceOptions
): Promise<CliCommandResult> => {
  const service = getFuturesService(runtime, mode);
  const scope = normalizeFuturesScope(runtime, options.scope);
  const order = await service.placeOrder(
    {
      scope,
      symbol: normalizeFuturesSymbol(options.symbol),
      side: "buy",
      type: parseFuturesType(options.type),
      amount: Number(options.amount ?? 0),
      price: options.price,
      stopLoss: options.stopLoss,
      takeProfit: options.takeProfit,
      tif: options.tif ?? runtime.binanceFuturesDefaultTif,
      reduceOnly: options.reduceOnly
    },
    makeFuturesContext(mode)
  );
  return { exitCode: 0, message: "futures buy success", data: asJsonValue(order) };
};

const doFuturesSell = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  options: FuturesPlaceOptions
): Promise<CliCommandResult> => {
  const service = getFuturesService(runtime, mode);
  const scope = normalizeFuturesScope(runtime, options.scope);
  const order = await service.placeOrder(
    {
      scope,
      symbol: normalizeFuturesSymbol(options.symbol),
      side: "sell",
      type: parseFuturesType(options.type),
      amount: Number(options.amount ?? 0),
      price: options.price,
      stopLoss: options.stopLoss,
      takeProfit: options.takeProfit,
      tif: options.tif ?? runtime.binanceFuturesDefaultTif,
      reduceOnly: options.reduceOnly
    },
    makeFuturesContext(mode)
  );
  return { exitCode: 0, message: "futures sell success", data: asJsonValue(order) };
};

const doFuturesOrderGet = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  options: FuturesOrderGetOptions
): Promise<CliCommandResult> => {
  const service = getFuturesService(runtime, mode);
  const scope = normalizeFuturesScope(runtime, options.scope);
  const order = await service.fetchOrder(
    scope,
    options.orderId,
    normalizeFuturesSymbol(options.symbol),
    makeFuturesContext(mode)
  );
  return { exitCode: 0, message: "futures order fetched", data: asJsonValue(order) };
};

const doFuturesOrdersOpen = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  options: FuturesOrdersListOptions
): Promise<CliCommandResult> => {
  const service = getFuturesService(runtime, mode);
  const scope = normalizeFuturesScope(runtime, options.scope);
  const rows = await service.fetchOpenOrders(
    scope,
    makeFuturesContext(mode),
    options.symbol ? normalizeFuturesSymbol(options.symbol) : undefined,
    options.limit
  );
  return { exitCode: 0, message: "futures open orders fetched", data: asJsonValue(rows) };
};

const doFuturesOrdersClosed = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  options: FuturesOrdersListOptions
): Promise<CliCommandResult> => {
  const service = getFuturesService(runtime, mode);
  const scope = normalizeFuturesScope(runtime, options.scope);
  const rows = await service.fetchClosedOrders(
    scope,
    makeFuturesContext(mode),
    options.symbol ? normalizeFuturesSymbol(options.symbol) : undefined,
    options.limit
  );
  return { exitCode: 0, message: "futures closed orders fetched", data: asJsonValue(rows) };
};

const doFuturesOrderCancel = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  options: FuturesOrderCancelOptions
): Promise<CliCommandResult> => {
  const service = getFuturesService(runtime, mode);
  const scope = normalizeFuturesScope(runtime, options.scope);
  const row = await service.cancelOrder(
    scope,
    options.orderId,
    normalizeFuturesSymbol(options.symbol),
    makeFuturesContext(mode)
  );
  return { exitCode: 0, message: "futures order canceled", data: asJsonValue(row) };
};

const doFuturesOrderCancelAll = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  scope?: FuturesScope,
  symbol?: string
): Promise<CliCommandResult> => {
  const service = getFuturesService(runtime, mode);
  const resolvedScope = normalizeFuturesScope(runtime, scope);
  const rows = await service.cancelAllOrders(
    resolvedScope,
    makeFuturesContext(mode),
    symbol ? normalizeFuturesSymbol(symbol) : undefined
  );
  return { exitCode: 0, message: "futures cancel-all completed", data: asJsonValue(rows) };
};

const doFuturesBalance = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  scope?: FuturesScope
): Promise<CliCommandResult> => {
  const service = getFuturesService(runtime, mode);
  const resolvedScope = normalizeFuturesScope(runtime, scope);
  const snapshot = await service.fetchBalanceSnapshot(resolvedScope, makeFuturesContext(mode));
  return { exitCode: 0, message: "futures balance fetched", data: asJsonValue(snapshot) };
};

const doFuturesPositions = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  options: FuturesPositionsOptions
): Promise<CliCommandResult> => {
  const service = getFuturesService(runtime, mode);
  const scope = normalizeFuturesScope(runtime, options.scope);
  const rows = await service.fetchPositions(
    scope,
    makeFuturesContext(mode),
    options.symbol ? normalizeFuturesSymbol(options.symbol) : undefined
  );
  return { exitCode: 0, message: "futures positions fetched", data: asJsonValue(rows) };
};

const doFuturesTrades = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  options: FuturesTradesOptions
): Promise<CliCommandResult> => {
  const service = getFuturesService(runtime, mode);
  const scope = normalizeFuturesScope(runtime, options.scope);
  const rows = await service.fetchMyTrades(
    scope,
    normalizeFuturesSymbol(options.symbol),
    makeFuturesContext(mode),
    options.limit
  );
  return { exitCode: 0, message: "futures trades fetched", data: asJsonValue(rows) };
};

const doFuturesQuote = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  options: FuturesQuoteOptions
): Promise<CliCommandResult> => {
  const service = getFuturesService(runtime, mode);
  const scope = normalizeFuturesScope(runtime, options.scope);
  const row = await service.fetchQuote(
    scope,
    normalizeFuturesSymbol(options.symbol),
    makeFuturesContext(mode),
    options.depth
  );
  return { exitCode: 0, message: "futures quote fetched", data: asJsonValue(row) };
};

const doFuturesProtect = async (
  runtime: RuntimeConfig,
  mode: PipelineMode,
  options: FuturesProtectOptions
): Promise<CliCommandResult> => {
  const service = getFuturesService(runtime, mode);
  const scope = normalizeFuturesScope(runtime, options.scope);
  if (!(options.side === "buy" || options.side === "sell")) {
    return {
      exitCode: 1,
      message: `invalid futures side '${String(options.side)}'; expected 'buy' or 'sell'`,
    };
  }
  const side: "buy" | "sell" = options.side;
  const summary = await service.armProtectionManual(
    {
      scope,
      symbol: normalizeFuturesSymbol(options.symbol),
      side,
      amount: Number(options.amount),
      stopLoss: options.stopLoss,
      takeProfit: options.takeProfit,
    },
    makeFuturesContext(mode)
  );
  return { exitCode: 0, message: "futures protection armed", data: asJsonValue(summary) };
};

const printResult = (result: CliCommandResult, asJson: boolean): void => {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.message ?? "done");
    if (result.data) {
      console.log(JSON.stringify(result.data, null, 2));
    }
  }

};

const toRunOverrides = (
  global: CliGlobalOptions,
  options: CommonRunOptions,
  extra?: Partial<AppRunOverrides>
): AppRunOverrides => ({
  mode: global.mode,
  outputFormat: global.output ?? (global.json ? "json" : undefined),
  envFile: global.envFile,
  showTelemetry: options.showTelemetry,
  query: {
    asset: options.asset,
    timeframe: options.timeframe,
    limit: options.limit
  },
  ...extra
});

const tailOptionsToArgv = (options: TailOptions): string[] => {
  const argv: string[] = [];
  if (options.runId) argv.push("--run-id", options.runId);
  if (options.traceId) argv.push("--trace-id", options.traceId);
  if (options.since) argv.push("--since", options.since);
  if (options.severity) argv.push("--severity", options.severity);
  if (typeof options.limit === "number") argv.push("--limit", String(options.limit));
  if (options.json) argv.push("--json");
  return argv;
};

const promptInt = async (message: string, fallback: number): Promise<number> => {
  while (true) {
    const raw = await input({ message, default: String(fallback) });
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    console.log("Input must be a positive integer.");
  }
};

const promptFloat = async (message: string, fallback?: number): Promise<number | undefined> => {
  while (true) {
    const raw = await input({ message, default: fallback !== undefined ? String(fallback) : "" });
    if (raw.trim() === "") return undefined;
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    console.log("Input must be a positive number or empty.");
  }
};

const promptSymbol = async (fallback = "SOL/USDT"): Promise<string> => {
  while (true) {
    const symbol = (await input({ message: "Symbol", default: fallback })).trim().toUpperCase();
    if (symbol.includes("/")) return symbol;
    console.log("Symbol format must be BASE/QUOTE (example: SOL/USDT).");
  }
};

const promptFuturesSymbol = async (fallback = "BTC/USDT:USDT"): Promise<string> => {
  while (true) {
    const symbol = (await input({ message: "Futures symbol", default: fallback })).trim().toUpperCase();
    if (symbol.includes("/") && symbol.includes(":")) return symbol;
    console.log("Futures symbol format must be BASE/QUOTE:SETTLE (example: BTC/USDT:USDT).");
  }
};

const runSpotInteractive = async (
  global: CliGlobalOptions,
  runtime: RuntimeConfig,
  mode: PipelineMode
): Promise<void> => {
  let back = false;
  while (!back) {
    const choice = await select({
      message: "Spot Desk",
      choices: [
        { name: "\u{1F7E2} Buy", value: "buy" },
        { name: "\u{1F534} Sell", value: "sell" },
        { name: "\u{1F50E} Order Get", value: "order-get" },
        { name: "\u{274C} Order Cancel", value: "order-cancel" },
        { name: "\u{1F9F9} Order Cancel All", value: "order-cancel-all" },
        { name: "\u{1F4C2} Orders Open", value: "orders-open" },
        { name: "\u{1F4C1} Orders Closed", value: "orders-closed" },
        { name: "\u{1F4B0} Balance", value: "balance" },
        { name: "\u{1F4DC} Trades", value: "trades" },
        { name: "\u{1F4C8} Quote", value: "quote" },
        { name: "\u{1F6E1}\u{FE0F} Protect Position", value: "protect" },
        { name: "\u{2B05}\u{FE0F} Back", value: "back" }
      ]
    });

    if (choice === "back") {
      back = true;
      continue;
    }

    try {
      if (choice === "buy" || choice === "sell") {
        const symbol = await promptSymbol("BTC/USDT");
        const type = (await select({
          message: "Order type",
          choices: [
            { name: "Market", value: "market" },
            { name: "Limit", value: "limit" }
          ]
        })) as "market" | "limit";
        const amount = await promptFloat("Amount (base)", 0.001);
        let price: number | undefined;
        let quoteCost: number | undefined;
        if (type === "limit") {
          price = await promptFloat("Limit price", 100000);
        } else if (choice === "buy") {
          quoteCost = await promptFloat("Quote cost (optional, USDT)", 50);
        }

        const stopLoss = await promptFloat("Stop-loss price (optional)");
        const takeProfit = await promptFloat("Take-profit price (optional)");
        const options: SpotPlaceOptions = { symbol, type, amount, price, quoteCost, stopLoss, takeProfit };
        const result = await withLoading(
          choice === "buy" ? "Placing spot buy" : "Placing spot sell",
          async () => choice === "buy" ? doSpotBuy(runtime, mode, options) : doSpotSell(runtime, mode, options)
        );
        printResult(result, Boolean(global.json));
        continue;
      }

      if (choice === "order-get") {
        const symbol = await promptSymbol("BTC/USDT");
        const orderId = await input({ message: "Order ID" });
        const result = await withLoading("Fetching spot order", async () =>
          doSpotOrderGet(runtime, mode, { symbol, orderId: orderId.trim() })
        );
        printResult(result, Boolean(global.json));
        continue;
      }

      if (choice === "order-cancel") {
        const symbol = await promptSymbol("BTC/USDT");
        const orderId = await input({ message: "Order ID" });
        const result = await withLoading("Canceling spot order", async () =>
          doSpotOrderCancel(runtime, mode, { symbol, orderId: orderId.trim() })
        );
        printResult(result, Boolean(global.json));
        continue;
      }

      if (choice === "order-cancel-all") {
        const useSymbol = await confirm({ message: "Filter by symbol?", default: false });
        const symbol = useSymbol ? await promptSymbol("BTC/USDT") : undefined;
        const result = await withLoading("Canceling all spot orders", async () =>
          doSpotOrderCancelAll(runtime, mode, symbol)
        );
        printResult(result, Boolean(global.json));
        continue;
      }

      if (choice === "orders-open" || choice === "orders-closed") {
        const useSymbol = await confirm({ message: "Filter by symbol?", default: true });
        const symbol = useSymbol ? await promptSymbol("BTC/USDT") : undefined;
        const limit = await promptInt("Limit", 50);
        const result = await withLoading(
          choice === "orders-open" ? "Fetching open spot orders" : "Fetching closed spot orders",
          async () =>
            choice === "orders-open"
              ? doSpotOrdersOpen(runtime, mode, { symbol, limit })
              : doSpotOrdersClosed(runtime, mode, { symbol, limit })
        );
        printResult(result, Boolean(global.json));
        continue;
      }

      if (choice === "balance") {
        const result = await withLoading("Fetching spot balance", async () => doSpotBalance(runtime, mode));
        printResult(result, Boolean(global.json));
        continue;
      }

      if (choice === "trades") {
        const symbol = await promptSymbol("BTC/USDT");
        const limit = await promptInt("Limit", 50);
        const result = await withLoading("Fetching spot trades", async () =>
          doSpotTrades(runtime, mode, { symbol, limit })
        );
        printResult(result, Boolean(global.json));
        continue;
      }

      if (choice === "quote") {
        const symbol = await promptSymbol("BTC/USDT");
        const depth = await promptInt("Orderbook depth", 5);
        const result = await withLoading("Fetching spot quote", async () =>
          doSpotQuote(runtime, mode, { symbol, depth })
        );
        printResult(result, Boolean(global.json));
        continue;
      }

      if (choice === "protect") {
        const symbol = await promptSymbol("BTC/USDT");
        const amount = await promptFloat("Amount to protect (contracts or base coin)", 0.001);
        const stopLoss = await promptFloat("Stop-loss price (optional)");
        const takeProfit = await promptFloat("Take-profit price (optional)");
        const result = await withLoading("Arming spot protection", async () =>
          doSpotProtect(runtime, mode, {
            symbol,
            amount: Number(amount ?? 0),
            stopLoss,
            takeProfit,
          })
        );
        printResult(result, Boolean(global.json));
      }
    } catch (error) {
      printResult({ exitCode: 1, message: `spot interactive failed: ${String(error)}` }, Boolean(global.json));
    }
  }
};

const promptFuturesScope = async (fallback: FuturesScope): Promise<FuturesScope> =>
  (await select({
    message: "Futures scope",
    choices: [
      { name: "\u{1F4B5} USD-M", value: "usdm" },
      { name: "\u{1FA99} COIN-M", value: "coinm" }
    ],
    default: fallback
  })) as FuturesScope;

const futuresAmountPrompt = (scope: FuturesScope): string =>
  scope === "usdm"
    ? "Order size (quantity; base/contract units, not margin USDT)"
    : "Order size (contracts only)";

const futuresProtectAmountPrompt = (scope: FuturesScope): string =>
  scope === "usdm"
    ? "Amount to protect (quantity in base/contract units)"
    : "Amount to protect (contracts only)";

const runFuturesInteractive = async (
  global: CliGlobalOptions,
  runtime: RuntimeConfig,
  mode: PipelineMode
): Promise<void> => {
  let back = false;
  while (!back) {
    const choice = await select({
      message: "Futures Desk",
      choices: [
        { name: "\u{1F7E2} Buy", value: "buy" },
        { name: "\u{1F534} Sell", value: "sell" },
        { name: "\u{1F50E} Order Get", value: "order-get" },
        { name: "\u{274C} Order Cancel", value: "order-cancel" },
        { name: "\u{1F9F9} Order Cancel All", value: "order-cancel-all" },
        { name: "\u{1F4C2} Orders Open", value: "orders-open" },
        { name: "\u{1F4C1} Orders Closed", value: "orders-closed" },
        { name: "\u{1F4B0} Balance", value: "balance" },
        { name: "\u{1F4CC} Positions", value: "positions" },
        { name: "\u{1F4DC} Trades", value: "trades" },
        { name: "\u{1F4C8} Quote", value: "quote" },
        { name: "\u{1F6E1}\u{FE0F} Protect Position", value: "protect" },
        { name: "\u{2B05}\u{FE0F} Back", value: "back" }
      ]
    });

    if (choice === "back") {
      back = true;
      continue;
    }

    try {
      const scope = await promptFuturesScope(runtime.binanceFuturesScopeDefault);

      if (choice === "buy" || choice === "sell") {
        const symbol = await promptFuturesSymbol("BTC/USDT:USDT");
        const type = (await select({
          message: "Order type",
          choices: [
            { name: "Market", value: "market" },
            { name: "Limit", value: "limit" }
          ]
        })) as "market" | "limit";
        const amount = await promptFloat(futuresAmountPrompt(scope), scope === "coinm" ? 1 : 0.001);
        const price = type === "limit" ? await promptFloat("Limit price", 100000) : undefined;
        const stopLoss = await promptFloat("Stop-loss price (optional)");
        const takeProfit = await promptFloat("Take-profit price (optional)");
        const reduceOnly = await confirm({ message: "Reduce-only?", default: false });
        const options: FuturesPlaceOptions = { scope, symbol, type, amount, price, stopLoss, takeProfit, reduceOnly };
        const result = await withLoading(
          choice === "buy" ? "Placing futures buy" : "Placing futures sell",
          async () => choice === "buy" ? doFuturesBuy(runtime, mode, options) : doFuturesSell(runtime, mode, options)
        );
        printResult(result, Boolean(global.json));
        continue;
      }

      if (choice === "order-get") {
        const symbol = await promptFuturesSymbol("BTC/USDT:USDT");
        const orderId = await input({ message: "Order ID" });
        const result = await withLoading("Fetching futures order", async () =>
          doFuturesOrderGet(runtime, mode, { scope, symbol, orderId: orderId.trim() })
        );
        printResult(result, Boolean(global.json));
        continue;
      }

      if (choice === "order-cancel") {
        const symbol = await promptFuturesSymbol("BTC/USDT:USDT");
        const orderId = await input({ message: "Order ID" });
        const result = await withLoading("Canceling futures order", async () =>
          doFuturesOrderCancel(runtime, mode, { scope, symbol, orderId: orderId.trim() })
        );
        printResult(result, Boolean(global.json));
        continue;
      }

      if (choice === "order-cancel-all") {
        const useSymbol = await confirm({ message: "Filter by symbol?", default: false });
        const symbol = useSymbol ? await promptFuturesSymbol("BTC/USDT:USDT") : undefined;
        const result = await withLoading("Canceling all futures orders", async () =>
          doFuturesOrderCancelAll(runtime, mode, scope, symbol)
        );
        printResult(result, Boolean(global.json));
        continue;
      }

      if (choice === "orders-open" || choice === "orders-closed") {
        const useSymbol = await confirm({ message: "Filter by symbol?", default: true });
        const symbol = useSymbol ? await promptFuturesSymbol("BTC/USDT:USDT") : undefined;
        const limit = await promptInt("Limit", 50);
        const result = await withLoading(
          choice === "orders-open" ? "Fetching open futures orders" : "Fetching closed futures orders",
          async () =>
            choice === "orders-open"
              ? doFuturesOrdersOpen(runtime, mode, { scope, symbol, limit })
              : doFuturesOrdersClosed(runtime, mode, { scope, symbol, limit })
        );
        printResult(result, Boolean(global.json));
        continue;
      }

      if (choice === "balance") {
        const result = await withLoading("Fetching futures balance", async () =>
          doFuturesBalance(runtime, mode, scope)
        );
        printResult(result, Boolean(global.json));
        continue;
      }

      if (choice === "positions") {
        const useSymbol = await confirm({ message: "Filter by symbol?", default: false });
        const symbol = useSymbol ? await promptFuturesSymbol("BTC/USDT:USDT") : undefined;
        const result = await withLoading("Fetching futures positions", async () =>
          doFuturesPositions(runtime, mode, { scope, symbol })
        );
        printResult(result, Boolean(global.json));
        continue;
      }

      if (choice === "trades") {
        const symbol = await promptFuturesSymbol("BTC/USDT:USDT");
        const limit = await promptInt("Limit", 50);
        const result = await withLoading("Fetching futures trades", async () =>
          doFuturesTrades(runtime, mode, { scope, symbol, limit })
        );
        printResult(result, Boolean(global.json));
        continue;
      }

      if (choice === "quote") {
        const symbol = await promptFuturesSymbol("BTC/USDT:USDT");
        const depth = await promptInt("Orderbook depth", 5);
        const result = await withLoading("Fetching futures quote", async () =>
          doFuturesQuote(runtime, mode, { scope, symbol, depth })
        );
        printResult(result, Boolean(global.json));
        continue;
      }

      if (choice === "protect") {
        const symbol = await promptFuturesSymbol("BTC/USDT:USDT");
        const side = (await select({
          message: "Parent side (existing position direction)",
          choices: [
            { name: "\u{1F7E2} Buy/Long", value: "buy" },
            { name: "\u{1F534} Sell/Short", value: "sell" }
          ]
        })) as "buy" | "sell";
        const amount = await promptFloat(futuresProtectAmountPrompt(scope), scope === "coinm" ? 1 : 0.001);
        const stopLoss = await promptFloat("Stop-loss price (optional)");
        const takeProfit = await promptFloat("Take-profit price (optional)");
        const result = await withLoading("Arming futures protection", async () =>
          doFuturesProtect(runtime, mode, {
            scope,
            symbol,
            side,
            amount: Number(amount ?? 0),
            stopLoss,
            takeProfit,
          })
        );
        printResult(result, Boolean(global.json));
      }
    } catch (error) {
      printResult({ exitCode: 1, message: `futures interactive failed: ${String(error)}` }, Boolean(global.json));
    }
  }
};

const runInteractive = async (command: Command): Promise<void> => {
  const global = normalizeGlobalOptions(command);
  console.log("Vexis Interactive Console");

  let exitRequested = false;
  let dashboardHandle: DashboardServerHandle | null = null;
  while (!exitRequested) {
    const choice = await select({
      message: "Main menu",
      choices: [
        { name: "\u{1F501} Trading Cycle", value: "trading" },
        { name: "\u{1F4B9} Spot Desk", value: "spot" },
        { name: "\u{1F4CA} Futures Desk", value: "futures" },
        { name: "\u{1FA7A} Ops & Health", value: "ops" },
        { name: "\u{2699}\u{FE0F} Admin", value: "admin" },
        { name: "\u{1F6AA} Exit", value: "exit" }
      ]
    });

    if (choice === "exit") {
      exitRequested = true;
      continue;
    }

    if (choice === "trading") {
      const action = await select({
        message: "Trading actions",
        choices: [
          { name: "\u{25B6}\u{FE0F} Run one cycle", value: "run" },
          { name: "\u{23F1}\u{FE0F} Start runner", value: "runner" },
          { name: "\u{2B05}\u{FE0F} Back", value: "back" }
        ]
      });
      if (action === "back") continue;

      if (action === "run") {
        const asset = await promptSymbol("SOL/USDT");
        const timeframe = await input({ message: "Timeframe", default: "1h" });
        const limit = await promptInt("Candle limit", 50);
        const showTelemetry = await confirm({ message: "Show telemetry?", default: false });
        await withLoading("Running cycle", async () =>
          runApp(toRunOverrides(global, { asset, timeframe, limit, showTelemetry }))
        );
        continue;
      }

      const asset = await promptSymbol("SOL/USDT");
      const timeframe = await input({ message: "Timeframe", default: "1h" });
      const limit = await promptInt("Candle limit", 50);
      const interval = await promptInt("Interval seconds", 60);
      const candleAlign = await confirm({ message: "Candle align?", default: true });
      const maxBackoff = await promptInt("Max backoff seconds", 900);
      await runApp(
        toRunOverrides(global, { asset, timeframe, limit }, {
          runnerEnabled: true,
          runnerIntervalSeconds: interval,
          runnerCandleAlign: candleAlign,
          runnerMaxBackoffSeconds: maxBackoff,
        }),
      );
      continue;
    }

    if (choice === "spot") {
      try {
        const { runtime, view } = resolveRuntimeConfig(global, {});
        const mode = (view.effective.mode as PipelineMode) ?? "paper";
        await runSpotInteractive(global, runtime, mode);
      } catch (error) {
        printResult({ exitCode: 1, message: `spot setup failed: ${String(error)}` }, Boolean(global.json));
      }
      continue;
    }

    if (choice === "futures") {
      try {
        const { runtime, view } = resolveRuntimeConfig(global, {});
        const mode = (view.effective.mode as PipelineMode) ?? "paper";
        await runFuturesInteractive(global, runtime, mode);
      } catch (error) {
        printResult({ exitCode: 1, message: `futures setup failed: ${String(error)}` }, Boolean(global.json));
      }
      continue;
    }

    if (choice === "ops") {
      let opsBack = false;
      while (!opsBack) {
        const opsAction = await select({
          message: "Ops & Health",
          choices: [
            { name: "\u{1F9FE} Ops tail", value: "ops-tail" },
            { name: "\u{1FA7A} Health check", value: "health" },
            dashboardHandle
              ? { name: `\u{1F6D1} Stop dashboard server (port ${dashboardHandle.port})`, value: "health-serve-stop" }
              : { name: "\u{1F4CA} Start dashboard server", value: "health-serve-start" },
            { name: "\u{1F45B} Account check", value: "account-check" },
            { name: "\u{2B05}\u{FE0F} Back", value: "back" }
          ]
        });
        if (opsAction === "back") {
          opsBack = true;
          continue;
        }

        if (opsAction === "ops-tail") {
          const runId = await input({ message: "Run ID (optional)", default: "" });
          const severity = await select({
            message: "Severity filter",
            choices: [
              { name: "None", value: "" },
              { name: "info", value: "info" },
              { name: "warning", value: "warning" },
              { name: "critical", value: "critical" }
            ]
          });
          const asJson = await confirm({ message: "Output JSON?", default: false });
          await withLoading("Fetching ops tail", async () =>
            runOpsTail(
              tailOptionsToArgv({
                runId: runId || undefined,
                severity: (severity || undefined) as TailOptions["severity"],
                json: asJson,
              }),
            ),
          );
          continue;
        }

        if (opsAction === "health") {
          const check = (await select({
            message: "Endpoint",
            choices: [
              { name: "readyz", value: "readyz" },
              { name: "healthz", value: "healthz" }
            ]
          })) as "healthz" | "readyz";
          const { runtime } = resolveRuntimeConfig(global, {});
          const port = await promptInt("Port", runtime.healthServerPort);
          const result = await withLoading("Checking health", async () => doHealthCheck({ check, port }, runtime.healthServerPort));
          printResult(result, Boolean(global.json));
          continue;
        }

        if (opsAction === "health-serve-start") {
          try {
            const { runtime } = resolveRuntimeConfig(global, {});
            const port = await promptInt("Dashboard port", runtime.healthServerPort);
            const handle = createDashboardServer(runtime, port);
            await withLoading("Starting dashboard server", async () => handle.server.start());
            dashboardHandle = handle;
            console.log(`Dashboard server running on http://127.0.0.1:${handle.port}/metricsz`);
          } catch (error) {
            printResult({ exitCode: 1, message: `start dashboard failed: ${String(error)}` }, Boolean(global.json));
          }
          continue;
        }

        if (opsAction === "health-serve-stop") {
          if (!dashboardHandle) {
            printResult({ exitCode: 1, message: "dashboard server is not running" }, Boolean(global.json));
            continue;
          }
          const active = dashboardHandle;
          try {
            await withLoading("Stopping dashboard server", async () => active.server.stop());
            dashboardHandle = null;
            console.log(`Dashboard server stopped on port ${active.port}.`);
          } catch (error) {
            printResult({ exitCode: 1, message: `stop dashboard failed: ${String(error)}` }, Boolean(global.json));
          }
          continue;
        }

        try {
          const { runtime, view } = resolveRuntimeConfig(global, {});
          const mode = (view.effective.mode as PipelineMode) ?? "backtest";
          const result = await withLoading("Checking account", async () => doAccountCheck(runtime, mode));
          printResult(result, Boolean(global.json));
        } catch (error) {
          printResult({ exitCode: 1, message: `account check failed: ${String(error)}` }, Boolean(global.json));
        }
      }
      continue;
    }

    if (choice === "admin") {
      const adminAction = await select({
        message: "Admin",
        choices: [
          { name: "\u{1F9EA} Doctor", value: "doctor" },
          { name: "\u{1F9ED} Env check", value: "env-check" },
          { name: "\u{2705} Validate", value: "validate" },
          { name: "\u{2B05}\u{FE0F} Back", value: "back" }
        ]
      });
      if (adminAction === "back") continue;

      if (adminAction === "validate") {
        await withLoading("Running validation", async () => runDeterministicChecks());
        continue;
      }

      if (adminAction === "env-check") {
        try {
          const { view } = resolveRuntimeConfig(global, {});
          const result = await withLoading("Resolving config", async () =>
            Promise.resolve({
              exitCode: 0,
              message: "effective config",
              data: view as unknown as JSONValue,
            } as CliCommandResult),
          );
          printResult(result, true);
        } catch (error) {
          printResult({ exitCode: 1, message: `env check failed: ${String(error)}` }, true);
        }
        continue;
      }

      try {
        const { runtime, view } = resolveRuntimeConfig(global, {});
        const mode = (view.effective.mode as PipelineMode) ?? "backtest";
        const result = await withLoading("Running doctor", async () =>
          Promise.resolve(doDoctor(runtime, mode)),
        );
        printResult(result, Boolean(global.json));
      } catch (error) {
        printResult({ exitCode: 1, message: `doctor failed: ${String(error)}` }, Boolean(global.json));
      }
    }
  }

  if (dashboardHandle) {
    try {
      await dashboardHandle.server.stop();
    } catch {
      // best effort shutdown on interactive exit
    }
  }
};

const program = new Command();

program
  .name("vexis")
  .description("Vexis trading desk CLI")
  .option("--json", "JSON output")
  .option("--output <format>", "Output format: pretty|json")
  .option("--mode <mode>", "Pipeline mode: backtest|paper|live-sim")
  .option("--env-file <path>", "Custom env file path (lower precedence than OS env)")
  .showHelpAfterError();

program.action(async (_: unknown, command: Command) => {
  await runInteractive(command);
});

program
  .command("run")
  .description("Run one trading cycle")
  .option("--asset <asset>", "Asset symbol", "SOL/USDT")
  .option("--timeframe <timeframe>", "Timeframe", "1h")
  .option("--limit <limit>", "Candle limit", (v) => Number.parseInt(v, 10), 50)
  .option("--show-telemetry", "Show telemetry")
  .action(async (options: CommonRunOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    await withLoading("Running cycle", async () =>
      runApp(toRunOverrides(global, options)),
    );
  });

program
  .command("runner")
  .description("Start continuous runner")
  .option("--asset <asset>", "Asset symbol", "SOL/USDT")
  .option("--timeframe <timeframe>", "Timeframe", "1h")
  .option("--limit <limit>", "Candle limit", (v) => Number.parseInt(v, 10), 50)
  .option("--interval <seconds>", "Runner interval seconds", (v) => Number.parseInt(v, 10))
  .option("--candle-align <bool>", "Candle align true/false", (v) => ["1", "true", "yes", "on"].includes(v.toLowerCase()))
  .option("--max-backoff <seconds>", "Max backoff seconds", (v) => Number.parseInt(v, 10))
  .option("--show-telemetry", "Show telemetry")
  .action(async (options: RunnerOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    await runApp(
      toRunOverrides(global, options, {
        runnerEnabled: true,
        runnerIntervalSeconds: options.interval,
        runnerCandleAlign: options.candleAlign,
        runnerMaxBackoffSeconds: options.maxBackoff,
      }),
    );
  });

program
  .command("health")
  .description("Check health server or run standalone dashboard server")
  .option("--check <endpoint>", "healthz|readyz", "readyz")
  .option("--port <port>", "Health port", (v) => Number.parseInt(v, 10))
  .option("--serve", "Run standalone dashboard server for /metricsz")
  .action(async (options: HealthOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    const { runtime } = resolveRuntimeConfig(global, {});
    if (options.serve) {
      await doHealthServe(runtime, options.port);
      return;
    }
    const result = await withLoading("Checking health", async () =>
      doHealthCheck(options, runtime.healthServerPort),
    );
    printResult(result, Boolean(global.json || global.output === "json"));
    process.exitCode = result.exitCode;
  });

program
  .command("validate")
  .description("Run deterministic validation")
  .action(async () => {
    await withLoading("Running validation", async () =>
      runDeterministicChecks(),
    );
  });

program
  .command("doctor")
  .description("Validate runtime readiness")
  .action(async (_: unknown, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "backtest";
      const result = await withLoading("Running doctor", async () =>
        Promise.resolve(doDoctor(runtime, mode)),
      );
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      process.exitCode = 1;
      printResult(
        { exitCode: 1, message: `doctor failed during config load: ${String(error)}` },
        Boolean(global.json || global.output === "json")
      );
    }
  });

const envCommand = program.command("env").description("Environment commands");
envCommand
  .command("check")
  .description("Print effective runtime config (sanitized)")
  .action(async (_: unknown, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { view } = resolveRuntimeConfig(global, {});
      const result = await withLoading("Resolving config", async () =>
        Promise.resolve({
          exitCode: 0,
          message: "effective config",
          data: view as unknown as JSONValue,
        } as CliCommandResult),
      );
      printResult(result, true);
    } catch (error) {
      process.exitCode = 1;
      printResult({ exitCode: 1, message: `env check failed: ${String(error)}` }, true);
    }
  });

envCommand
  .command("init")
  .description("Create an env template for local or global runtime")
  .option("--scope <scope>", "global|local", "global")
  .option("--path <path>", "Write env template to custom path")
  .option("--force", "Overwrite existing env file")
  .action(async (options: EnvInitOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    const result = await withLoading("Creating env template", async () =>
      Promise.resolve(doEnvInit(options)),
    );
    printResult(result, Boolean(global.json || global.output === "json"));
    process.exitCode = result.exitCode;
  });

const opsCommand = program.command("ops").description("Operational commands");
opsCommand
  .command("tail")
  .description("Tail observability data")
  .option("--run-id <runId>")
  .option("--trace-id <traceId>")
  .option("--since <since>")
  .option("--severity <severity>")
  .option("--limit <limit>", "Limit", (v) => Number.parseInt(v, 10))
  .option("--json", "Output JSON")
  .action(async (options: TailOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    const { runtime } = resolveRuntimeConfig(global, {});
    await withLoading("Fetching ops tail", async () =>
      runOpsTail(tailOptionsToArgv(options), runtime),
    );
  });

const accountCommand = program.command("account").description("Account commands");
accountCommand
  .command("check")
  .description("Check current portfolio/account snapshot")
  .action(async (_: unknown, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "backtest";
      const result = await withLoading("Checking account", async () =>
        doAccountCheck(runtime, mode),
      );
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      const result: CliCommandResult = {
        exitCode: 1,
        message: `account check failed: ${String(error)}`
      };
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

const spotCommand = program.command("spot").description("Binance spot actions");
spotCommand
  .command("buy")
  .description("Place spot buy order")
  .requiredOption("--symbol <symbol>", "Spot symbol, e.g. BTC/USDT")
  .option("--type <type>", "market|limit", "market")
  .option("--amount <amount>", "Base amount", (v) => Number.parseFloat(v))
  .option("--price <price>", "Limit price", (v) => Number.parseFloat(v))
  .option("--quote-cost <cost>", "Quote notional for market buy", (v) => Number.parseFloat(v))
  .option("--stop-loss <price>", "Stop-loss trigger price", (v) => Number.parseFloat(v))
  .option("--take-profit <price>", "Take-profit trigger price", (v) => Number.parseFloat(v))
  .option("--tif <tif>", "GTC|IOC|FOK")
  .action(async (options: SpotPlaceOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Placing spot buy", async () => doSpotBuy(runtime, mode, options));
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `spot buy failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

spotCommand
  .command("sell")
  .description("Place spot sell order")
  .requiredOption("--symbol <symbol>", "Spot symbol, e.g. BTC/USDT")
  .option("--type <type>", "market|limit", "market")
  .option("--amount <amount>", "Base amount", (v) => Number.parseFloat(v))
  .option("--price <price>", "Limit price", (v) => Number.parseFloat(v))
  .option("--stop-loss <price>", "Stop-loss trigger price", (v) => Number.parseFloat(v))
  .option("--take-profit <price>", "Take-profit trigger price", (v) => Number.parseFloat(v))
  .option("--tif <tif>", "GTC|IOC|FOK")
  .action(async (options: SpotPlaceOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Placing spot sell", async () => doSpotSell(runtime, mode, options));
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `spot sell failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

const spotOrderCommand = spotCommand.command("order").description("Spot order operations");
spotOrderCommand
  .command("get")
  .description("Get order by id")
  .requiredOption("--symbol <symbol>", "Spot symbol")
  .requiredOption("--order-id <orderId>", "Exchange order id")
  .action(async (options: SpotOrderGetOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Fetching spot order", async () => doSpotOrderGet(runtime, mode, options));
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `spot order get failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

spotOrderCommand
  .command("cancel")
  .description("Cancel order by id")
  .requiredOption("--symbol <symbol>", "Spot symbol")
  .requiredOption("--order-id <orderId>", "Exchange order id")
  .action(async (options: SpotOrderCancelOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Canceling spot order", async () => doSpotOrderCancel(runtime, mode, options));
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `spot order cancel failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

spotOrderCommand
  .command("cancel-all")
  .description("Cancel all orders for symbol or all symbols")
  .option("--symbol <symbol>", "Spot symbol")
  .action(async (options: { symbol?: string }, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Canceling all spot orders", async () =>
        doSpotOrderCancelAll(runtime, mode, options.symbol)
      );
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `spot cancel-all failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

const spotOrdersCommand = spotCommand.command("orders").description("Spot order lists");
spotOrdersCommand
  .command("open")
  .description("Fetch open orders")
  .option("--symbol <symbol>", "Spot symbol")
  .option("--limit <limit>", "Limit", (v) => Number.parseInt(v, 10), 50)
  .action(async (options: SpotOrdersListOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Fetching open spot orders", async () => doSpotOrdersOpen(runtime, mode, options));
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `spot open orders failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

spotOrdersCommand
  .command("closed")
  .description("Fetch closed orders")
  .option("--symbol <symbol>", "Spot symbol")
  .option("--limit <limit>", "Limit", (v) => Number.parseInt(v, 10), 50)
  .action(async (options: SpotOrdersListOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Fetching closed spot orders", async () => doSpotOrdersClosed(runtime, mode, options));
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `spot closed orders failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

spotCommand
  .command("balance")
  .description("Fetch spot balance snapshot")
  .action(async (_: unknown, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Fetching spot balance", async () => doSpotBalance(runtime, mode));
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `spot balance failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

spotCommand
  .command("trades")
  .description("Fetch my spot trades")
  .requiredOption("--symbol <symbol>", "Spot symbol")
  .option("--limit <limit>", "Limit", (v) => Number.parseInt(v, 10), 50)
  .action(async (options: SpotTradesOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Fetching spot trades", async () => doSpotTrades(runtime, mode, options));
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `spot trades failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

spotCommand
  .command("protect")
  .description("Arm SL/TP for an already-open spot position")
  .requiredOption("--symbol <symbol>", "Spot symbol, e.g. BTC/USDT")
  .requiredOption("--amount <amount>", "Amount to protect", (v) => Number.parseFloat(v))
  .option("--stop-loss <price>", "Stop-loss trigger price", (v) => Number.parseFloat(v))
  .option("--take-profit <price>", "Take-profit trigger price", (v) => Number.parseFloat(v))
  .action(async (options: SpotProtectOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Arming spot protection", async () => doSpotProtect(runtime, mode, options));
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `spot protect failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

spotCommand
  .command("quote")
  .description("Fetch spot quote + orderbook top")
  .requiredOption("--symbol <symbol>", "Spot symbol")
  .option("--depth <depth>", "Orderbook depth", (v) => Number.parseInt(v, 10), 5)
  .action(async (options: SpotQuoteOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Fetching spot quote", async () => doSpotQuote(runtime, mode, options));
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `spot quote failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

const futuresCommand = program.command("futures").description("Binance futures actions (USD-M/COIN-M)");
futuresCommand
  .command("buy")
  .description("Place futures buy order")
  .requiredOption("--symbol <symbol>", "Futures symbol, e.g. BTC/USDT:USDT")
  .option("--scope <scope>", "usdm|coinm")
  .option("--type <type>", "market|limit", "market")
  .option("--amount <amount>", "Order amount", (v) => Number.parseFloat(v))
  .option("--price <price>", "Limit price", (v) => Number.parseFloat(v))
  .option("--stop-loss <price>", "Stop-loss trigger price", (v) => Number.parseFloat(v))
  .option("--take-profit <price>", "Take-profit trigger price", (v) => Number.parseFloat(v))
  .option("--tif <tif>", "GTC|IOC|FOK")
  .option("--reduce-only", "Reduce-only order")
  .action(async (options: FuturesPlaceOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Placing futures buy", async () => doFuturesBuy(runtime, mode, options));
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `futures buy failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

futuresCommand
  .command("sell")
  .description("Place futures sell order")
  .requiredOption("--symbol <symbol>", "Futures symbol, e.g. BTC/USDT:USDT")
  .option("--scope <scope>", "usdm|coinm")
  .option("--type <type>", "market|limit", "market")
  .option("--amount <amount>", "Order amount", (v) => Number.parseFloat(v))
  .option("--price <price>", "Limit price", (v) => Number.parseFloat(v))
  .option("--stop-loss <price>", "Stop-loss trigger price", (v) => Number.parseFloat(v))
  .option("--take-profit <price>", "Take-profit trigger price", (v) => Number.parseFloat(v))
  .option("--tif <tif>", "GTC|IOC|FOK")
  .option("--reduce-only", "Reduce-only order")
  .action(async (options: FuturesPlaceOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Placing futures sell", async () => doFuturesSell(runtime, mode, options));
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `futures sell failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

const futuresOrderCommand = futuresCommand.command("order").description("Futures order operations");
futuresOrderCommand
  .command("get")
  .description("Get futures order by id")
  .requiredOption("--symbol <symbol>", "Futures symbol")
  .requiredOption("--order-id <orderId>", "Exchange order id")
  .option("--scope <scope>", "usdm|coinm")
  .action(async (options: FuturesOrderGetOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Fetching futures order", async () => doFuturesOrderGet(runtime, mode, options));
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `futures order get failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

futuresOrderCommand
  .command("cancel")
  .description("Cancel futures order by id")
  .requiredOption("--symbol <symbol>", "Futures symbol")
  .requiredOption("--order-id <orderId>", "Exchange order id")
  .option("--scope <scope>", "usdm|coinm")
  .action(async (options: FuturesOrderCancelOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Canceling futures order", async () => doFuturesOrderCancel(runtime, mode, options));
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `futures order cancel failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

futuresOrderCommand
  .command("cancel-all")
  .description("Cancel all futures orders for symbol or all symbols")
  .option("--scope <scope>", "usdm|coinm")
  .option("--symbol <symbol>", "Futures symbol")
  .action(async (options: { scope?: FuturesScope; symbol?: string }, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Canceling all futures orders", async () =>
        doFuturesOrderCancelAll(runtime, mode, options.scope, options.symbol)
      );
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `futures cancel-all failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

const futuresOrdersCommand = futuresCommand.command("orders").description("Futures order lists");
futuresOrdersCommand
  .command("open")
  .description("Fetch open futures orders")
  .option("--scope <scope>", "usdm|coinm")
  .option("--symbol <symbol>", "Futures symbol")
  .option("--limit <limit>", "Limit", (v) => Number.parseInt(v, 10), 50)
  .action(async (options: FuturesOrdersListOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Fetching open futures orders", async () => doFuturesOrdersOpen(runtime, mode, options));
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `futures open orders failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

futuresOrdersCommand
  .command("closed")
  .description("Fetch closed futures orders")
  .option("--scope <scope>", "usdm|coinm")
  .option("--symbol <symbol>", "Futures symbol")
  .option("--limit <limit>", "Limit", (v) => Number.parseInt(v, 10), 50)
  .action(async (options: FuturesOrdersListOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Fetching closed futures orders", async () => doFuturesOrdersClosed(runtime, mode, options));
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `futures closed orders failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

futuresCommand
  .command("balance")
  .description("Fetch futures balance snapshot")
  .option("--scope <scope>", "usdm|coinm")
  .action(async (options: { scope?: FuturesScope }, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Fetching futures balance", async () =>
        doFuturesBalance(runtime, mode, options.scope)
      );
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `futures balance failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

futuresCommand
  .command("positions")
  .description("Fetch futures positions")
  .option("--scope <scope>", "usdm|coinm")
  .option("--symbol <symbol>", "Futures symbol")
  .action(async (options: FuturesPositionsOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Fetching futures positions", async () => doFuturesPositions(runtime, mode, options));
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `futures positions failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

futuresCommand
  .command("trades")
  .description("Fetch my futures trades")
  .requiredOption("--symbol <symbol>", "Futures symbol")
  .option("--scope <scope>", "usdm|coinm")
  .option("--limit <limit>", "Limit", (v) => Number.parseInt(v, 10), 50)
  .action(async (options: FuturesTradesOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Fetching futures trades", async () => doFuturesTrades(runtime, mode, options));
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `futures trades failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

futuresCommand
  .command("protect")
  .description("Arm SL/TP for an already-open futures position")
  .requiredOption("--symbol <symbol>", "Futures symbol, e.g. BTC/USDT:USDT")
  .requiredOption("--side <side>", "buy|sell parent side")
  .requiredOption("--amount <amount>", "Amount/contracts to protect", (v) => Number.parseFloat(v))
  .option("--scope <scope>", "usdm|coinm")
  .option("--stop-loss <price>", "Stop-loss trigger price", (v) => Number.parseFloat(v))
  .option("--take-profit <price>", "Take-profit trigger price", (v) => Number.parseFloat(v))
  .action(async (options: FuturesProtectOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Arming futures protection", async () => doFuturesProtect(runtime, mode, options));
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `futures protect failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

futuresCommand
  .command("quote")
  .description("Fetch futures quote + orderbook top")
  .requiredOption("--symbol <symbol>", "Futures symbol")
  .option("--scope <scope>", "usdm|coinm")
  .option("--depth <depth>", "Orderbook depth", (v) => Number.parseInt(v, 10), 5)
  .action(async (options: FuturesQuoteOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    try {
      const { runtime, view } = resolveRuntimeConfig(global, {});
      const mode = (view.effective.mode as PipelineMode) ?? "paper";
      const result = await withLoading("Fetching futures quote", async () => doFuturesQuote(runtime, mode, options));
      printResult(result, Boolean(global.json || global.output === "json"));
      process.exitCode = result.exitCode;
    } catch (error) {
      printResult({ exitCode: 1, message: `futures quote failed: ${String(error)}` }, Boolean(global.json || global.output === "json"));
      process.exitCode = 1;
    }
  });

program
  .command("interactive")
  .alias("i")
  .description("Interactive CLI mode")
  .action(async (_: unknown, command: Command) => {
    await runInteractive(command);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error("CLI execution failed", error);
  process.exitCode = 1;
});

