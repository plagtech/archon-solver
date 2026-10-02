import type { LogDescription } from 'ethers';
import type { Config, PairConfig } from './config.js';
import { type Mempool, pairKey } from './engine/mempool.js';
import type { PairKey } from './types/intent.js';

const ONE = 10n ** 18n;
/** Match rates are reported to 6 decimal places */
const RATE_SCALE = 1_000_000n;

/**
 * GET /stats response. In-memory since process start: everything resets on restart.
 * Amounts are decimal strings in base units; rates are fractions in [0, 1].
 * Batch, gas and volume figures come from the submitter's receipt poll (confirmPollMs), so they
 * can trail intent statuses, which the event listener updates from logs, by a few seconds.
 * Mirrored by SolverStats in @plagtech/archon-sdk — keep the two in sync.
 */
export interface SolverStats {
  solver: { address: string; chainId: number };
  uptime: {
    /** ISO timestamp of process start */
    startedAt: string;
    /** ISO timestamp of this response */
    now: string;
    seconds: number;
  };
  intents: {
    /** Accepted by POST /intent (rejected submissions are not counted) */
    received: number;
    settled: number;
    /** Settled intents filled at least partly peer-to-peer (coincidence of wants) */
    matched: number;
    /** Settled intents filled at least partly through the pool (one split between both counts in both) */
    routedThroughPool: number;
    refunded: number;
    expired: number;
    failed: number;
  };
  mempool: {
    /** Waiting to be batched */
    pending: number;
    /** In a batch being submitted or awaiting confirmation (matched + settling) */
    inFlight: number;
    /** Every configured pair, by pair name */
    byPair: Record<string, { pending: number; inFlight: number }>;
  };
  volume: {
    /** CoW volume / settled volume across all pairs; null until something settles, or if pairs use different quote tokens */
    matchRate: number | null;
    /** Volumes in the pair's quote token (its first symbol, e.g. USDC for "USDC/DAI") at each batch's clearing price */
    byPair: Record<
      string,
      { quoteToken: string; settled: string; matched: string; routedThroughPool: string; matchRate: number | null }
    >;
  };
  settlement: {
    /** settleBatch transactions broadcast (fee-bump replacements of the same batch count once) */
    batchesSubmitted: number;
    batchesSettled: number;
    /** Mined but reverted (no intent filled; gas still spent) */
    batchesReverted: number;
    gasUsed: string;
    /** gasUsed × effective gas price, wei */
    gasSpentWei: string;
    /** ISO timestamp of the last confirmed batch */
    lastSettlement: string | null;
    /** Mean time from POST /intent to settlement */
    averageSettlementMs: number | null;
  };
}

interface PairVolume {
  settled: bigint;
  matched: bigint;
}

interface PairInfo {
  name: string;
  quoteToken: string;
  /** Whether the quote token is the pair's tokenA (the lower address) */
  quoteIsA: boolean;
}

/**
 * Collects solver statistics from the mempool's status changes and the submitter's own
 * settlement receipts. Only batches this solver submitted are counted.
 */
export class StatsCollector {
  private readonly startedAt: number;
  private readonly pairs = new Map<PairKey, PairInfo>();
  private readonly volume = new Map<PairKey, PairVolume>();
  private readonly intents = { received: 0, settled: 0, matched: 0, routedThroughPool: 0, refunded: 0, expired: 0, failed: 0 };
  private batchesSubmitted = 0;
  private batchesSettled = 0;
  private batchesReverted = 0;
  private gasUsed = 0n;
  private gasSpentWei = 0n;
  private lastSettlement: number | undefined;
  private settlementMsTotal = 0;

  constructor(
    private readonly config: Pick<Config, 'chainId' | 'pairs' | 'tokens'>,
    private readonly solverAddress: string,
    private readonly mempool: Mempool,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
    for (const pair of config.pairs) this.pairs.set(pairKey(pair.tokenA, pair.tokenB), this.describe(pair));

    mempool.onStatusChange((intent, from) => {
      if (from === null) {
        this.intents.received++;
        return;
      }
      switch (intent.status) {
        case 'settled':
          this.intents.settled++;
          this.settlementMsTotal += this.now() - intent.receivedAt;
          break;
        case 'refunded':
          this.intents.refunded++;
          break;
        case 'expired':
          this.intents.expired++;
          break;
        case 'failed':
          this.intents.failed++;
          break;
      }
    });
  }

  /** A settleBatch transaction was broadcast */
  recordSubmitted(): void {
    this.batchesSubmitted++;
  }

