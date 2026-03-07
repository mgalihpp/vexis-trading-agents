# Vexis CLI Full Command Reference

Use this reference for complete command construction without opening `README.md`.

## Preconditions

- Node.js `>=20`
- Dependencies installed: `npm install`
- Build done: `npm run build`

## Command Prefix

Use either:

- Local repo binary: `node dist/cli.js ...`
- Global package binary: `vexis ...`

This reference uses `node dist/cli.js`.

## Global Options (apply to all commands)

```bash
--json
--output <format>      # pretty|json
--mode <mode>          # backtest|paper|live-sim
--env-file <path>
```

## Top-Level Commands

```bash
run
runner
health
validate
doctor
env
ops
account
spot
futures
interactive (alias: i)
```

## Run

```bash
node dist/cli.js run \
  [--asset <asset>] \
  [--timeframe <timeframe>] \
  [--limit <limit>] \
  [--show-telemetry]
```

Defaults:
- `asset=SOL/USDT`
- `timeframe=1h`
- `limit=50`

### Run result fields to inspect first

For troubleshooting `no_trade` / rejected execution, inspect:

- `result.decisionOrigin`
- `result.finalDecisionByLLM.action`
- `result.executionDecision.execution_blocker`
- `result.executionDecision.reasons`
- `result.executionDecision.risk_budget_usd`
- `result.executionDecision.effective_risk_usd`
- `result.executionDecision.required_margin_usd`
- `result.executionDecision.leverage_used`

## Runner

```bash
node dist/cli.js runner \
  [--asset <asset>] \
  [--timeframe <timeframe>] \
  [--limit <limit>] \
  [--interval <seconds>] \
  [--candle-align <bool>] \
  [--max-backoff <seconds>] \
  [--show-telemetry]
```

## Health

```bash
node dist/cli.js health \
  [--check <endpoint>] \
  [--port <port>] \
  [--serve]
```

Values:
- `--check`: `healthz|readyz` (default `readyz`)
- `--serve`: start standalone dashboard server (`/metricsz`, `/metricsz/data`)

## Validate and Doctor

```bash
node dist/cli.js validate
node dist/cli.js doctor
```

## Env

```bash
node dist/cli.js env check
node dist/cli.js env init [--scope <scope>] [--path <path>] [--force]
```

Values:
- `--scope`: `global|local` (default `global`)

## Ops

```bash
node dist/cli.js ops tail \
  [--run-id <runId>] \
  [--trace-id <traceId>] \
  [--since <iso-time>] \
  [--severity <severity>] \
  [--limit <limit>] \
  [--json]
```

## Account

```bash
node dist/cli.js account check
```

## Spot (live when enabled)

### Spot trading

```bash
node dist/cli.js spot buy \
  --symbol <symbol> \
  [--type <type>] \
  [--amount <amount>] \
  [--price <price>] \
  [--quote-cost <cost>] \
  [--stop-loss <price>] \
  [--take-profit <price>] \
  [--tif <tif>]

node dist/cli.js spot sell \
  --symbol <symbol> \
  [--type <type>] \
  [--amount <amount>] \
  [--price <price>] \
  [--stop-loss <price>] \
  [--take-profit <price>] \
  [--tif <tif>]

node dist/cli.js spot protect \
  --symbol <symbol> \
  --amount <amount> \
  [--stop-loss <price>] \
  [--take-profit <price>]
```

Values:
- `--type`: `market|limit` (default `market`)
- `--tif`: `GTC|IOC|FOK`

### Spot order operations

```bash
node dist/cli.js spot order get --symbol <symbol> --order-id <orderId>
node dist/cli.js spot order cancel --symbol <symbol> --order-id <orderId>
node dist/cli.js spot order cancel-all [--symbol <symbol>]
```

### Spot order lists and snapshots

