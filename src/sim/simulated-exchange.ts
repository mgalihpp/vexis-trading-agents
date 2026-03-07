import type {
  AgentContext,
  EventStore,
  ExecutionDecision,
  ExecutionReport,
  OrderFillEvent,
  PnLSnapshot,
  Position,
  ProposalDecision
} from "../types";
import { round } from "../utils/common";
import { BaseAgent } from "../agents/base";

export interface ExchangeInput {
  decision: ExecutionDecision;
  proposal: ProposalDecision;
  marketPrice: number;
}

export interface SimulatedExchangeConfig {
  feeBps: number;
  slippageBps: number;
  partialFillEnabled: boolean;
}

export class SimulatedExchange extends BaseAgent<ExchangeInput, ExecutionReport> {
  public readonly name = "SimulatedExchange";

  private position: Position | null = null;
  private realizedUsd = 0;
  private readonly config: SimulatedExchangeConfig;

  public constructor(eventStore: EventStore, config?: Partial<SimulatedExchangeConfig>) {
    super(eventStore);
    this.config = {
      feeBps: Math.max(0, config?.feeBps ?? 0),
      slippageBps: Math.max(0, config?.slippageBps ?? 0),
      partialFillEnabled: config?.partialFillEnabled ?? false
    };
  }

  public async run(input: ExchangeInput, ctx: AgentContext): Promise<ExecutionReport> {
    if (input.proposal.proposal_type === "no_trade" || !input.decision.portfolio_approved || !input.decision.executable || !input.decision.execution_instructions) {
      const report: ExecutionReport = {
        decision: input.decision,
        filled: false,
        fillPrice: null,
        position: this.position,
        pnl: this.getPnlSnapshot(input.marketPrice),
        execution_details: {
          fee_bps: this.config.feeBps,
          fee_usd: 0,
          slippage_bps: this.config.slippageBps,
          slippage_usd: 0,
          order_events: [
            {
              order_status: "canceled",
              filled_notional_usd: 0,
              remaining_notional_usd: input.decision.execution_instructions?.quantity_notional_usd ?? 0,
              fill_price: input.marketPrice,
              fee_usd: 0,
              slippage_bps: this.config.slippageBps
            }
          ]
        }
      };
      await this.logDecision(ctx, input, report, "No execution performed because allocation was not approved.");
      return report;
    }

    const requestedNotional = input.decision.execution_instructions.quantity_notional_usd;
    const fillRatio = this.computeFillRatio(input.proposal, requestedNotional);
    const filledNotional = round(requestedNotional * fillRatio, 2);
    const remainingNotional = round(requestedNotional - filledNotional, 2);

    const direction = input.proposal.proposal_type === "trade" && input.proposal.side === "short" ? -1 : 1;
    const slippagePct = (this.config.slippageBps / 10000) * direction;
    const fillPrice = round(input.marketPrice * (1 + slippagePct), 6);
    const feeUsd = round((filledNotional * this.config.feeBps) / 10000, 6);
    const slippageUsd = round(Math.abs(fillPrice - input.marketPrice) * (filledNotional / Math.max(fillPrice, 1e-9)), 6);

    const events: OrderFillEvent[] = [
      {
        order_status: "new",
        filled_notional_usd: 0,
        remaining_notional_usd: requestedNotional,
        fill_price: input.marketPrice,
        fee_usd: 0,
        slippage_bps: this.config.slippageBps
      }
    ];

    if (filledNotional <= 0) {
      events.push({
        order_status: "canceled",
        filled_notional_usd: 0,
        remaining_notional_usd: requestedNotional,
        fill_price: input.marketPrice,
        fee_usd: 0,
        slippage_bps: this.config.slippageBps
      });
    } else if (remainingNotional > 0) {
      events.push({
        order_status: "partial",
        filled_notional_usd: filledNotional,
        remaining_notional_usd: remainingNotional,
        fill_price: fillPrice,
        fee_usd: feeUsd,
        slippage_bps: this.config.slippageBps
      });
    } else {
      events.push({
        order_status: "filled",
        filled_notional_usd: filledNotional,
        remaining_notional_usd: 0,
        fill_price: fillPrice,
        fee_usd: feeUsd,
        slippage_bps: this.config.slippageBps
      });
    }

    if (filledNotional > 0) {
      this.position = {
        asset: input.proposal.asset,
        side: input.proposal.proposal_type === "trade" ? input.proposal.side : "long",
        quantityNotionalUsd: round(filledNotional - feeUsd, 2),
        avgEntry: fillPrice
      };
      this.realizedUsd = round(this.realizedUsd - feeUsd, 6);
    }

    const report: ExecutionReport = {
      decision: input.decision,
      filled: filledNotional > 0,
      fillPrice: filledNotional > 0 ? fillPrice : null,
      position: this.position,
      pnl: this.getPnlSnapshot(input.marketPrice),
      execution_details: {
        fee_bps: this.config.feeBps,
        fee_usd: feeUsd,
        slippage_bps: this.config.slippageBps,
        slippage_usd: slippageUsd,
        order_events: events
      }
    };

    await this.logDecision(
      ctx,
      input,
      report,
      `Executed simulated order with fill_ratio=${fillRatio.toFixed(3)}, fee_bps=${this.config.feeBps}, slippage_bps=${this.config.slippageBps}.`
    );
    return report;
  }

  private computeFillRatio(proposal: ProposalDecision, requestedNotional: number): number {
    if (!this.config.partialFillEnabled) {
      return requestedNotional > 0 ? 1 : 0;
    }

    const sizePenalty = proposal.proposal_type === "trade"
      ? Math.min(0.4, Math.max(0, proposal.suggested_position_size_pct_equity / 100))
      : 0.4;
    const baseline = 0.95 - sizePenalty;
    return Math.max(0.25, Math.min(1, round(baseline, 4)));
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
