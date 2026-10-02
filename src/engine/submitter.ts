import type { Interface } from 'ethers';
import type { Mempool } from './mempool.js';
import { type BatchPlan, type BatchSubmitter, encodeSettleBatch } from './matcher.js';
import { applyEngineLog } from './settlement.js';
import { type ParsedError, parseError, revertPolicy } from '../chain/errors.js';
import type { NonceManager } from '../chain/nonce.js';
import type { SettleTx, SolverChain, TxFees, TxReceiptInfo, VaultLegState } from '../chain/solver-chain.js';
import type { PendingIntent } from '../types/intent.js';

export interface SubmitterOptions {
  /** Gas limit = estimate × gasBufferNum / gasBufferDen (default 3/2) */
  gasBufferNum?: bigint;
  gasBufferDen?: bigint;
  /** Broadcast attempts per batch (nonce resyncs and transient errors) */
  maxSendAttempts?: number;
  /** Unattributable failures an intent may take before it is marked failed */
  maxIntentAttempts?: number;
  /** How long to stop submitting after a configuration error or empty gas wallet */
  pauseMs?: number;
  confirmPollMs?: number;
  /** Rebroadcast with bumped fees if not mined within this long */
  replaceAfterMs?: number;
  maxReplacements?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface LegProblem {
  /** Fatal problems fail the intent; others return it to pending */
  fatal: boolean;
  reason: string;
}

interface InFlight {
  plan: BatchPlan;
  tx: SettleTx;
  hashes: string[];
  lastBroadcast: number;
  replacements: number;
}

const FEE_BUMP_NUM = 125n; // replacements need ≥ 10% higher fees; use 25%
const FEE_BUMP_DEN = 100n;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Submits batch plans to IntentEngine.settleBatch.
 *
 *   1. Simulate the call. A revert is a batch precondition failure (per-leg failures never
 *      revert — the engine skips or refunds them). If fewer legs would fill than planned,
 *      read the vaults to find the bad legs and drop them before spending gas.
 *   2. Estimate gas and add a 1.5× buffer.
 *   3. Sign locally with a managed nonce and broadcast. Nonce rejections resync and retry;
 *      transient errors back off and retry; if a broadcast errors but the node knows the tx
 *      hash, it went through.
 *   4. Monitor for the receipt in the background, rebroadcasting with bumped fees if the tx
 *      sits unmined. The receipt's IntentFilled / IntentRefunded / IntentSkipped logs set
 *      each intent's final status.
 *
 * Calls are serialized, so nonces are allocated and broadcast in order.
 */
export class SettlementSubmitter implements BatchSubmitter {
  /** When the last batch confirmed on-chain */
  lastSettlement?: Date;
  batchesSettled = 0;

  private readonly opts: Required<SubmitterOptions>;
  private pausedUntil = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly chain: SolverChain,
    private readonly nonces: NonceManager,
    private readonly mempool: Mempool,
    private readonly engine: Interface,
    private readonly engineAddress: string,
    options: SubmitterOptions = {},
  ) {
    this.opts = {
      gasBufferNum: 3n,
      gasBufferDen: 2n,
      maxSendAttempts: 4,
      maxIntentAttempts: 3,
      pauseMs: 60_000,
      confirmPollMs: 2_000,
      replaceAfterMs: 30_000,
      maxReplacements: 3,
      now: Date.now,
      sleep: defaultSleep,
      ...options,
    };
  }

  isAvailable(): boolean {
    return this.opts.now() >= this.pausedUntil;
  }

