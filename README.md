# Multi-Agent AI Trading System (TypeScript)

LangGraph-based deterministic pipeline with LLM decision layer:

Market Data -> Analyst Team -> Bullish/ Bearish Research -> Debate -> Trader -> Risk -> Portfolio -> Simulated Exchange

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

## Real Data Provider Config (Crypto, Free-Stack)

```bash
THENEWSAPI_KEY=your_key
COINGECKO_API_KEY=optional
THENEWSAPI_BASE_URL=https://api.thenewsapi.com/v1/news
ALTERNATIVE_ME_BASE_URL=https://api.alternative.me
COINGECKO_BASE_URL=https://api.coingecko.com/api/v3
PROVIDER_CACHE_TTL_SECONDS=300
STRICT_REAL_MODE=true
```

- Sentiment source: Alternative.me Fear & Greed (public/free)
- News source: TheNewsAPI
- Fundamentals source: CoinGecko

`STRICT_REAL_MODE=true` is fail-hard: missing key/provider errors stop cycle before analyst nodes.

You can place all vars in root `.env`; runtime auto-loads via `dotenv`.

## Notes

- `paper/live-sim` uses real market + fundamentals + sentiment + news providers.
- `backtest` uses local fixture data.
- Execution remains simulated (no real order placement).
- Event logs include provider status telemetry (`provider`, `statusCode`, `latencyMs`, `recordCount`).