```bash
node dist/cli.js spot orders open [--symbol <symbol>] [--limit <limit>]
node dist/cli.js spot orders closed [--symbol <symbol>] [--limit <limit>]
node dist/cli.js spot balance
node dist/cli.js spot trades --symbol <symbol> [--limit <limit>]
node dist/cli.js spot quote --symbol <symbol> [--depth <depth>]
```

Defaults:
- `--limit=50`
- `--depth=5`

## Futures (live when enabled)

### Futures trading

```bash
node dist/cli.js futures buy \
  --symbol <symbol> \
  [--scope <scope>] \
  [--type <type>] \
  [--amount <amount>] \
  [--price <price>] \
  [--stop-loss <price>] \
  [--take-profit <price>] \
  [--tif <tif>] \
  [--reduce-only]

node dist/cli.js futures sell \
  --symbol <symbol> \
  [--scope <scope>] \
  [--type <type>] \
  [--amount <amount>] \
  [--price <price>] \
  [--stop-loss <price>] \
  [--take-profit <price>] \
  [--tif <tif>] \
  [--reduce-only]

node dist/cli.js futures protect \
  --symbol <symbol> \
  --side <side> \
  --amount <amount> \
  [--scope <scope>] \
  [--stop-loss <price>] \
  [--take-profit <price>]
```

Values:
- `--scope`: `usdm|coinm`
- `--type`: `market|limit` (default `market`)
- `--tif`: `GTC|IOC|FOK`
- `--side` (protect): `buy|sell`

### Futures order operations

```bash
node dist/cli.js futures order get --symbol <symbol> --order-id <orderId> [--scope <scope>]
node dist/cli.js futures order cancel --symbol <symbol> --order-id <orderId> [--scope <scope>]
node dist/cli.js futures order cancel-all [--scope <scope>] [--symbol <symbol>]
```

### Futures order lists and snapshots

```bash
node dist/cli.js futures orders open [--scope <scope>] [--symbol <symbol>] [--limit <limit>]
node dist/cli.js futures orders closed [--scope <scope>] [--symbol <symbol>] [--limit <limit>]
node dist/cli.js futures balance [--scope <scope>]
node dist/cli.js futures positions [--scope <scope>] [--symbol <symbol>]
node dist/cli.js futures trades --symbol <symbol> [--scope <scope>] [--limit <limit>]
node dist/cli.js futures quote --symbol <symbol> [--scope <scope>] [--depth <depth>]
```

Defaults:
- `--limit=50`
- `--depth=5`

## Interactive

```bash
node dist/cli.js interactive
node dist/cli.js i
```

## Safe-First Example Set

```bash
node dist/cli.js --mode paper --json env check
node dist/cli.js --mode paper --json validate
node dist/cli.js --mode paper --json run --asset SOL/USDT --timeframe 1h --limit 50
node dist/cli.js --mode paper --json health --check readyz
node dist/cli.js health --serve --port 8787
node dist/cli.js --mode paper --json ops tail --limit 100
node dist/cli.js --mode paper --json spot quote --symbol BTC/USDT --depth 5
node dist/cli.js --mode paper --json futures quote --scope usdm --symbol BTC/USDT:USDT --depth 5
```

## Risk/Execution Debug (futures-first)

When user asks "kenapa no trade?" run:

```bash
node dist/cli.js --mode paper --json run --asset SOL/USDT --timeframe 5m --limit 50
```

Then summarize:

1. Final LLM action (`execute_trade` or `no_trade`)
2. Execution blocker
3. Risk budget vs effective risk
4. Required margin vs available liquidity
5. Top reasons from final decision + execution decision

## Troubleshooting Flow

1. Run `node dist/cli.js --json env check`.
2. Run `node dist/cli.js --json doctor`.
3. Run `node dist/cli.js --json health --check readyz`.
4. Run `node dist/cli.js --json ops tail --limit 100`.
5. For observability UI, run `node dist/cli.js health --serve --port 8787` then open `http://127.0.0.1:8787/metricsz`.