  submit(plan: BatchPlan): Promise<void> {
    const run = this.queue.then(() => this.submitNow(plan));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Resolves once every broadcast batch has a final outcome (used by tests and shutdown) */
  async drain(): Promise<void> {
    await this.queue;
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  private async submitNow(plan: BatchPlan): Promise<void> {
    const data = encodeSettleBatch(this.engine, plan);
    const label = `${plan.pair} (${plan.intents.length} intents)`;

    // 1. Simulate
    let filled: bigint;
    try {
      ({ filled } = await this.chain.simulateSettle(data));
    } catch (err) {
      return this.handleFailure(plan, parseError(err), 'simulation');
    }
    if (filled < BigInt(plan.intents.length)) {
      const problems = await this.diagnose(plan.intents);
      if (problems.size > 0) {
        console.warn(`[submitter] ${label}: dropping ${problems.size} legs that would not fill`);
        this.applyProblems(plan.intents, problems);
        this.requeue(plan.intents, 'batch re-planned without failing legs', false);
        return;
      }
      // Nothing visible explains it (e.g. a leg will trip its vault's circuit breaker, which
      // is the vault's safety working as intended). The engine handles it; proceed.
      console.warn(`[submitter] ${label}: simulation fills ${filled}; submitting anyway`);
    }

    // 2. Gas
    let gasLimit: bigint;
    let fees: TxFees;
    try {
      const estimate = await this.chain.estimateGas(data);
      gasLimit = (estimate * this.opts.gasBufferNum) / this.opts.gasBufferDen;
      fees = await this.chain.feeData();
    } catch (err) {
      return this.handleFailure(plan, parseError(err), 'gas estimation');
    }

    // 3. Sign + broadcast
    const sent = await this.broadcastWithRetry(plan, { data, gasLimit, nonce: -1, ...fees });
    if (!sent) return;

    for (const intent of plan.intents) {
      this.mempool.setStatus(intent.id, 'settling', { txHash: sent.hash });
    }
    console.log(`[submitter] ${label}: sent ${sent.hash} (nonce ${sent.tx.nonce}, gas limit ${gasLimit})`);

    // 4. Monitor in the background
    const monitor = this.monitor({
      plan,
      tx: sent.tx,
      hashes: [sent.hash],
      lastBroadcast: this.opts.now(),
      replacements: 0,
    }).catch((err) => console.error(`[submitter] monitor for ${sent.hash} crashed`, err));
    this.inFlight.add(monitor);
    void monitor.finally(() => this.inFlight.delete(monitor));
  }

  private async broadcastWithRetry(
    plan: BatchPlan,
    unsigned: SettleTx,
  ): Promise<{ tx: SettleTx; hash: string } | null> {
    let lastError: ParsedError | undefined;
    for (let attempt = 0; attempt < this.opts.maxSendAttempts; attempt++) {
      const tx = { ...unsigned, nonce: await this.nonces.allocate() };
      const { raw, hash } = await this.chain.sign(tx);
      try {
        await this.chain.broadcast(raw);
        return { tx, hash };
      } catch (err) {
        if (await this.chain.knowsTransaction(hash).catch(() => false)) return { tx, hash };
        lastError = parseError(err);
        switch (lastError.kind) {
          case 'nonce':
          case 'underpriced': // a tx we don't know about holds this nonce
            console.warn(`[submitter] nonce ${tx.nonce} rejected (${lastError.message}); resyncing`);
            await this.nonces.resync();
            continue;
          case 'transient':
            this.nonces.release(tx.nonce);
            await this.opts.sleep(1_000 * 2 ** attempt);
            continue;
          case 'funds':
            this.nonces.release(tx.nonce);
            this.pause(`solver ${this.chain.solverAddress} cannot pay for gas`);
            this.requeue(plan.intents, 'solver out of gas funds', false);
            return null;
          default:
            this.nonces.release(tx.nonce);
            await this.handleFailure(plan, lastError, 'broadcast');
            return null;
        }
      }
    }
    console.error(`[submitter] broadcast failed after ${this.opts.maxSendAttempts} attempts: ${lastError?.message}`);
    this.requeue(plan.intents, `broadcast failed: ${lastError?.message ?? 'unknown error'}`, true);
    return null;
  }

  private async monitor(flight: InFlight): Promise<void> {
    const lastDeadline = Math.max(...flight.plan.intents.map((i) => i.deadline));
    let nonceConsumedPolls = 0;

    while (true) {
      await this.opts.sleep(this.opts.confirmPollMs);

      for (const hash of flight.hashes) {
        const receipt = await this.chain.receipt(hash).catch(() => null);
        if (receipt) return this.finalize(flight, hash, receipt);
      }

      // Our nonce was mined but by none of our hashes (e.g. a manual tx from the solver key).
      // Require two polls in a row to allow for receipt indexing lag.
      const confirmed = await this.nonces.confirmed().catch(() => 0);
      nonceConsumedPolls = confirmed > flight.tx.nonce ? nonceConsumedPolls + 1 : 0;
      if (nonceConsumedPolls >= 2) {
        console.error(`[submitter] nonce ${flight.tx.nonce} was used by another transaction`);
        this.requeue(this.live(flight.plan.intents), 'settlement transaction was replaced', true);
        return;
      }

      // Past every deadline the vaults reject the legs, so the tx can no longer fill anything
      if (Math.floor(this.opts.now() / 1000) > lastDeadline + 60) {
        for (const intent of this.live(flight.plan.intents)) {
          this.mempool.setStatus(intent.id, 'expired', { lastExclusion: 'settlement tx not mined before deadline' });
        }
        return;
      }

      if (
        this.opts.now() - flight.lastBroadcast >= this.opts.replaceAfterMs &&
        flight.replacements < this.opts.maxReplacements
      ) {
        await this.replace(flight);
      }
    }
  }

  /** Rebroadcast the same nonce with higher fees */
  private async replace(flight: InFlight): Promise<void> {
    const current = await this.chain.feeData().catch(() => flight.tx);
    const bump = (old: bigint, now: bigint) => {
      const bumped = (old * FEE_BUMP_NUM) / FEE_BUMP_DEN;
      return bumped > now ? bumped : now;
    };
    const tx: SettleTx = {
      ...flight.tx,
      maxFeePerGas: bump(flight.tx.maxFeePerGas, current.maxFeePerGas),
      maxPriorityFeePerGas: bump(flight.tx.maxPriorityFeePerGas, current.maxPriorityFeePerGas),
    };
    flight.replacements++;
    flight.lastBroadcast = this.opts.now();

    const { raw, hash } = await this.chain.sign(tx);
    try {
      await this.chain.broadcast(raw);
    } catch (err) {
      const parsed = parseError(err);
      // 'nonce' means the original was just mined; the next poll picks up its receipt.
      // 'underpriced' means the bump wasn't enough; the next replacement bumps again.
      if (parsed.kind !== 'nonce' && parsed.kind !== 'underpriced') {
        console.warn(`[submitter] replacement for nonce ${tx.nonce} failed: ${parsed.message}`);
      }
      if (parsed.kind === 'underpriced') flight.tx = tx;
      return;
    }
    flight.tx = tx;
    flight.hashes.push(hash);
    for (const intent of this.live(flight.plan.intents)) this.mempool.setStatus(intent.id, 'settling', { txHash: hash });
    console.log(`[submitter] replaced nonce ${tx.nonce} with ${hash} (attempt ${flight.replacements})`);
  }

  private async finalize(flight: InFlight, hash: string, receipt: TxReceiptInfo): Promise<void> {
    const { plan } = flight;
    if (receipt.status !== 1) {
      // The whole tx reverted, so no vault was touched and every intent can be retried
      const parsed = parseError(await this.chain.replay(flight.tx.data, receipt.blockNumber));
      console.error(`[submitter] ${hash} reverted on-chain: ${parsed.message}`);
      return this.handleFailure(plan, parsed, 'execution');
    }

    const engine = this.engineAddress.toLowerCase();
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== engine) continue;
      const parsed = this.engine.parseLog(log);
      if (parsed) applyEngineLog(this.mempool, parsed, hash);
    }
    for (const intent of this.live(plan.intents)) {
      this.mempool.setStatus(intent.id, 'failed', { txHash: hash, lastExclusion: 'not reported in settlement logs' });
    }
    this.lastSettlement = new Date(this.opts.now());
    this.batchesSettled++;
    console.log(`[submitter] ${hash} settled in block ${receipt.blockNumber}`);
  }

