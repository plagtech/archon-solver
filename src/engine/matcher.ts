import { Interface } from 'ethers';
import type { PairConfig } from '../config.js';
import type { BatchIntentStruct, PairKey, PendingIntent } from '../types/intent.js';
import { type Mempool, pairKey } from './mempool.js';

/** IntentEngine.MAX_BATCH_SIZE */
export const MAX_BATCH_SIZE = 200;

/**
 * Result of IntentEngine.quoteClearing(tokenA, tokenB, sellA, sellB). Side totals are already
 * net of the Spraay fee when the engine delivers through Spraay.
 */
export interface ClearingQuote {
  /** tokenB per tokenA, native units, 1e18-scaled (pool.spotPrice(tokenA)) */
  price: bigint;
  toASellers: bigint;
  toBSellers: bigint;
  residualIn: bigint;
  residualOut: bigint;
}

export type ClearingQuoter = (tokenA: string, tokenB: string, sellA: bigint, sellB: bigint) => Promise<ClearingQuote>;

export interface Exclusion {
  intent: PendingIntent;
  reason: string;
}

export interface BatchPlan {
  pair: PairKey;
  tokenA: string;
  tokenB: string;
  /** Intents in submission order (per session key, ascending nonce) */
  intents: PendingIntent[];
  /** Expected output per intent ID, as the engine will compute it pro-rata */
  expectedOut: Map<string, bigint>;
  /** Candidates left out of this batch; they stay pending for a later cycle */
  excluded: Exclusion[];
  quote: ClearingQuote;
  sellA: bigint;
  sellB: bigint;
  /** Volume matched peer-to-peer (no pool fee, no price impact), in each token */
  matchedA: bigint;
  matchedB: bigint;
  /** Which token the residual pool swap sells */
  residualIsA: boolean;
}

export interface PlanOptions {
  nowSec: number;
  /** Intents expiring within this many seconds are not batched (the tx needs time to land) */
  deadlineBufferSec: number;
  maxBatchSize?: number;
}

const ONE = 10n ** 18n;

/**
 * Build the batch the IntentEngine will settle for one pair.
 *
 * The engine clears at a single price: opposing volume is matched at the pool's fee-free spot
 * price and only the imbalance goes through the pool. Each side's proceeds are split pro-rata
 * by amountIn, and any leg whose share is below its minAmountOut is refunded and the batch
 * re-cleared. Refunded legs still burn their nonce and cap usage on-chain, so this function
 * runs the same loop off-chain and leaves those intents out instead of submitting them.
 *
 * Returns null if no intent can be included.
 */
export async function planBatch(
  tokenA: string,
  tokenB: string,
  candidates: PendingIntent[],
  quoter: ClearingQuoter,
  options: PlanOptions,
): Promise<BatchPlan | null> {
  const excluded: Exclusion[] = [];
  const key = pairKey(tokenA, tokenB);
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();

  const eligible = candidates.filter((intent) => {
    const tin = intent.tokenIn.toLowerCase();
    const tout = intent.tokenOut.toLowerCase();
    if (!((tin === a && tout === b) || (tin === b && tout === a))) {
      excluded.push({ intent, reason: 'intent is not for this pair' });
      return false;
    }
    if (intent.deadline <= options.nowSec + options.deadlineBufferSec) {
      excluded.push({ intent, reason: 'deadline too close to settle' });
      return false;
    }
    return true;
  });

  const ordered = orderByNonce(eligible, excluded);
  const maxSize = options.maxBatchSize ?? MAX_BATCH_SIZE;
  let batch = ordered.slice(0, maxSize);
  for (const intent of ordered.slice(maxSize)) excluded.push({ intent, reason: 'batch full' });

  while (batch.length > 0) {
    const sellA = sum(batch, (i) => i.tokenIn.toLowerCase() === a);
    const sellB = sum(batch, (i) => i.tokenIn.toLowerCase() !== a);
    const quote = await quoter(tokenA, tokenB, sellA, sellB);
    if (quote.price === 0n) {
      for (const intent of batch) excluded.push({ intent, reason: 'pool is empty' });
      return null;
    }

    const expectedOut = new Map<string, bigint>();
    const failed = new Set<string>();
    for (const intent of batch) {
      const sellsA = intent.tokenIn.toLowerCase() === a;
      const out = sellsA ? (quote.toASellers * intent.amountIn) / sellA : (quote.toBSellers * intent.amountIn) / sellB;
      if (out === 0n || out < intent.minAmountOut) {
        failed.add(intent.id);
        excluded.push({ intent, reason: `clearing output ${out} below minAmountOut ${intent.minAmountOut}` });
      } else {
        expectedOut.set(intent.id, out);
      }
    }

    if (failed.size === 0) {
      const sellBInA = (sellB * ONE) / quote.price;
      const residualIsA = sellA >= sellBInA;
      return {
        pair: key,
        tokenA,
        tokenB,
        intents: batch,
        expectedOut,
        excluded,
        quote,
        sellA,
        sellB,
        matchedA: residualIsA ? sellBInA : sellA,
        matchedB: residualIsA ? sellB : (sellA * quote.price) / ONE,
        residualIsA,
      };
    }

    // Dropping a leg also invalidates the session key's later nonces in this batch
    batch = dropAfterFailures(batch, failed, excluded);
  }
  return null;
}

/**
 * Order intents so each session key's legs are pulled in ascending nonce order, keeping only
 * the gap-free run from the key's lowest nonce (a later nonce would revert until the earlier
 * one is consumed). Keys are ordered by their oldest intent.
 */
