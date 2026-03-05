import type {
  AgentContext,
  EventStore,
  ExecutionDecision,
  ExecutionReport,
  PnLSnapshot,
  Position,
  TradeProposal
} from "../types";
import { round } from "../utils/common";
import { BaseAgent } from "../agents/base";

export interface ExchangeInput {
  decision: ExecutionDecision;
  proposal: TradeProposal;
  marketPrice: number;
}

export class SimulatedExchange extends BaseAgent<ExchangeInput, ExecutionReport> {
  public readonly name = "SimulatedExchange";

  private position: Position | null = null;
  private realizedUsd = 0;

  public constructor(eventStore: EventStore) {
    super(eventStore);
  }

  public async run(input: ExchangeInput, ctx: AgentContext): Promise<ExecutionReport> {
    if (!input.decision.approve || !input.decision.execution_instructions) {
      const report: ExecutionReport = {
        decision: input.decision,
        filled: false,
        fillPrice: null,
        position: this.position,
        pnl: this.getPnlSnapshot(input.marketPrice)
      };
      await this.logDecision(ctx, input, report, "No execution performed because allocation was not approved.");
      return report;
    }

    const fillPrice = input.marketPrice;
    this.position = {
      asset: input.proposal.asset,
      side: input.proposal.side,
      quantityNotionalUsd: input.decision.execution_instructions.quantity_notional_usd,
      avgEntry: fillPrice
    };

    const report: ExecutionReport = {
      decision: input.decision,
      filled: true,
      fillPrice,
      position: this.position,
      pnl: this.getPnlSnapshot(input.marketPrice)
    };

    await this.logDecision(ctx, input, report, "Executed simulated market order and updated internal position ledger.");
    return report;
  }

  private getPnlSnapshot(markPrice: number): PnLSnapshot {
    let unrealizedUsd = 0;

    if (this.position) {
      const movePct = (markPrice - this.position.avgEntry) / this.position.avgEntry;
      const signedMovePct = this.position.side === "long" ? movePct : -movePct;
      unrealizedUsd = this.position.quantityNotionalUsd * signedMovePct;
    }

    const totalUsd = this.realizedUsd + unrealizedUsd;

    return {
      realizedUsd: round(this.realizedUsd, 2),
      unrealizedUsd: round(unrealizedUsd, 2),
      totalUsd: round(totalUsd, 2)
    };
  }
}
