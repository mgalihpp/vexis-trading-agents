# Multi-Agent AI Trading System (TypeScript)

LangGraph-based deterministic pipeline with LLM decision layer:

Market Data -> Analyst Team -> Bullish/Bearish Research -> Debate -> Trader -> Risk -> Portfolio -> Simulated Exchange

## Run

```bash
npm install
npm run build
npm start
```

## Validation

```bash
npm run validate
```

## Runtime Modes

- `PIPELINE_MODE=backtest` (fixture mode)
- `PIPELINE_MODE=paper` (real crypto data + simulated execution)
- `PIPELINE_MODE=live-sim` (real crypto data + simulated execution)
- `OUTPUT_FORMAT=pretty` (default)
- `OUTPUT_FORMAT=json` (machine-readable raw payload)

## OpenRouter / LLM Config

```bash
OPENROUTER_API_KEY=your_key
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=openai/gpt-4o-mini
LLM_MAX_RETRIES=2
```

## Real Data Provider Config (Crypto)

```bash
THENEWSAPI_KEY=your_key
COINGECKO_API_KEY=optional
THENEWSAPI_BASE_URL=https://api.thenewsapi.com/v1/news
ALTERNATIVE_ME_BASE_URL=https://api.alternative.me
COINGECKO_BASE_URL=https://api.coingecko.com/api/v3
PROVIDER_CACHE_TTL_SECONDS=300
STRICT_REAL_MODE=true
```

## Observability + Runner Config

```bash
OBS_PERSIST_ENABLED=true
OBS_SQLITE_PATH=./data/observability.db
OBS_RETENTION_DAYS=30
OBS_CLEANUP_ENABLED=true
SHOW_TELEMETRY=true
TELEMETRY_CONSOLE=false

RUNNER_ENABLED=true
RUNNER_INTERVAL_SECONDS=60
RUNNER_CANDLE_ALIGN=true
RUNNER_MAX_BACKOFF_SECONDS=900

HEALTH_SERVER_ENABLED=true
HEALTH_SERVER_PORT=8787

SIM_FEE_BPS=10
SIM_SLIPPAGE_BPS=5
SIM_PARTIAL_FILL_ENABLED=true
```

- `OBS_PERSIST_ENABLED=true` stores telemetry + decision logs in SQLite.
- `RUNNER_ENABLED=true` runs hybrid continuous mode (interval + candle alignment).
- Backoff policy is automatic on critical failure streak/provider fail-hard.
- Retention cleanup purges records older than `OBS_RETENTION_DAYS` when `OBS_CLEANUP_ENABLED=true`.
- Health endpoints:
  - `GET /healthz` liveness
  - `GET /readyz` provider/LLM health + runner state snapshot

## Ops Tail

```bash
npm run ops:tail
```

Flags:

```bash
npm run ops:tail -- --run-id run-123 --severity critical --limit 50
npm run ops:tail -- --trace-id <trace-id> --since 2026-03-05T00:00:00.000Z --json
```

## Notes

- `paper/live-sim` uses real market + fundamentals + sentiment + news providers.
- `backtest` uses local fixture data.
- Execution remains simulated (no real order placement).
- `STRICT_REAL_MODE=true` is fail-hard: missing key/provider errors stop cycle.
