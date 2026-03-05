import { confirm, input, select } from "@inquirer/prompts";
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { BinanceAccountProvider, StaticPortfolioStateProvider } from "./core/account-state";
import { BinanceSpotTradingService } from "./core/spot-trading";
import { InMemoryTelemetrySink, SqliteTelemetrySink } from "./core/telemetry";
import { loadRuntimeConfig, type RuntimeConfig } from "./core/env";
import { runApp, type AppRunOverrides } from "./main";
import { runOpsTail } from "./scripts/ops-tail";
import { runDeterministicChecks } from "./scripts/validate";
import type {
  CliCommandResult,
  CliGlobalOptions,
  EffectiveConfigView,
  JSONValue,
  OutputFormat,
  PipelineMode,
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
  const interval = setInterval(() => {
    const frame = SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length];
    frameIdx += 1;
    process.stderr.write(
      `\r${frame} ${label} (elapsed ${formatElapsed(startedMs)})`,
    );
  }, 120);

  try {
    const result = await action();
    clearInterval(interval);
    process.stderr.write(
      `\r[OK] ${label} completed in ${formatElapsed(startedMs)}\n`,
    );
    return result;
  } catch (error) {
    clearInterval(interval);
    process.stderr.write(
      `\r[FAIL] ${label} failed after ${formatElapsed(startedMs)}\n`,
    );
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
    mode: parseMode(typeof raw.mode === "string" ? raw.mode : undefined)
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

const getSpotService = (runtime: RuntimeConfig, mode: PipelineMode): BinanceSpotTradingService => {
  const telemetrySink = runtime.obsPersistEnabled
    ? new SqliteTelemetrySink(runtime.obsSqlitePath)
    : new InMemoryTelemetrySink(false);
  return BinanceSpotTradingService.getInstance({
    enabled: runtime.binanceSpotEnabled,
    apiKey: runtime.binanceApiKey,
    apiSecret: runtime.binanceApiSecret,
    symbolWhitelist: runtime.binanceSpotSymbolWhitelist,
    defaultTif: runtime.binanceSpotDefaultTif,
    recvWindow: runtime.binanceSpotRecvWindow,
    timeoutMs: runtime.nodeTimeoutMs,
    mode,
    telemetrySink
  });
};

const asJsonValue = (value: unknown): JSONValue => value as JSONValue;

const resolveRuntimeConfig = (
  global: CliGlobalOptions,
  overrides: Partial<AppRunOverrides>
): ResolvedRuntime => {
  const runtime = loadRuntimeConfig();

  const effective: Record<string, JSONValue> = {
    mode: global.mode ?? (process.env.PIPELINE_MODE as PipelineMode | undefined) ?? "backtest",
    output: global.output ?? (process.env.OUTPUT_FORMAT as OutputFormat | undefined) ?? "pretty",
    show_telemetry:
      overrides.showTelemetry ??
      ["1", "true", "yes", "on"].includes((process.env.SHOW_TELEMETRY ?? "false").toLowerCase()),
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
    openrouter_model: runtime.openRouterModel,
    binance_api_key: maskSecret(runtime.binanceApiKey),
    binance_api_secret: maskSecret(runtime.binanceApiSecret),
    openrouter_api_key: maskSecret(runtime.openRouterApiKey),
    thenewsapi_key: maskSecret(runtime.theNewsApiKey)
  };

  const source: Record<string, "flag" | "env" | "default"> = {
    mode: global.mode ? "flag" : process.env.PIPELINE_MODE ? "env" : "default",
    output: global.output ? "flag" : process.env.OUTPUT_FORMAT ? "env" : "default",
    show_telemetry:
      overrides.showTelemetry !== undefined
        ? "flag"
        : process.env.SHOW_TELEMETRY
          ? "env"
          : "default",
    runner_enabled:
      overrides.runnerEnabled !== undefined
        ? "flag"
        : process.env.RUNNER_ENABLED
          ? "env"
          : "default",
    runner_interval_seconds:
      overrides.runnerIntervalSeconds !== undefined
        ? "flag"
        : process.env.RUNNER_INTERVAL_SECONDS
          ? "env"
          : "default",
    runner_candle_align:
      overrides.runnerCandleAlign !== undefined
        ? "flag"
        : process.env.RUNNER_CANDLE_ALIGN
          ? "env"
          : "default",
    runner_max_backoff_seconds:
      overrides.runnerMaxBackoffSeconds !== undefined
        ? "flag"
        : process.env.RUNNER_MAX_BACKOFF_SECONDS
          ? "env"
          : "default",
    binance_account_enabled: process.env.BINANCE_ACCOUNT_ENABLED ? "env" : "default",
    strict_real_mode: process.env.STRICT_REAL_MODE ? "env" : "default",
    obs_persist_enabled: process.env.OBS_PERSIST_ENABLED ? "env" : "default",
    obs_sqlite_path: process.env.OBS_SQLITE_PATH ? "env" : "default",
    binance_spot_enabled: process.env.BINANCE_SPOT_ENABLED ? "env" : "default",
    binance_spot_symbol_whitelist: process.env.BINANCE_SPOT_SYMBOL_WHITELIST ? "env" : "default",
    binance_spot_default_tif: process.env.BINANCE_SPOT_DEFAULT_TIF ? "env" : "default",
    binance_spot_recv_window: process.env.BINANCE_SPOT_RECV_WINDOW ? "env" : "default",
    openrouter_model: process.env.OPENROUTER_MODEL ? "env" : "default",
    binance_api_key: process.env.BINANCE_API_KEY ? "env" : "default",
    binance_api_secret: process.env.BINANCE_API_SECRET ? "env" : "default",
    openrouter_api_key: process.env.OPENROUTER_API_KEY ? "env" : "default",
    thenewsapi_key: process.env.THENEWSAPI_KEY ? "env" : "default"
  };

  return { runtime, view: { effective, source } };
};

const doHealthCheck = async (options: HealthOptions): Promise<CliCommandResult> => {
  const check = options.check ?? "readyz";
  const port = options.port ?? Number.parseInt(process.env.HEALTH_SERVER_PORT ?? "8787", 10);
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
        obs_persist_enabled: runtime.obsPersistEnabled,
        health_server_enabled: runtime.healthServerEnabled
      }
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
  outputFormat: global.output,
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
        { name: "Buy", value: "buy" },
        { name: "Sell", value: "sell" },
        { name: "Order Get", value: "order-get" },
        { name: "Order Cancel", value: "order-cancel" },
        { name: "Order Cancel All", value: "order-cancel-all" },
        { name: "Orders Open", value: "orders-open" },
        { name: "Orders Closed", value: "orders-closed" },
        { name: "Balance", value: "balance" },
        { name: "Trades", value: "trades" },
        { name: "Quote", value: "quote" },
        { name: "Back", value: "back" }
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

        const options: SpotPlaceOptions = { symbol, type, amount, price, quoteCost };
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
      }
    } catch (error) {
      printResult({ exitCode: 1, message: `spot interactive failed: ${String(error)}` }, Boolean(global.json));
    }
  }
};

