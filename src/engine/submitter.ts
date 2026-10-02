import type { Interface } from 'ethers';
import type { Mempool } from './mempool.js';
import { type BatchPlan, type BatchSubmitter, encodeSettleBatch } from './matcher.js';

/**
 * Placeholder until the settlement submitter is built (build step 7): logs each distinct
 * batch with its encoded settleBatch calldata and returns the intents to pending. Nothing
 * is sent on-chain.
 */
export class DryRunSubmitter implements BatchSubmitter {
  private readonly lastLogged = new Map<string, string>();

  constructor(
    private readonly mempool: Mempool,
    private readonly engine: Interface,
  ) {}

  async submit(plan: BatchPlan): Promise<void> {
    const signature = plan.intents.map((i) => i.id).join(',');
    if (this.lastLogged.get(plan.pair) !== signature) {
      this.lastLogged.set(plan.pair, signature);
      const calldata = encodeSettleBatch(this.engine, plan);
      console.log(
        `[dry-run] ${plan.pair}: ${plan.intents.length} intents, sellA=${plan.sellA} sellB=${plan.sellB}, ` +
          `matchedA=${plan.matchedA} matchedB=${plan.matchedB}, residualIn=${plan.quote.residualIn} ` +
          `(${plan.residualIsA ? 'A' : 'B'}), excluded=${plan.excluded.length}, calldata ${calldata.length / 2 - 1} bytes`,
      );
    }
    for (const intent of plan.intents) this.mempool.setStatus(intent.id, 'pending');
  }
}
