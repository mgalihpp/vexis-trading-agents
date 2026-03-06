#!/usr/bin/env python3
"""
Offline trainer for TA Engine v2 artifacts.

This script generates:
1) data/models/ta_v2_artifacts.json
2) src/agents/ta-model.generated.ts

It is intentionally lightweight and can run without pandas/sklearn.
If sklearn is available, you can extend fit_classifier() for real dataset training.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_PATH = ROOT / "data" / "models" / "ta_v2_artifacts.json"
TS_OUTPUT_PATH = ROOT / "src" / "agents" / "ta-model.generated.ts"


@dataclass
class Artifact:
    version: str
    generatedAt: str
    lookback: dict
    regime: dict
    classifier: dict
    calibration: dict


def build_default_artifact() -> Artifact:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return Artifact(
        version="2.0.0",
        generatedAt=now,
        lookback={"minCandles": 80},
        regime={
            "lowVolThreshold": 0.008,
            "highVolThreshold": 0.03,
            "trendAdxThreshold": 22,
            "transitionSensitivity": 0.12,
            "detectionLatencyCandles": 3,
        },
        classifier={
            "bias": -0.12,
            "weights": {
                "rsi_norm": 0.26,
                "macd_spread_norm": 0.34,
                "ema_spread_norm": 0.28,
                "adx_norm": 0.22,
                "atr_pct_norm": -0.25,
                "volume_z_norm": 0.16,
                "structure_bias": 0.30,
                "liquidity_penalty": -0.24,
                "smc_score": 0.25,
                "mtf_alignment": 0.20,
                "breakout_quality": 0.22,
            },
        },
        calibration={
            "method": "isotonic_piecewise",
            "points": [
                {"x": 0.0, "y": 0.03},
                {"x": 0.1, "y": 0.08},
                {"x": 0.2, "y": 0.17},
                {"x": 0.3, "y": 0.29},
                {"x": 0.4, "y": 0.41},
                {"x": 0.5, "y": 0.53},
                {"x": 0.6, "y": 0.64},
                {"x": 0.7, "y": 0.75},
                {"x": 0.8, "y": 0.84},
                {"x": 0.9, "y": 0.92},
                {"x": 1.0, "y": 0.97},
            ],
        },
    )


def write_json_artifact(artifact: Artifact) -> None:
    ARTIFACT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with ARTIFACT_PATH.open("w", encoding="utf-8") as f:
        json.dump(asdict(artifact), f, indent=2)
        f.write("\n")


def write_ts_generated(artifact: Artifact) -> None:
    ts = f"""// AUTO-GENERATED FROM data/models/ta_v2_artifacts.json
// Regenerate via scripts/train_ta_v2.py
export interface TaModelArtifact {{
  version: string;
  generatedAt: string;
  lookback: {{
    minCandles: number;
  }};
  regime: {{
    lowVolThreshold: number;
    highVolThreshold: number;
    trendAdxThreshold: number;
    transitionSensitivity: number;
    detectionLatencyCandles: number;
  }};
  classifier: {{
    bias: number;
    weights: Record<string, number>;
  }};
  calibration: {{
    method: "isotonic_piecewise";
    points: Array<{{ x: number; y: number }}>;
  }};
}}

export const TA_MODEL_ARTIFACT: TaModelArtifact = {json.dumps(asdict(artifact), indent=2)};
"""
    TS_OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    TS_OUTPUT_PATH.write_text(ts, encoding="utf-8")


def main() -> None:
    artifact = build_default_artifact()
    write_json_artifact(artifact)
    write_ts_generated(artifact)
    print(f"Wrote {ARTIFACT_PATH}")
    print(f"Wrote {TS_OUTPUT_PATH}")


if __name__ == "__main__":
    main()

