# Vexis Trading Agents

Multi-agent crypto trading desk in TypeScript using LangGraph + LLM reasoning, real data providers, and simulated execution.

Pipeline:

`Market Data -> Analysts -> Bull/Bear Research -> Debate -> Trader -> Risk -> Portfolio -> Simulated Exchange`

## Features

- LangGraph orchestration with strict typed JSON contracts.
- LLM decision nodes (OpenRouter) with retry + fallback.
- Real crypto inputs (CCXT market, CoinGecko, Alternative.me, TheNewsAPI).
- Binance account snapshot integration (spot + USD-M + COIN-M).
- Binance Spot CCXT action pack (live actions, whitelist guarded).
- Binance Futures CCXT action pack (USD-M + COIN-M, leverage/margin/position pre-setup).
- Observability stack (metrics/logs/alerts, SQLite persistence, health endpoints).
- Continuous runner with interval + candle alignment + backoff.
- Unified CLI (`vexis`) with interactive mode.

## Project Structure

```text
src/
  agents/     # Analyst/research/trader/risk/portfolio agents
  core/       # Pipeline, providers, env, telemetry, runner, spot services
  sim/        # Simulated exchange
  types/      # Shared domain/contracts/json types
  utils/      # Reporting and helpers
```

## Requirements

- Node.js 20+
- npm 10+
- Binance API key/secret for account + spot actions
- Binance API key/secret for account + spot + futures actions
- OpenRouter API key for LLM-driven nodes

## Installation

```bash
npm install
cp .env.example .env
```

Global install:

```bash
npm i -g vexis-trading-agents
vexis env init --scope global
```

## Build & Validate

```bash
npm run build
npm run validate
```

## Quick Start

Single cycle:

```bash
npm start
# or
node dist/cli.js run --mode paper --asset SOL/USDT --timeframe 1h --limit 50
```

Interactive console:

```bash
vexis interactive
```

## CLI Overview

Core commands:

```bash
vexis run
vexis runner
vexis ops tail
vexis health
vexis account check
vexis doctor
vexis env init
vexis env check
vexis validate
```

Spot commands:

```bash
vexis spot buy --symbol BTC/USDT --type market --amount 0.001
vexis spot sell --symbol BTC/USDT --type limit --amount 0.001 --price 90000
vexis spot order get --symbol BTC/USDT --order-id <id>
vexis spot order cancel --symbol BTC/USDT --order-id <id>
vexis spot order cancel-all [--symbol BTC/USDT]
vexis spot orders open [--symbol BTC/USDT --limit 50]
vexis spot orders closed [--symbol BTC/USDT --limit 50]
vexis spot balance
vexis spot trades --symbol BTC/USDT [--limit 50]
vexis spot quote --symbol BTC/USDT [--depth 5]
```

Futures commands:

```bash
vexis futures buy --scope usdm --symbol BTC/USDT:USDT --type market --amount 0.001
vexis futures sell --scope usdm --symbol BTC/USDT:USDT --type limit --amount 0.001 --price 90000
vexis futures order get --scope usdm --symbol BTC/USDT:USDT --order-id <id>
vexis futures order cancel --scope usdm --symbol BTC/USDT:USDT --order-id <id>
vexis futures order cancel-all --scope usdm [--symbol BTC/USDT:USDT]
vexis futures orders open --scope usdm [--symbol BTC/USDT:USDT --limit 50]
vexis futures orders closed --scope usdm [--symbol BTC/USDT:USDT --limit 50]
vexis futures balance --scope usdm
vexis futures positions --scope usdm [--symbol BTC/USDT:USDT]
vexis futures trades --scope usdm --symbol BTC/USDT:USDT [--limit 50]
vexis futures quote --scope usdm --symbol BTC/USDT:USDT [--depth 5]
```

Use `--json` on commands for machine-readable output.

Use custom env file per command:

```bash
vexis --env-file ./secrets/prod.env env check
vexis --env-file ./secrets/prod.env run --mode paper
```

## Interactive UX

`vexis interactive` provides menu-driven workflows:

- `Trading Cycle`: run cycle / start runner
- `Spot Desk`: buy, sell, order ops, balance, trades, quote
- `Futures Desk`: buy, sell, order ops, balance, positions, trades, quote
- `Ops & Health`: ops tail, health check, account check
- `Admin`: doctor, env check, validate

UX behavior:

- loading indicator + elapsed time on each action
- symbol and numeric input validation
- back navigation on each submenu

## Configuration

Env precedence (highest to lowest):

1. CLI flag overrides (for example `--env-file`)
2. OS/session env (`process.env`)
3. File from `--env-file`
4. Global env file `~/.vexis/.env`
5. Local env file `./.env`
6. Internal defaults

