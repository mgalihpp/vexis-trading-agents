// AUTO-GENERATED FROM data/models/ta_v2_artifacts.json
// Regenerate via scripts/train_ta_v2.py
export interface TaModelArtifact {
  version: string;
  generatedAt: string;
  lookback: {
    minCandles: number;
  };
  regime: {
    lowVolThreshold: number;
    highVolThreshold: number;
    trendAdxThreshold: number;
    transitionSensitivity: number;
    detectionLatencyCandles: number;
  };
  classifier: {
    bias: number;
    weights: Record<string, number>;
  };
  calibration: {
    method: "isotonic_piecewise";
    points: Array<{ x: number; y: number }>;
  };
}

export const TA_MODEL_ARTIFACT: TaModelArtifact = {
  version: "2.0.0",
  generatedAt: "2026-03-06T00:00:00.000Z",
  lookback: {
    minCandles: 80,
  },
  regime: {
    lowVolThreshold: 0.008,
    highVolThreshold: 0.75,
    trendAdxThreshold: 22,
    transitionSensitivity: 0.12,
    detectionLatencyCandles: 3,
  },
  classifier: {
    bias: -0.12,
    weights: {
      rsi_norm: 0.26,
      macd_spread_norm: 0.34,
      ema_spread_norm: 0.28,
      adx_norm: 0.22,
      atr_pct_norm: -0.25,
      volume_z_norm: 0.16,
      structure_bias: 0.3,
      liquidity_penalty: -0.24,
      smc_score: 0.25,
      mtf_alignment: 0.2,
      breakout_quality: 0.22,
    },
  },
  calibration: {
    method: "isotonic_piecewise",
    points: [
      { x: 0.0, y: 0.03 },
      { x: 0.1, y: 0.08 },
      { x: 0.2, y: 0.17 },
      { x: 0.3, y: 0.29 },
      { x: 0.4, y: 0.41 },
      { x: 0.5, y: 0.53 },
      { x: 0.6, y: 0.64 },
      { x: 0.7, y: 0.75 },
      { x: 0.8, y: 0.84 },
      { x: 0.9, y: 0.92 },
      { x: 1.0, y: 0.97 },
    ],
  },
};

