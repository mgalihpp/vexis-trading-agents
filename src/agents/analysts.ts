import { ADX, ATR, EMA, MACD, RSI } from "technicalindicators";
import type {
  ConfidenceBucket,
  FundamentalsAnalysis,
  FundamentalsData,
  LegacyTechnicalSnapshot,
  NewsAnalysis,
  NewsEvent,
  OHLCVCandle,
  RegimeState,
  SentimentAnalysis,
  SentimentSignal,
  TechnicalAnalysis
} from "../types";
import { clamp, round } from "../utils/common";
import type { EventStore, AgentContext } from "../types";
import { BaseAgent } from "./base";
import { TA_MODEL_ARTIFACT } from "./ta-model.generated";

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
  private readonly shadowMode: boolean;

  public constructor(eventStore: EventStore, options?: { shadowMode?: boolean }) {
    super(eventStore);
    this.shadowMode = options?.shadowMode ?? true;
  }

  public async run(input: OHLCVCandle[], ctx: AgentContext): Promise<TechnicalAnalysis> {
    const minCandles = TA_MODEL_ARTIFACT.lookback.minCandles;
    if (input.length < minCandles) {
      const fallback = this.createInsufficientDataOutput(input);
      await this.logDecision(
        ctx,
        input,
        fallback,
        `Insufficient candles for TA v2 (need >=${minCandles}, got ${input.length}). Applied deterministic fallback.`,
      );
      return fallback;
    }

    const legacy = this.computeLegacy(input);
    const features = this.computeFeatures(input);
    const structure = this.computeStructure(input, features);
    const liquidity = this.computeLiquidity(input, structure);
    const smc = this.computeSmc(input, TA_MODEL_ARTIFACT.regime.highVolThreshold);
    const regime = this.computeRegime(features, structure);
    const confirmation = this.computeConfirmation(input, features, structure);
    const signals = this.computeSignals(features, structure, liquidity, smc.smc_score, confirmation, regime);

    const output: TechnicalAnalysis = {
      features,
      structure,
      liquidity,
      smc,
      regime,
      confirmation,
      signals,
      shadow: {
        enabled: this.shadowMode,
        baseline: legacy,
        agreement: legacy.signal === signals.direction
      }
    };

    await this.logDecision(
      ctx,
      input,
      output,
      "TA v2 produced regime-aware probabilistic signal with structure/liquidity/SMC and legacy shadow comparison.",
    );
    return output;
  }

  private createInsufficientDataOutput(input: OHLCVCandle[]): TechnicalAnalysis {
    const legacy = this.computeLegacy(input);
    const neutralRegime: RegimeState = "low_vol";
    return {
      features: {
        rsi14: 50,
        macd: 0,
        macdSignal: 0,
        ema9: legacy.support,
        ema21: legacy.resistance,
        atr14: 0,
        adx14: 10,
        atrPercentile: 0.2,
        volumeZScore: 0,
        wickBodyRatio: 1,
        realizedVolatility: 0,
      },
      structure: {
        trend: legacy.trend,
        state: "neutral",
        bos: false,
        choch: false,
        swing_high: legacy.resistance,
        swing_low: legacy.support,
        support: legacy.support,
        resistance: legacy.resistance,
      },
      liquidity: {
        sweep_detected: false,
        sweep_side: "none",
        sweep_score: 0,
        stop_hunt_score: 0,
      },
      smc: {
        order_blocks: [],
        imbalances: [],
        smc_score: 0.2,
      },
      regime: {
        state: neutralRegime,
        transition_probability: 0.1,
        volatility_score: 0.1,
        detection_latency_candles: TA_MODEL_ARTIFACT.regime.detectionLatencyCandles,
      },
      confirmation: {
        orthogonal_score: 0.35,
        collinearity_risk: 0.65,
        mtf_alignment_score: 0.5,
        htf_bias: "neutral",
      },
      signals: {
        direction: legacy.signal,
        calibrated_probability: legacy.confidence,
        confidence_bucket: this.toBucket(legacy.confidence),
        composite_score: 0,
      },
      shadow: {
        enabled: this.shadowMode,
        baseline: legacy,
        agreement: true,
      },
    };
  }

  private computeLegacy(input: OHLCVCandle[]): LegacyTechnicalSnapshot {
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
    const rsi = rsiSeries[rsiSeries.length - 1] ?? 50;
    const emaFast = emaFastSeries[emaFastSeries.length - 1] ?? closes[closes.length - 1] ?? 0;
    const emaSlow = emaSlowSeries[emaSlowSeries.length - 1] ?? closes[closes.length - 1] ?? 0;
    const macdLast = macdSeries[macdSeries.length - 1] ?? { MACD: 0, signal: 0 };

    const trend = emaFast > emaSlow ? "up" : emaFast < emaSlow ? "down" : "sideways";
    const signal = macdLast.MACD > macdLast.signal && rsi < 70
      ? "buy"
      : macdLast.MACD < macdLast.signal && rsi > 30
        ? "sell"
        : "hold";

    const minLow = Math.min(...lows);
    const maxHigh = Math.max(...highs);

    return {
      trend,
      signal,
      support: round(minLow, 4),
      resistance: round(maxHigh, 4),
      confidence: round(clamp(0.4 + Math.abs((macdLast.MACD ?? 0) - (macdLast.signal ?? 0)) * 2, 0.2, 0.9), 3),
    };
  }

  private computeFeatures(input: OHLCVCandle[]): TechnicalAnalysis["features"] {
    const closes = input.map((c) => c.close);
    const highs = input.map((c) => c.high);
    const lows = input.map((c) => c.low);
    const volumes = input.map((c) => c.volume);
    const rsiSeries = RSI.calculate({ period: 14, values: closes });
    const ema9Series = EMA.calculate({ period: 9, values: closes });
    const ema21Series = EMA.calculate({ period: 21, values: closes });
    const macdSeries = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    });
    const atrSeries = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
    const adxSeries = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });

    const lastClose = closes[closes.length - 1] ?? 0;
    const rsi14 = rsiSeries[rsiSeries.length - 1] ?? 50;
    const ema9 = ema9Series[ema9Series.length - 1] ?? lastClose;
    const ema21 = ema21Series[ema21Series.length - 1] ?? lastClose;
    const macdLast = macdSeries[macdSeries.length - 1] ?? { MACD: 0, signal: 0 };
    const atr14 = atrSeries[atrSeries.length - 1] ?? 0;
    const adx14 = adxSeries[adxSeries.length - 1]?.adx ?? 10;

    const atrNormHistory = atrSeries.slice(-60).map((v) => v / Math.max(lastClose, 1));
    const currentAtrNorm = atr14 / Math.max(lastClose, 1);
    const atrPercentile =
      atrNormHistory.length === 0
        ? 0.5
        : clamp(
            atrNormHistory.filter((v) => v <= currentAtrNorm).length / atrNormHistory.length,
            0,
            1,
          );

    const volSlice = volumes.slice(-30);
    const volMean = volSlice.reduce((sum, v) => sum + v, 0) / Math.max(volSlice.length, 1);
    const volStd = Math.sqrt(
      volSlice.reduce((sum, v) => sum + (v - volMean) ** 2, 0) / Math.max(volSlice.length, 1),
    );
    const volumeZScore = volStd <= 1e-9 ? 0 : (volumes[volumes.length - 1]! - volMean) / volStd;

    const lastCandle = input[input.length - 1]!;
    const body = Math.abs(lastCandle.close - lastCandle.open);
    const wick = (lastCandle.high - lastCandle.low) - body;
    const wickBodyRatio = body <= 1e-9 ? 4 : wick / body;

    const returns = closes.slice(-30).map((c, i, arr) => (i === 0 ? 0 : (c - arr[i - 1]!) / Math.max(arr[i - 1]!, 1)));
    const returnMean = returns.reduce((sum, r) => sum + r, 0) / Math.max(returns.length, 1);
    const realizedVolatility = Math.sqrt(
      returns.reduce((sum, r) => sum + (r - returnMean) ** 2, 0) / Math.max(returns.length, 1),
    );

    return {
      rsi14: round(rsi14, 4),
      macd: round(macdLast.MACD ?? 0, 6),
      macdSignal: round(macdLast.signal ?? 0, 6),
      ema9: round(ema9, 4),
      ema21: round(ema21, 4),
      atr14: round(atr14, 4),
      adx14: round(adx14, 4),
      atrPercentile: round(atrPercentile, 4),
      volumeZScore: round(volumeZScore, 4),
      wickBodyRatio: round(clamp(wickBodyRatio, 0, 8), 4),
      realizedVolatility: round(realizedVolatility, 6),
    };
  }

  private computeStructure(
    input: OHLCVCandle[],
    features: TechnicalAnalysis["features"],
  ): TechnicalAnalysis["structure"] {
    const closes = input.map((c) => c.close);
    const highs = input.map((c) => c.high);
    const lows = input.map((c) => c.low);
    const lookback = Math.min(20, input.length);
    const recentHigh = Math.max(...highs.slice(-lookback));
    const recentLow = Math.min(...lows.slice(-lookback));
    const previousHigh = Math.max(...highs.slice(-(lookback + 10), -10));
    const previousLow = Math.min(...lows.slice(-(lookback + 10), -10));
    const lastClose = closes[closes.length - 1] ?? 0;
    const prevClose = closes[closes.length - 2] ?? lastClose;
    const displacement = Math.abs(lastClose - prevClose) / Math.max(features.atr14, 1e-9);

    const bosBull = lastClose > previousHigh && displacement > 0.6;
    const bosBear = lastClose < previousLow && displacement > 0.6;
    const bos = bosBull || bosBear;
    const trend = features.ema9 > features.ema21 ? "up" : features.ema9 < features.ema21 ? "down" : "sideways";
    const state = bosBull ? "bullish" : bosBear ? "bearish" : trend === "up" ? "bullish" : trend === "down" ? "bearish" : "neutral";
    const choch =
      (trend === "up" && bosBear) ||
      (trend === "down" && bosBull);

    return {
      trend,
      state,
      bos,
      choch,
      swing_high: round(recentHigh, 4),
      swing_low: round(recentLow, 4),
      support: round(recentLow, 4),
      resistance: round(recentHigh, 4),
    };
  }

  private computeLiquidity(
    input: OHLCVCandle[],
    structure: TechnicalAnalysis["structure"],
  ): TechnicalAnalysis["liquidity"] {
    const last = input[input.length - 1]!;
    const prevRange = input.slice(-30, -1);
    const equalHigh = prevRange.some((c) => Math.abs(c.high - structure.resistance) / Math.max(structure.resistance, 1) < 0.0015);
    const equalLow = prevRange.some((c) => Math.abs(c.low - structure.support) / Math.max(structure.support, 1) < 0.0015);
    const body = Math.abs(last.close - last.open);
    const upperWick = last.high - Math.max(last.open, last.close);
    const lowerWick = Math.min(last.open, last.close) - last.low;
    const bearishRejection = last.high > structure.resistance && upperWick > body * 1.3 && last.close < structure.resistance;
    const bullishRejection = last.low < structure.support && lowerWick > body * 1.3 && last.close > structure.support;
    const sweepSell = equalHigh && bearishRejection;
    const sweepBuy = equalLow && bullishRejection;
    const sweepScore = clamp(
      (sweepSell || sweepBuy ? 0.6 : 0.15) + clamp((Math.max(upperWick, lowerWick) / Math.max(body, 1e-9)) / 4, 0, 0.35),
      0,
      1,
    );
    const stopHuntScore = clamp(sweepScore * 0.7 + (last.volume > (prevRange[prevRange.length - 1]?.volume ?? last.volume) ? 0.2 : 0), 0, 1);

    return {
      sweep_detected: sweepSell || sweepBuy,
      sweep_side: sweepSell ? "buy_side" : sweepBuy ? "sell_side" : "none",
      sweep_score: round(sweepScore, 4),
      stop_hunt_score: round(stopHuntScore, 4),
    };
  }

  private computeSmc(
    input: OHLCVCandle[],
    highVolThreshold: number,
  ): TechnicalAnalysis["smc"] {
    const orderBlocks: TechnicalAnalysis["smc"]["order_blocks"] = [];
    const imbalances: TechnicalAnalysis["smc"]["imbalances"] = [];
    const closes = input.map((c) => c.close);

    for (let i = Math.max(2, input.length - 30); i < input.length - 2; i++) {
      const c0 = input[i - 1]!;
      const c1 = input[i]!;
      const c2 = input[i + 1]!;

      const bullishImpulse = c1.close > c1.open && c1.close > c0.high;
      const bearishImpulse = c1.close < c1.open && c1.close < c0.low;

      if (bullishImpulse && c0.close < c0.open) {
        orderBlocks.push({
          side: "demand",
          low: round(c0.low, 4),
          high: round(c0.high, 4),
          strength: round(clamp((c1.close - c1.open) / Math.max(c1.high - c1.low, 1e-9), 0, 1), 4),
          mitigation_count: 0,
          age_candles: input.length - i,
        });
      }
      if (bearishImpulse && c0.close > c0.open) {
        orderBlocks.push({
          side: "supply",
          low: round(c0.low, 4),
          high: round(c0.high, 4),
          strength: round(clamp((c1.open - c1.close) / Math.max(c1.high - c1.low, 1e-9), 0, 1), 4),
          mitigation_count: 0,
          age_candles: input.length - i,
        });
      }

      if (c2.low > c0.high) {
        const gapSizePct = (c2.low - c0.high) / Math.max(c0.high, 1);
        imbalances.push({
          side: "bullish",
          low: round(c0.high, 4),
          high: round(c2.low, 4),
          gap_size_pct: round(gapSizePct, 5),
          fill_probability: round(clamp(0.62 - gapSizePct / Math.max(highVolThreshold, 1e-9), 0.2, 0.95), 4),
        });
      }
      if (c2.high < c0.low) {
        const gapSizePct = (c0.low - c2.high) / Math.max(c0.low, 1);
        imbalances.push({
          side: "bearish",
          low: round(c2.high, 4),
          high: round(c0.low, 4),
          gap_size_pct: round(gapSizePct, 5),
          fill_probability: round(clamp(0.62 - gapSizePct / Math.max(highVolThreshold, 1e-9), 0.2, 0.95), 4),
        });
      }
    }

    const newestObs = orderBlocks.slice(-4);
    const newestImb = imbalances.slice(-4);
    const obScore =
      newestObs.length === 0
        ? 0.2
        : newestObs.reduce((sum, ob) => sum + ob.strength * (1 - Math.min(ob.age_candles, 20) / 20), 0) / newestObs.length;
    const imbalanceScore =
      newestImb.length === 0
        ? 0.2
        : newestImb.reduce((sum, fvg) => sum + (1 - fvg.fill_probability), 0) / newestImb.length;
    const directionBias = closes[closes.length - 1]! >= closes[closes.length - 5]! ? 0.08 : -0.08;

    return {
      order_blocks: newestObs,
      imbalances: newestImb,
      smc_score: round(clamp((obScore + imbalanceScore) / 2 + directionBias, 0, 1), 4),
    };
  }

  private computeRegime(
    features: TechnicalAnalysis["features"],
    structure: TechnicalAnalysis["structure"],
  ): TechnicalAnalysis["regime"] {
    const cfg = TA_MODEL_ARTIFACT.regime;
    let state: RegimeState = "low_vol";
    if (features.atrPercentile >= cfg.highVolThreshold || features.volumeZScore > 1.8) {
      state = "high_vol_news";
    } else if (features.adx14 >= cfg.trendAdxThreshold && structure.trend !== "sideways") {
      state = "trend";
    }

    const volatilityScore = clamp(
      features.atrPercentile * 0.55 +
      clamp(features.volumeZScore / 3, 0, 1) * 0.25 +
      clamp(features.realizedVolatility * 12, 0, 1) * 0.2,
      0,
      1,
    );
    const transitionProbability = clamp(
      Math.abs(volatilityScore - 0.5) * cfg.transitionSensitivity * 2 + (structure.choch ? 0.18 : 0.08),
      0,
      1,
    );

    return {
      state,
      transition_probability: round(transitionProbability, 4),
      volatility_score: round(volatilityScore, 4),
      detection_latency_candles: cfg.detectionLatencyCandles,
    };
  }

  private computeConfirmation(
    input: OHLCVCandle[],
    features: TechnicalAnalysis["features"],
    structure: TechnicalAnalysis["structure"],
  ): TechnicalAnalysis["confirmation"] {
    const macdSpread = Math.abs(features.macd - features.macdSignal);
    const emaSpread = Math.abs(features.ema9 - features.ema21) / Math.max(features.ema21, 1);
    const momentumAgreement = clamp((macdSpread * 10 + emaSpread * 20 + Math.abs(features.rsi14 - 50) / 50) / 3, 0, 1);
    const collinearityRisk = clamp(0.75 - momentumAgreement * 0.55, 0, 1);

    const htf = this.aggregateCandles(input, 4);
    const htfCloses = htf.map((c) => c.close);
    const htfEmaFast = EMA.calculate({ period: 5, values: htfCloses }).at(-1) ?? htfCloses.at(-1) ?? 0;
    const htfEmaSlow = EMA.calculate({ period: 10, values: htfCloses }).at(-1) ?? htfCloses.at(-1) ?? 0;
    const htfBias = htfEmaFast > htfEmaSlow ? "bullish" : htfEmaFast < htfEmaSlow ? "bearish" : "neutral";
    const stateBias = structure.state === "bullish" ? "bullish" : structure.state === "bearish" ? "bearish" : "neutral";
    const mtfAlignmentScore = htfBias === stateBias ? 0.78 : htfBias === "neutral" || stateBias === "neutral" ? 0.56 : 0.24;

    return {
      orthogonal_score: round(momentumAgreement, 4),
      collinearity_risk: round(collinearityRisk, 4),
      mtf_alignment_score: round(mtfAlignmentScore, 4),
      htf_bias: htfBias,
    };
  }

  private computeSignals(
    features: TechnicalAnalysis["features"],
    structure: TechnicalAnalysis["structure"],
    liquidity: TechnicalAnalysis["liquidity"],
    smcScore: number,
    confirmation: TechnicalAnalysis["confirmation"],
    regime: TechnicalAnalysis["regime"],
  ): TechnicalAnalysis["signals"] {
    const weights = TA_MODEL_ARTIFACT.classifier.weights;
    const rsiNorm = (features.rsi14 - 50) / 50;
    const macdSpreadNorm = clamp((features.macd - features.macdSignal) * 10, -1, 1);
    const emaSpreadNorm = clamp((features.ema9 - features.ema21) / Math.max(features.ema21, 1) * 20, -1, 1);
    const adxNorm = clamp((features.adx14 - 20) / 25, -1, 1);
    const atrPctNorm = clamp(features.atrPercentile * 2 - 1, -1, 1);
    const volumeZNorm = clamp(features.volumeZScore / 3, -1, 1);
    const structureBias = structure.state === "bullish" ? 1 : structure.state === "bearish" ? -1 : 0;
    const liquidityPenalty = liquidity.sweep_detected ? -liquidity.sweep_score : 0;
    const mtfAlignment = confirmation.htf_bias === "bullish" && structure.state === "bullish"
      ? 1
      : confirmation.htf_bias === "bearish" && structure.state === "bearish"
        ? -1
        : 0;
    const breakoutQuality = clamp((1 - liquidity.stop_hunt_score) * 0.5 + confirmation.mtf_alignment_score * 0.5, 0, 1);

    const linear =
      TA_MODEL_ARTIFACT.classifier.bias +
      rsiNorm * weights.rsi_norm +
      macdSpreadNorm * weights.macd_spread_norm +
      emaSpreadNorm * weights.ema_spread_norm +
      adxNorm * weights.adx_norm +
      atrPctNorm * weights.atr_pct_norm +
      volumeZNorm * weights.volume_z_norm +
      structureBias * weights.structure_bias +
      liquidityPenalty * weights.liquidity_penalty +
      smcScore * weights.smc_score +
      mtfAlignment * weights.mtf_alignment +
      breakoutQuality * weights.breakout_quality;

    const rawProb = 1 / (1 + Math.exp(-linear));
    const calibrated = this.calibrate(rawProb);
    const direction = calibrated > 0.57
      ? "buy"
      : calibrated < 0.43
        ? "sell"
        : "hold";

    const regimePenalty = regime.state === "high_vol_news" ? 0.08 : 0;
    const compositeScore = round(linear - regimePenalty, 5);
    const calibratedProbability = round(clamp(calibrated - regimePenalty, 0.01, 0.99), 4);
    const confidenceBucket = this.toBucket(calibratedProbability);
    return {
      direction,
      calibrated_probability: calibratedProbability,
      confidence_bucket: confidenceBucket,
      composite_score: compositeScore,
    };
  }

  private calibrate(raw: number): number {
    const points = TA_MODEL_ARTIFACT.calibration.points;
    if (raw <= points[0]!.x) return points[0]!.y;
    if (raw >= points[points.length - 1]!.x) return points[points.length - 1]!.y;
    for (let i = 1; i < points.length; i++) {
      const left = points[i - 1]!;
      const right = points[i]!;
      if (raw >= left.x && raw <= right.x) {
        const t = (raw - left.x) / Math.max(right.x - left.x, 1e-9);
        return left.y + (right.y - left.y) * t;
      }
    }
    return raw;
  }

  private toBucket(probability: number): ConfidenceBucket {
    if (probability >= 0.7) return "high";
    if (probability >= 0.45) return "medium";
    return "low";
  }

  private aggregateCandles(input: OHLCVCandle[], chunkSize: number): OHLCVCandle[] {
    const out: OHLCVCandle[] = [];
    for (let i = 0; i < input.length; i += chunkSize) {
      const chunk = input.slice(i, i + chunkSize);
      if (chunk.length === 0) continue;
      out.push({
        timestamp: chunk[chunk.length - 1]!.timestamp,
        open: chunk[0]!.open,
        high: Math.max(...chunk.map((c) => c.high)),
        low: Math.min(...chunk.map((c) => c.low)),
        close: chunk[chunk.length - 1]!.close,
        volume: chunk.reduce((sum, c) => sum + c.volume, 0),
      });
    }
    return out;
  }
}