Bootstrap env file:

```bash
vexis env init --scope global
vexis env init --scope local
vexis env init --path ./configs/dev.env
```

### Runtime mode

```bash
PIPELINE_MODE=paper          # backtest | paper | live-sim
OUTPUT_FORMAT=pretty         # pretty | json
STRICT_REAL_MODE=true
```

### LLM (OpenRouter)

```bash
OPENROUTER_API_KEY=your_key
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=openai/gpt-4o-mini
LLM_MAX_RETRIES=2
```

### Real data providers

```bash
THENEWSAPI_KEY=your_key
COINGECKO_API_KEY=optional
THENEWSAPI_BASE_URL=https://api.thenewsapi.com/v1/news
ALTERNATIVE_ME_BASE_URL=https://api.alternative.me
COINGECKO_BASE_URL=https://api.coingecko.com/api/v3
PROVIDER_CACHE_TTL_SECONDS=300
```

### Binance account snapshot

```bash
BINANCE_API_KEY=your_key
BINANCE_API_SECRET=your_secret
BINANCE_ACCOUNT_ENABLED=true
BINANCE_ACCOUNT_SCOPE=spot+usdm+coinm
BINANCE_DEFAULT_EXPOSURE_PCT=8
BINANCE_DEFAULT_DRAWDOWN_PCT=3
```

### Binance Spot actions

```bash
BINANCE_SPOT_ENABLED=true
BINANCE_SPOT_SYMBOL_WHITELIST=BTC/USDT,ETH/USDT,SOL/USDT
BINANCE_SPOT_DEFAULT_TIF=GTC
BINANCE_SPOT_RECV_WINDOW=10000
```

Notes:

- Spot actions are live by default when enabled.
- Execution is restricted to symbols in `BINANCE_SPOT_SYMBOL_WHITELIST`.
- Withdraw/transfer are intentionally not included in this version.

### Binance Futures actions

```bash
BINANCE_FUTURES_ENABLED=true
BINANCE_FUTURES_SCOPE_DEFAULT=usdm                # usdm | coinm
BINANCE_FUTURES_SYMBOL_WHITELIST=BTC/USDT:USDT,ETH/USDT:USDT,BTC/USD:BTC
BINANCE_FUTURES_DEFAULT_TIF=GTC                   # GTC | IOC | FOK
BINANCE_FUTURES_RECV_WINDOW=10000
BINANCE_FUTURES_DEFAULT_LEVERAGE=3
BINANCE_FUTURES_MARGIN_MODE=isolated              # isolated | cross
BINANCE_FUTURES_POSITION_MODE=hedge               # hedge | oneway
```

Notes:

- Futures actions are live by default when enabled.
- Scope uses explicit CCXT classes: `binanceusdm` and `binancecoinm`.
- Guard layer enforces whitelist, exchange min limits, and precision before placing orders.

### Observability, health, runner

```bash
OBS_PERSIST_ENABLED=true
OBS_SQLITE_PATH=./data/observability.db
OBS_RETENTION_DAYS=30
OBS_CLEANUP_ENABLED=true
SHOW_TELEMETRY=true

HEALTH_SERVER_ENABLED=true
HEALTH_SERVER_PORT=8787

RUNNER_ENABLED=true
RUNNER_INTERVAL_SECONDS=60
RUNNER_CANDLE_ALIGN=true
RUNNER_MAX_BACKOFF_SECONDS=900
```

## Health & Ops

Health endpoints:

- `GET /healthz` liveness
- `GET /readyz` readiness snapshot (providers/LLM/runner)

Ops tail:

```bash
npm run ops:tail -- --run-id run-123 --severity critical --limit 50
npm run ops:tail -- --trace-id <trace-id> --since 2026-03-05T00:00:00.000Z --json
```

## Safety Notes

- Trading pipeline execution is still simulated (no live order placement from AI pipeline).
- Binance Spot commands are live exchange actions when enabled.
- Binance Futures commands are live exchange actions when enabled.
- Use restricted API keys and symbol whitelist in production.

## Troubleshooting

Troubleshooting is managed via GitHub Issues:

- Report bugs: [Open a Bug Report](https://github.com/mgalihpp/vexis-trading-agents/issues/new?template=bug_report.md)
- Ask questions / ops incidents: [Issues](https://github.com/mgalihpp/vexis-trading-agents/issues)

Please include:

- command used
- mode/symbol/timeframe
- expected vs actual result
- relevant logs (`--json` output if possible)
- sanitized environment details

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow, coding standards, and PR checklist.