  /**
   * A settleBatch transaction was mined. `logs` are its parsed IntentEngine logs. CoW vs pool
   * volume follows IntentEngine._clear: the side with excess volume sends `residualIn` through
   * the pool; everything else is matched peer-to-peer.
   */
  recordReceipt(receipt: { status: number; gasUsed: bigint; effectiveGasPrice: bigint }, logs: LogDescription[]): void {
    this.gasUsed += receipt.gasUsed;
    this.gasSpentWei += receipt.gasUsed * receipt.effectiveGasPrice;
    if (receipt.status !== 1) {
      this.batchesReverted++;
      return;
    }
    this.batchesSettled++;
    this.lastSettlement = this.now();

    const batch = logs.find((l) => l.name === 'BatchSettled');
    if (!batch) return;
    const tokenA = (batch.args.tokenA as string).toLowerCase();
    const price = batch.args.price as bigint;
    const sellA = batch.args.sellA as bigint;
    const sellB = batch.args.sellB as bigint;
    const residualIn = batch.args.residualIn as bigint;
    const residualIsA = batch.args.residualIsA as boolean;

    // Per intent: which side of the clearing it sat on
    for (const fill of logs) {
      if (fill.name !== 'IntentFilled' || fill.args.batchId !== batch.args.batchId) continue;
      const sellsA = (fill.args.tokenIn as string).toLowerCase() === tokenA;
      const sideTotal = sellsA ? sellA : sellB;
      const onResidualSide = residualIn > 0n && sellsA === residualIsA;
      if (onResidualSide) this.intents.routedThroughPool++;
      if (!onResidualSide || sideTotal > residualIn) this.intents.matched++;
    }

    const key = pairKey(batch.args.tokenA as string, batch.args.tokenB as string);
    const pair = this.pairs.get(key);
    if (!pair || price === 0n) return;
    const toQuote = (amount: bigint, isA: boolean) => {
      if (isA === pair.quoteIsA) return amount;
      return pair.quoteIsA ? (amount * ONE) / price : (amount * price) / ONE;
    };
    const settled = toQuote(sellA, true) + toQuote(sellB, false);
    const pooled = toQuote(residualIn, residualIsA);
    const v = this.volume.get(key) ?? { settled: 0n, matched: 0n };
    v.settled += settled;
    v.matched += settled > pooled ? settled - pooled : 0n;
    this.volume.set(key, v);
  }

  snapshot(): SolverStats {
    const now = this.now();
    const live = this.mempool.liveByPair();

    const mempoolByPair: SolverStats['mempool']['byPair'] = {};
    let pending = 0;
    let inFlight = 0;
    for (const [key, info] of this.pairs) {
      const counts = live.get(key) ?? { pending: 0, matched: 0, settling: 0 };
      const entry = { pending: counts.pending, inFlight: counts.matched + counts.settling };
      mempoolByPair[info.name] = entry;
      pending += entry.pending;
      inFlight += entry.inFlight;
    }

    const volumeByPair: SolverStats['volume']['byPair'] = {};
    let totalSettled = 0n;
    let totalMatched = 0n;
    for (const [key, info] of this.pairs) {
      const v = this.volume.get(key) ?? { settled: 0n, matched: 0n };
      volumeByPair[info.name] = {
        quoteToken: info.quoteToken,
        settled: v.settled.toString(),
        matched: v.matched.toString(),
        routedThroughPool: (v.settled - v.matched).toString(),
        matchRate: rate(v.matched, v.settled),
      };
      totalSettled += v.settled;
      totalMatched += v.matched;
    }
    const sharedQuote = new Set([...this.pairs.values()].map((p) => p.quoteToken)).size <= 1;

    return {
      solver: { address: this.solverAddress, chainId: this.config.chainId },
      uptime: {
        startedAt: new Date(this.startedAt).toISOString(),
        now: new Date(now).toISOString(),
        seconds: Math.floor((now - this.startedAt) / 1000),
      },
      intents: { ...this.intents },
      mempool: { pending, inFlight, byPair: mempoolByPair },
      volume: { matchRate: sharedQuote ? rate(totalMatched, totalSettled) : null, byPair: volumeByPair },
      settlement: {
        batchesSubmitted: this.batchesSubmitted,
        batchesSettled: this.batchesSettled,
        batchesReverted: this.batchesReverted,
        gasUsed: this.gasUsed.toString(),
        gasSpentWei: this.gasSpentWei.toString(),
        lastSettlement: this.lastSettlement === undefined ? null : new Date(this.lastSettlement).toISOString(),
        averageSettlementMs:
          this.intents.settled === 0 ? null : Math.round(this.settlementMsTotal / this.intents.settled),
      },
    };
  }

  private describe(pair: PairConfig): PairInfo {
    const quoteToken = pair.name.split('/')[0];
    const address = this.config.tokens.find((t) => t.symbol === quoteToken)?.address ?? pair.tokenA;
    return { name: pair.name, quoteToken, quoteIsA: address.toLowerCase() === pair.tokenA.toLowerCase() };
  }
}

function rate(part: bigint, whole: bigint): number | null {
  if (whole === 0n) return null;
  return Number((part * RATE_SCALE) / whole) / Number(RATE_SCALE);
}
