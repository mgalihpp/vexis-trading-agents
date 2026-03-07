---
name: vexis-cli
description: Operate the Vexis Trading Agents CLI (`vexis`) from an AI agent with safe execution defaults, command construction, JSON output handling, and live-trading guardrails. Use when the user asks to run, validate, monitor, or troubleshoot Vexis commands (`run`, `runner`, `ops`, `health`, `account`, `spot`, `futures`, `env`, `doctor`) in this repository.
---

# Vexis CLI

## Overview

Run Vexis CLI tasks reliably from terminal-first AI agents.  
Prefer safe paper/diagnostic flows first, then escalate to live exchange commands only when the user explicitly asks.

## Workflow

1. Confirm repository and runtime
- Work from the repo root.
- Check Node version (`>=20`) and install dependencies if needed.
- Build before runtime commands that depend on `dist/cli.js`.

2. Run preflight checks
- Run `npm run build`.
- Run `node dist/cli.js env check` (or `vexis env check` if globally installed).
- Run `node dist/cli.js validate` for end-to-end sanity checks.

3. Execute requested operation
- Default command form (local): `node dist/cli.js <command> --json`.
- Prefer `--json` for machine-readable output.
- For environment-specific execution, add `--env-file <path>`.
- For observability UI without runner, use `node dist/cli.js health --serve --port <port>`.
- For pipeline analysis/execution checks, use `run` and inspect `result.executionDecision` + `result.finalDecisionByLLM`.

4. Apply trading safety guardrails
- Default to `run --mode paper` unless user explicitly requests live exchange actions.
- Treat `spot`/`futures` order commands as live actions.
- Before live orders: verify symbol, side, type, amount, and required price/leverage params.
- If using protection, validate `--stop-loss` / `--take-profit` and side-price relation (long/short logic).
- Run-cycle execution is futures-first (long/short valid). Spot/futures provider data may still be used for analysis.

5. Report outcome clearly
- Return command executed, key result fields, and any failure cause.
- If a command fails, run nearest diagnostic (`doctor`, `env check`, `health`) and summarize next fix.
- For no-trade or reject results, include: `decisionOrigin`, `finalDecisionByLLM.action`, `execution_blocker`, `risk_budget_usd`, `effective_risk_usd`, `required_margin_usd`, and top `reasons`.

## Decision Model Notes

- Final authority is LLM tool-call (`final_decision_tool`) in node `FinalDecisionLLM`.
- Advisory outputs (`trader`, `risk`, `portfolio`, `execution`) are non-binding inputs for that final node.
- If mandatory tool-call retries are exhausted, terminal path is `llm_abort`.

## Futures Risk Notes

- Sizing is deterministic by fixed USD risk:
  - `stop_pct = abs(entry - stop_loss) / entry`
  - `notional_by_risk = RISK_MAX_PER_TRADE_USD / stop_pct`
  - `target_notional = max(notional_by_risk, exchange_min_notional)`
  - `effective_risk_usd = target_notional * stop_pct`
- Margin feasibility:
  - `required_margin = target_notional / leverage`
  - blocked when required margin exceeds available liquidity (`margin_insufficient`).
- Common blockers:
  - `margin_insufficient`
  - `risk_tolerance_exceeded`
  - `min_notional_unavailable`
  - `min_notional_not_met`
  - `no_trade` (LLM final decision)
  - `llm_abort`

## Command Patterns

- Single cycle (safe default):
```bash
node dist/cli.js run --mode paper --asset SOL/USDT --timeframe 1h --limit 50 --json
```

- Observability tail:
```bash
node dist/cli.js ops tail --limit 50 --json
```

- Health:
```bash
node dist/cli.js health --json
```

- Dashboard:
```bash
node dist/cli.js health --serve --port 8787
```

- Spot quote (read-only):
```bash
node dist/cli.js spot quote --symbol BTC/USDT --depth 5 --json
```

- Futures positions (read-only):
```bash
node dist/cli.js futures positions --scope usdm --symbol BTC/USDT:USDT --json
```

- Spot with SL/TP:
```bash
node dist/cli.js spot buy --symbol BTC/USDT --type market --amount 0.001 --stop-loss 93000 --take-profit 98000 --json
```

- Futures protect existing position:
```bash
node dist/cli.js futures protect --scope coinm --symbol SOL/USD:SOL --side buy --amount 1 --take-profit 100 --json
```

## Live Action Policy

- Consider these commands live-impacting: `spot buy/sell/protect`, `futures buy/sell/protect`, order cancel flows.
- Run live-impacting commands only if user intent is explicit.
- If intent is ambiguous, stay on read-only or paper mode and explain the safer command used.

## References

- Load [references/commands.md](references/commands.md) for quick command matrix and common troubleshooting checks.