  /** React to a whole-batch failure (simulation, estimation, broadcast or on-chain revert) */
  private async handleFailure(plan: BatchPlan, error: ParsedError, stage: string): Promise<void> {
    const intents = this.live(plan.intents);
    const reason = `${stage} failed: ${error.message}`;

    if (error.kind === 'transient') {
      this.requeue(intents, reason, false);
      return;
    }
    if (error.kind === 'funds') {
      this.pause(`solver ${this.chain.solverAddress} cannot pay for gas`);
      this.requeue(intents, reason, false);
      return;
    }

    switch (revertPolicy(error)) {
      case 'config':
        this.pause(reason);
        this.requeue(intents, reason, false);
        return;
      case 'pool':
        this.requeue(intents, reason, false);
        return;
      case 'invalid':
        console.error(`[submitter] ${plan.pair}: invalid batch: ${reason}`);
        for (const intent of intents) this.mempool.setStatus(intent.id, 'failed', { lastExclusion: reason });
        return;
      default: {
        console.error(`[submitter] ${plan.pair}: ${reason}`);
        const problems = await this.diagnose(intents);
        this.applyProblems(intents, problems);
        this.requeue(intents, reason, problems.size === 0);
      }
    }
  }

  /** Read each leg's vault state and report legs the engine would skip */
  private async diagnose(intents: PendingIntent[]): Promise<Map<string, LegProblem>> {
    const states = new Map<string, VaultLegState>();
    try {
      await Promise.all(
        intents.map(async (i) =>
          states.set(i.id, await this.chain.vaultLegState(i.vault, i.sessionKey, i.tokenIn, i.tokenOut)),
        ),
      );
    } catch (err) {
      console.warn('[submitter] leg diagnosis failed', parseError(err).message);
      return new Map();
    }
    return diagnoseLegs(intents, states, Math.floor(this.opts.now() / 1000));
  }

