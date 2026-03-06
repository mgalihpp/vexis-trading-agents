import type { RiskRules } from "../types";

export const defaultRiskRules: RiskRules = {
  maxRiskPerTradePct: 1.0,
  maxExposurePct: 35,
  drawdownCutoffPct: 12,
  maxAtrPct: 6,
  minLiquidityUsd: 20,
};
