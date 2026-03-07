import type { AgentContext, AnalystBundle, DataQualityContext, EvidenceItem, EventStore } from "../types";
import { clamp, round } from "../utils/common";
import { BaseAgent } from "./base";

export interface EvidenceNormalizerInput {
  analysts: Omit<AnalystBundle, "normalized_evidence" | "dependency_overlap_score" | "data_quality">;
  providerStatus: Array<{ ok: boolean; latencyMs: number; provider: string; statusCode: number }>;
}

export class EvidenceNormalizer extends BaseAgent<EvidenceNormalizerInput, AnalystBundle> {
  public readonly name = "EvidenceNormalizer";

  public constructor(eventStore: EventStore) {
    super(eventStore);
  }

  public async run(input: EvidenceNormalizerInput, ctx: AgentContext): Promise<AnalystBundle> {
    const allEvidence: EvidenceItem[] = [
      ...input.analysts.fundamentals.evidence,
      ...input.analysts.sentiment.evidence,
      ...input.analysts.news.evidence,
      ...input.analysts.technical.evidence,
    ];

    const byGroup = new Map<string, EvidenceItem[]>();
    for (const item of allEvidence) {
      const group = item.dependency_group || "unknown";
      const list = byGroup.get(group) ?? [];
      list.push(item);
      byGroup.set(group, list);
    }

    const normalizedEvidence: EvidenceItem[] = [];
    let overlapAccumulator = 0;
    for (const [, items] of byGroup.entries()) {
      const overlapPenalty = items.length > 1 ? clamp((items.length - 1) * 0.12, 0, 0.45) : 0;
      overlapAccumulator += overlapPenalty;
      for (const item of items) {
        normalizedEvidence.push({
          ...item,
          weight: round(clamp(item.weight * (1 - overlapPenalty), 0.05, 1), 4),
        });
      }
    }
    const horizonCounts = new Map<string, number>();
    for (const item of normalizedEvidence) {
      horizonCounts.set(item.time_horizon, (horizonCounts.get(item.time_horizon) ?? 0) + 1);
    }
    const maxHorizonShare = normalizedEvidence.length === 0
      ? 0
      : Math.max(...[...horizonCounts.values()].map((count) => count / normalizedEvidence.length));
    overlapAccumulator = clamp(overlapAccumulator + maxHorizonShare * 0.25, 0, 1);

    const providerTotal = Math.max(input.providerStatus.length, 1);
    const healthyProviders = input.providerStatus.filter((p) => p.ok).length;
    const degradedProviders = input.providerStatus.filter((p) => !p.ok).map((p) => p.provider);
    const avgLatency = input.providerStatus.reduce((sum, p) => sum + p.latencyMs, 0) / providerTotal;
    const dataQuality: DataQualityContext = {
      market_data_freshness_sec: round(Math.max(1, avgLatency / 1000), 3),
      news_data_quality: input.analysts.news.evidence.length > 0 ? "medium" : "low",
      sentiment_data_quality: input.analysts.sentiment.evidence.length > 0 ? "high" : "low",
      provider_health_score: round(clamp(healthyProviders / providerTotal, 0, 1), 4),
      degraded_providers: degradedProviders,
    };

    const output: AnalystBundle = {
      ...input.analysts,
      normalized_evidence: normalizedEvidence,
      dependency_overlap_score: round(clamp(overlapAccumulator, 0, 1), 4),
      data_quality: dataQuality,
    };

    await this.logDecision(ctx, input, output, "Deduplicated dependent evidence and produced shared data-quality context.");
    return output;
  }
}
