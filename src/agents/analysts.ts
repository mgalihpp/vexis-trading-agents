import { ATR, EMA, MACD, RSI } from "technicalindicators";
import type {
  FundamentalsAnalysis,
  FundamentalsData,
  NewsAnalysis,
  NewsEvent,
  OHLCVCandle,
  SentimentAnalysis,
  SentimentSignal,
  TechnicalAnalysis
} from "../types";
import { clamp, round } from "../utils/common";
import type { EventStore, AgentContext } from "../types";
import { BaseAgent } from "./base";

export class FundamentalsAnalyst extends BaseAgent<FundamentalsData, FundamentalsAnalysis> {
  public readonly name = "FundamentalsAnalyst";

  public constructor(eventStore: EventStore) {
    super(eventStore);
  }

  public async run(input: FundamentalsData, ctx: AgentContext): Promise<FundamentalsAnalysis> {
    const legacyScore =
      (input.earningsGrowthPct ?? 0) * 0.2 +
      (input.revenueGrowthPct ?? 0) * 0.2 +
      (2 - (input.debtToEquity ?? 1)) * 6 +
      (input.currentRatio ?? 1) * 4 -
      (input.peRatio ?? 0) * 0.2;

    const liquiditySignal = clamp(input.volume24hUsd / Math.max(input.marketCapUsd, 1), 0, 1);
    const valuationSignal = clamp((input.fdvUsd - input.marketCapUsd) / Math.max(input.fdvUsd, 1), -1, 1);
    const score = legacyScore + input.onChainActivityScore * 20 + liquiditySignal * 10 - valuationSignal * 8;

    const redFlags: string[] = [];
    if ((input.debtToEquity ?? 0) > 1.2) redFlags.push("High debt-to-equity");
    if ((input.currentRatio ?? 1.1) < 1.0) redFlags.push("Weak liquidity ratio");
    if ((input.earningsGrowthPct ?? 1) < 0) redFlags.push("Negative earnings growth");
    if (input.circulatingSupplyRatio < 0.65) redFlags.push("Low circulating supply ratio");
    if (input.onChainActivityScore < 0.35) redFlags.push("Weak on-chain activity");

    const intrinsic_valuation_bias = score > 18 ? "undervalued" : score < 5 ? "overvalued" : "fair";
    const output: FundamentalsAnalysis = {
      intrinsic_valuation_bias,
      red_flags: redFlags,
      confidence: round(clamp(0.5 + score / 60 - redFlags.length * 0.05, 0.1, 0.95), 3)
    };

    await this.logDecision(ctx, input, output, "Score weighted by growth, leverage, liquidity and valuation multiples.");
    return output;
  }
}

export class SentimentAnalyst extends BaseAgent<SentimentSignal[], SentimentAnalysis> {
  public readonly name = "SentimentAnalyst";

  public constructor(eventStore: EventStore) {
    super(eventStore);
  }

  public async run(input: SentimentSignal[], ctx: AgentContext): Promise<SentimentAnalysis> {
    const avg = input.length === 0 ? 0 : input.reduce((sum, s) => sum + s.score, 0) / input.length;
    const sentiment_score = round(clamp(avg, -1, 1), 4);
    const mood = sentiment_score > 0.2 ? "optimistic" : sentiment_score < -0.2 ? "fearful" : "neutral";
    const output: SentimentAnalysis = {
      sentiment_score,
      mood,
      confidence: round(clamp(0.5 + Math.abs(sentiment_score) * 0.4, 0.2, 0.9), 3)
    };

    await this.logDecision(ctx, input, output, "Computed mean sentiment and mapped score bands to market mood.");
    return output;
  }
}

export class NewsAnalyst extends BaseAgent<NewsEvent[], NewsAnalysis> {
  public readonly name = "NewsAnalyst";

  public constructor(eventStore: EventStore) {
    super(eventStore);
  }

  public async run(input: NewsEvent[], ctx: AgentContext): Promise<NewsAnalysis> {
    const sectors = [...new Set(input.map((e) => e.sector))];
    let net = 0;
    let totalSeverity = 0;

    for (const event of input) {
      totalSeverity += event.severity;
      if (event.impact === "bullish") net += event.severity;
      if (event.impact === "bearish") net -= event.severity;
    }

    const avgSeverity = input.length ? totalSeverity / input.length : 0;
    const event_impact = net > 0.25 ? "bullish" : net < -0.25 ? "bearish" : "neutral";

    const output: NewsAnalysis = {
      event_impact,
      affected_sectors: sectors,
      severity: round(clamp(avgSeverity, 0, 1), 4),
      confidence: round(clamp(0.45 + Math.abs(net) * 0.25 + avgSeverity * 0.2, 0.2, 0.9), 3)
    };

    await this.logDecision(ctx, input, output, "Aggregated directional event severity and sector overlap.");
    return output;
  }
}

export class TechnicalAnalyst extends BaseAgent<OHLCVCandle[], TechnicalAnalysis> {
  public readonly name = "TechnicalAnalyst";

  public constructor(eventStore: EventStore) {
    super(eventStore);
  }

  public async run(input: OHLCVCandle[], ctx: AgentContext): Promise<TechnicalAnalysis> {
    const closes = input.map((c) => c.close);
    const highs = input.map((c) => c.high);
    const lows = input.map((c) => c.low);

    const rsiSeries = RSI.calculate({ period: 14, values: closes });
    const emaFastSeries = EMA.calculate({ period: 9, values: closes });
    const emaSlowSeries = EMA.calculate({ period: 21, values: closes });
    const macdSeries = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    });
    const atrSeries = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });

    const rsi = rsiSeries[rsiSeries.length - 1] ?? 50;
    const emaFast = emaFastSeries[emaFastSeries.length - 1] ?? closes[closes.length - 1] ?? 0;
    const emaSlow = emaSlowSeries[emaSlowSeries.length - 1] ?? closes[closes.length - 1] ?? 0;
    const macdLast = macdSeries[macdSeries.length - 1] ?? { MACD: 0, signal: 0 };
    const atr = atrSeries[atrSeries.length - 1] ?? 0;

    const trend = emaFast > emaSlow ? "up" : emaFast < emaSlow ? "down" : "sideways";
    const signal = macdLast.MACD > macdLast.signal && rsi < 70
      ? "buy"
      : macdLast.MACD < macdLast.signal && rsi > 30
        ? "sell"
        : "hold";

    const minLow = Math.min(...lows);
    const maxHigh = Math.max(...highs);

    const output: TechnicalAnalysis = {
      indicators: {
        rsi: round(rsi, 4),
        macd: round(macdLast.MACD ?? 0, 5),
        macdSignal: round(macdLast.signal ?? 0, 5),
        emaFast: round(emaFast, 4),
        emaSlow: round(emaSlow, 4),
        atr: round(atr, 4)
      },
      trend,
      signal,
      key_levels: {
        support: round(minLow, 4),
        resistance: round(maxHigh, 4)
      },
      confidence: round(clamp(0.4 + Math.abs((macdLast.MACD ?? 0) - (macdLast.signal ?? 0)) * 2, 0.2, 0.9), 3)
    };

    await this.logDecision(ctx, input, output, "Calculated RSI/MACD/EMA/ATR and derived trend-signal confluence.");
    return output;
  }
}