  private applyProblems(intents: PendingIntent[], problems: Map<string, LegProblem>): void {
    for (const intent of intents) {
      const problem = problems.get(intent.id);
      if (!problem) continue;
      this.mempool.setStatus(intent.id, problem.fatal ? 'failed' : 'pending', {
        lastExclusion: problem.reason,
        txHash: undefined,
      });
    }
  }

  /** Return non-terminal intents to pending, optionally counting an attempt against them */
  private requeue(intents: PendingIntent[], reason: string, countAttempt: boolean): void {
    for (const intent of intents) {
      if (intent.status !== 'matched' && intent.status !== 'settling') continue;
      const attempts = (intent.attempts ?? 0) + (countAttempt ? 1 : 0);
      if (attempts >= this.opts.maxIntentAttempts) {
        this.mempool.setStatus(intent.id, 'failed', { attempts, lastExclusion: `${reason} (gave up after ${attempts} attempts)` });
      } else {
        this.mempool.setStatus(intent.id, 'pending', { attempts, lastExclusion: reason, txHash: undefined });
      }
    }
  }

  private live(intents: PendingIntent[]): PendingIntent[] {
    return intents.filter((i) => !this.mempool.isTerminal(i));
  }

  private pause(reason: string): void {
    this.pausedUntil = this.opts.now() + this.opts.pauseMs;
    console.error(`[submitter] pausing submissions for ${this.opts.pauseMs / 1000}s: ${reason}`);
  }
}

/**
 * Work out which legs AgentVault.executeBatchLeg would reject, given each leg's vault state.
 * Legs are checked in batch order so a session key's nonces and a vault's balance are
 * consumed cumulatively, as they are on-chain. Spending caps are deliberately not checked:
 * tripping the circuit breaker on a cap breach is the vault's safety mechanism working.
 */
export function diagnoseLegs(
  intents: PendingIntent[],
  states: Map<string, VaultLegState>,
  nowSec: number,
): Map<string, LegProblem> {
  const problems = new Map<string, LegProblem>();
  const nextNonce = new Map<string, bigint>();
  const blockedKeys = new Set<string>();
  const balances = new Map<string, bigint>();

  for (const intent of intents) {
    const state = states.get(intent.id);
    if (!state) continue;
    const key = `${intent.vault}:${intent.sessionKey}`.toLowerCase();
    const balanceKey = `${intent.vault}:${intent.tokenIn}`.toLowerCase();
    const fail = (reason: string) => problems.set(intent.id, { fatal: true, reason });

    if (blockedKeys.has(key)) {
      problems.set(intent.id, { fatal: false, reason: 'an earlier nonce from this session key cannot settle yet' });
      continue;
    }
    if (state.frozen) {
      fail('vault is frozen');
      continue;
    }
    if (!state.keyActive) {
      fail('session key is not active');
      continue;
    }
    if (!state.canBatchSwap) {
      fail('session key lacks the canBatchSwap permission');
      continue;
    }
    if (state.keyExpiry <= BigInt(nowSec)) {
      fail('session key has expired');
      continue;
    }
    if (!state.tokenInAllowed || !state.tokenOutAllowed) {
      fail('token is not on the vault allowlist');
      continue;
    }

    const expected = nextNonce.get(key) ?? state.keyNonce;
    const nonce = BigInt(intent.nonce);
    if (nonce < expected) {
      fail(`nonce ${nonce} already used`);
      continue;
    }
    if (nonce > expected) {
      blockedKeys.add(key);
      problems.set(intent.id, { fatal: false, reason: `waiting for nonce ${expected}` });
      continue;
    }

    const balance = balances.get(balanceKey) ?? state.balance;
    if (balance < intent.amountIn) {
      fail(`vault balance ${balance} is below amountIn`);
      continue;
    }
    balances.set(balanceKey, balance - intent.amountIn);
    nextNonce.set(key, expected + 1n);
  }
  return problems;
}
