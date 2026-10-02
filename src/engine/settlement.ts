import type { LogDescription } from 'ethers';
import type { Mempool } from './mempool.js';

/** IntentEngine.SkipReason, by enum index */
export const SKIP_REASONS = ['wrong pair', 'not a registered vault', 'vault call reverted', 'vault circuit breaker tripped'];

/**
 * Apply one IntentEngine log (IntentFilled / IntentRefunded / IntentSkipped) to the matching
 * live intent. Idempotent: intents already in a terminal state are left alone, so the
 * submitter (from its receipt) and the event listener (from polled logs) can both call this.
 * Returns true if an intent changed status.
 */
export function applyEngineLog(mempool: Mempool, log: LogDescription, txHash: string): boolean {
  if (log.name !== 'IntentFilled' && log.name !== 'IntentRefunded' && log.name !== 'IntentSkipped') return false;

  const { batchId, vault, sessionKey, nonce } = log.args;
  const intent = mempool.findLive(vault, sessionKey, nonce);
  if (!intent || mempool.isTerminal(intent)) return false;

  const common = { txHash, batchId: batchId as bigint };
  switch (log.name) {
    case 'IntentFilled':
      mempool.setStatus(intent.id, 'settled', { ...common, amountOut: log.args.amountOut, lastExclusion: undefined });
      break;
    case 'IntentRefunded':
      mempool.setStatus(intent.id, 'refunded', { ...common, lastExclusion: 'output below minAmountOut at settlement' });
      break;
    case 'IntentSkipped': {
      const reason = SKIP_REASONS[Number(log.args.reason)] ?? `skip reason ${log.args.reason}`;
      mempool.setStatus(intent.id, 'failed', { ...common, lastExclusion: `skipped on-chain: ${reason}` });
      break;
    }
  }
  return true;
}