function orderByNonce(intents: PendingIntent[], excluded: Exclusion[]): PendingIntent[] {
  const groups = new Map<string, PendingIntent[]>();
  for (const intent of intents) {
    const k = signerKey(intent);
    let group = groups.get(k);
    if (!group) groups.set(k, (group = []));
    group.push(intent);
  }

  const runs: PendingIntent[][] = [];
  for (const group of groups.values()) {
    group.sort((x, y) => x.nonce - y.nonce);
    const run = [group[0]];
    for (let k = 1; k < group.length; k++) {
      if (group[k].nonce === run[run.length - 1].nonce + 1) {
        run.push(group[k]);
      } else {
        for (const intent of group.slice(k)) {
          excluded.push({ intent, reason: `waiting for nonce ${run[run.length - 1].nonce + 1}` });
        }
        break;
      }
    }
    runs.push(run);
  }

  const oldest = (run: PendingIntent[]) => Math.min(...run.map((i) => i.receivedAt));
  return runs.sort((x, y) => oldest(x) - oldest(y)).flat();
}

function dropAfterFailures(batch: PendingIntent[], failed: Set<string>, excluded: Exclusion[]): PendingIntent[] {
  const brokenKeys = new Set<string>();
  const kept: PendingIntent[] = [];
  for (const intent of batch) {
    const k = signerKey(intent);
    if (failed.has(intent.id)) {
      brokenKeys.add(k);
    } else if (brokenKeys.has(k)) {
      excluded.push({ intent, reason: 'an earlier nonce from this session key was excluded' });
    } else {
      kept.push(intent);
    }
  }
  return kept;
}

function signerKey(intent: PendingIntent): string {
  return `${intent.vault.toLowerCase()}:${intent.sessionKey.toLowerCase()}`;
}

function sum(intents: PendingIntent[], predicate: (i: PendingIntent) => boolean): bigint {
  return intents.reduce((acc, i) => (predicate(i) ? acc + i.amountIn : acc), 0n);
}

export function toBatchStruct(intent: PendingIntent): BatchIntentStruct {
  return {
    vault: intent.vault,
    sessionKey: intent.sessionKey,
    tokenIn: intent.tokenIn,
    amountIn: intent.amountIn,
    minAmountOut: intent.minAmountOut,
    deadline: BigInt(intent.deadline),
    nonce: BigInt(intent.nonce),
    signature: intent.signature,
  };
}

/** Calldata for IntentEngine.settleBatch(tokenA, tokenB, intents) */
export function encodeSettleBatch(engine: Interface, plan: BatchPlan): string {
  return engine.encodeFunctionData('settleBatch', [plan.tokenA, plan.tokenB, plan.intents.map(toBatchStruct)]);
}

// ─── Matching loop ────────────────────────────────────────────────────────────

/**
 * Takes a plan whose intents are marked 'matched' and owns their status from then on
 * (settling → settled/refunded, or back to pending on failure).
 */
export interface BatchSubmitter {
  submit(plan: BatchPlan): Promise<void>;
  /** False while submissions are paused (e.g. after a configuration error); planning is skipped */
  isAvailable?(): boolean;
}

export interface MatchingLoopDeps {
  mempool: Mempool;
  pairs: PairConfig[];
  quoter: ClearingQuoter;
  submitter: BatchSubmitter;
  intervalMs: number;
  deadlineBufferSec: number;
  now?: () => number;
}

export class MatchingLoop {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly pairsByKey: Map<PairKey, PairConfig>;

  constructor(private readonly deps: MatchingLoopDeps) {
    this.pairsByKey = new Map(deps.pairs.map((p) => [pairKey(p.tokenA, p.tokenB), p]));
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // previous cycle still in flight
    this.running = true;
    try {
      await this.runCycle();
    } catch (err) {
      console.error('[matcher] cycle failed', err);
    } finally {
      this.running = false;
    }
  }

  /** One matching cycle: expire stale intents, then plan and submit a batch per active pair */
  async runCycle(): Promise<BatchPlan[]> {
    const { mempool, quoter, submitter } = this.deps;
    const nowMs = (this.deps.now ?? Date.now)();
    mempool.expire();

    const plans: BatchPlan[] = [];
    if (submitter.isAvailable && !submitter.isAvailable()) return plans;
    for (const key of mempool.activePairs()) {
      const pair = this.pairsByKey.get(key);
      if (!pair) continue;

      let plan: BatchPlan | null;
      try {
        plan = await planBatch(pair.tokenA, pair.tokenB, mempool.pending(key), quoter, {
          nowSec: Math.floor(nowMs / 1000),
          deadlineBufferSec: this.deps.deadlineBufferSec,
        });
      } catch (err) {
        console.error(`[matcher] ${pair.name}: planning failed`, err);
        continue;
      }
      if (!plan) continue;

      for (const { intent, reason } of plan.excluded) intent.lastExclusion = reason;
      for (const intent of plan.intents) {
        mempool.setStatus(intent.id, 'matched', { expectedOut: plan.expectedOut.get(intent.id), lastExclusion: undefined });
      }
      plans.push(plan);

      try {
        await submitter.submit(plan);
      } catch (err) {
        console.error(`[matcher] ${pair.name}: submission failed`, err);
        for (const intent of plan.intents) {
          if (intent.status === 'matched') mempool.setStatus(intent.id, 'pending');
        }
      }
    }
    return plans;
  }
}