const runInteractive = async (command: Command): Promise<void> => {
  const global = normalizeGlobalOptions(command);
  console.log("Vexis Interactive Console");

  let exitRequested = false;
  while (!exitRequested) {
    const choice = await select({
      message: "Main menu",
      choices: [
        { name: "Trading Cycle", value: "trading" },
        { name: "Spot Desk", value: "spot" },
        { name: "Ops & Health", value: "ops" },
        { name: "Admin", value: "admin" },
        { name: "Exit", value: "exit" }
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
          { name: "Run one cycle", value: "run" },
          { name: "Start runner", value: "runner" },
          { name: "Back", value: "back" }
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
      await withLoading("Starting runner", async () =>
        runApp(
          toRunOverrides(global, { asset, timeframe, limit }, {
            runnerEnabled: true,
            runnerIntervalSeconds: interval,
            runnerCandleAlign: candleAlign,
            runnerMaxBackoffSeconds: maxBackoff,
          }),
        )
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

    if (choice === "ops") {
      const opsAction = await select({
        message: "Ops & Health",
        choices: [
          { name: "Ops tail", value: "ops-tail" },
          { name: "Health check", value: "health" },
          { name: "Account check", value: "account-check" },
          { name: "Back", value: "back" }
        ]
      });
      if (opsAction === "back") continue;

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
        const port = await promptInt("Port", Number.parseInt(process.env.HEALTH_SERVER_PORT ?? "8787", 10));
        const result = await withLoading("Checking health", async () => doHealthCheck({ check, port }));
        printResult(result, Boolean(global.json));
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
      continue;
    }

    if (choice === "admin") {
      const adminAction = await select({
        message: "Admin",
        choices: [
          { name: "Doctor", value: "doctor" },
          { name: "Env check", value: "env-check" },
          { name: "Validate", value: "validate" },
          { name: "Back", value: "back" }
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
};

const program = new Command();

program
  .name("vexis")
  .description("Vexis trading desk CLI")
  .option("--json", "JSON output")
  .option("--output <format>", "Output format: pretty|json")
  .option("--mode <mode>", "Pipeline mode: backtest|paper|live-sim")
  .showHelpAfterError();

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
    await withLoading("Starting runner", async () =>
      runApp(
        toRunOverrides(global, options, {
          runnerEnabled: true,
          runnerIntervalSeconds: options.interval,
          runnerCandleAlign: options.candleAlign,
          runnerMaxBackoffSeconds: options.maxBackoff,
        }),
      ),
    );
  });

program
  .command("health")
  .description("Check health server")
  .option("--check <endpoint>", "healthz|readyz", "readyz")
  .option("--port <port>", "Health port", (v) => Number.parseInt(v, 10))
  .action(async (options: HealthOptions, command: Command) => {
    const global = normalizeGlobalOptions(command);
    const result = await withLoading("Checking health", async () =>
      doHealthCheck(options),
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
  .action(async (options: TailOptions) => {
    await withLoading("Fetching ops tail", async () =>
      runOpsTail(tailOptionsToArgv(options)),
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

