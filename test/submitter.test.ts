import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Interface, Wallet, id } from 'ethers';
import { IntentEngineAbi, StablePoolAbi } from '../src/chain/contracts.js';
import { NonceManager } from '../src/chain/nonce.js';
import type { SettleTx, SolverChain, TxFees, TxReceiptInfo, VaultLegState } from '../src/chain/solver-chain.js';
import { planBatch, type BatchPlan } from '../src/engine/matcher.js';
import { Mempool } from '../src/engine/mempool.js';
import { SettlementSubmitter, diagnoseLegs } from '../src/engine/submitter.js';
import type { PendingIntent } from '../src/types/intent.js';
import { DAI, PARITY, USDC, VAULT, VAULT_2, dai, makeIntent, mockQuoter, usdc } from './helpers.js';

const ENGINE = '0xf8614FED7664B2505EfD04581f1417D8317648D8';
const engine = new Interface(IntentEngineAbi);
const alice = Wallet.createRandom();
const bob = Wallet.createRandom();
const NOW_SEC = 1_900_000_000;

function revert(name: string, args: unknown[] = [], iface = engine) {
  return Object.assign(new Error('execution reverted'), {
    code: 'CALL_EXCEPTION',
    data: iface.encodeErrorResult(name, args),
  });
}

const okState: VaultLegState = {
  frozen: false,
  keyActive: true,
  canBatchSwap: true,
  keyExpiry: BigInt(NOW_SEC + 86_400),
  keyNonce: 0n,
  balance: 10n ** 30n,
  tokenInAllowed: true,
  tokenOutAllowed: true,
};

/** Scriptable in-memory chain */
class FakeChain implements SolverChain {
  readonly solverAddress = '0x000000000000000000000000000000000000501a';
  pendingNonce = 5;
  latestNonce = 5;
  filled?: bigint;
  simulateError?: unknown;
  estimateError?: unknown;
  replayError: unknown = null;
  gasEstimate = 200_000n;
  fees: TxFees = { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n };
  /** Errors thrown by successive broadcasts (undefined = succeed) */
  broadcastErrors: unknown[] = [];
  known = new Set<string>();
  sent: SettleTx[] = [];
  receipts = new Map<string, TxReceiptInfo>();
  legStates = new Map<string, VaultLegState>();
  onBroadcast?: (tx: SettleTx, hash: string) => void;
  private signed = new Map<string, SettleTx>();

  async simulateSettle(data: string) {
    if (this.simulateError) throw this.simulateError;
    const [, , intents] = engine.decodeFunctionData('settleBatch', data);
    return { filled: this.filled ?? BigInt(intents.length) };
  }
  async estimateGas() {
    if (this.estimateError) throw this.estimateError;
    return this.gasEstimate;
  }
  async feeData() {
    return this.fees;
  }
  async sign(tx: SettleTx) {
    const hash = id(JSON.stringify(tx, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    this.signed.set(hash, tx);
    return { raw: hash, hash };
  }
  async broadcast(raw: string) {
    const error = this.broadcastErrors.shift();
    if (error) throw error;
    const tx = this.signed.get(raw)!;
    this.sent.push(tx);
    this.known.add(raw);
    this.onBroadcast?.(tx, raw);
  }
  async knowsTransaction(hash: string) {
    return this.known.has(hash);
  }
  async receipt(hash: string) {
    return this.receipts.get(hash) ?? null;
  }
  async replay() {
    return this.replayError;
  }
  async getTransactionCount(_address: string, tag: 'pending' | 'latest') {
    return tag === 'pending' ? this.pendingNonce : this.latestNonce;
  }
  async vaultLegState(vault: string) {
    return this.legStates.get(vault.toLowerCase()) ?? okState;
  }
}

function engineLog(name: string, intent: PendingIntent, extra: unknown[]) {
  const { topics, data } = engine.encodeEventLog(name, [1n, intent.vault, intent.sessionKey, BigInt(intent.nonce), ...extra]);
  return { address: ENGINE, topics, data };
}

function filledLog(intent: PendingIntent, amountOut: bigint) {
  return engineLog('IntentFilled', intent, [intent.tokenIn, intent.amountIn, amountOut]);
}

let clock: number;
let chain: FakeChain;
let mempool: Mempool;
let submitter: SettlementSubmitter;

function setup(options = {}) {
  clock = NOW_SEC * 1000;
  chain = new FakeChain();
  mempool = new Mempool(() => clock);
  submitter = new SettlementSubmitter(chain, new NonceManager(chain, chain.solverAddress), mempool, engine, ENGINE, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    ...options,
  });
}

/** Add intents to the mempool, plan them and mark them matched, as the matching loop does */
async function plan(...intents: PendingIntent[]): Promise<BatchPlan> {
  for (const i of intents) mempool.add(i);
  const p = (await planBatch(DAI, USDC, intents.map((i) => mempool.get(i.id)!), mockQuoter(PARITY), {
    nowSec: NOW_SEC,
    deadlineBufferSec: 6,
  }))!;
  for (const i of p.intents) mempool.setStatus(i.id, 'matched');
  return p;
}

const status = (i: PendingIntent) => mempool.get(i.id)?.status;

beforeEach(() => {
  setup();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('SettlementSubmitter', () => {
  it('sends with a 1.5x gas buffer and settles intents from the receipt logs', async () => {
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(100) });
    const b = await makeIntent(bob, { tokenIn: DAI, tokenOut: USDC, amountIn: dai(50), vault: VAULT_2 });
    chain.onBroadcast = (_tx, hash) =>
      chain.receipts.set(hash, {
        status: 1,
        blockNumber: 10,
        logs: [filledLog(a, dai(99.98)), engineLog('IntentRefunded', b, [b.tokenIn, b.amountIn])],
      });

    await submitter.submit(await plan(a, b));
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0].gasLimit).toBe(300_000n);
    expect(chain.sent[0].nonce).toBe(5);
    expect(status(a)).toBe('settling');

    await submitter.drain();
    expect(status(a)).toBe('settled');
    expect(mempool.get(a.id)?.amountOut).toBe(dai(99.98));
    expect(status(b)).toBe('refunded');
    expect(submitter.batchesSettled).toBe(1);
  });

  it('allocates consecutive nonces without re-reading the chain', async () => {
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1) });
    const b = await makeIntent(bob, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1), vault: VAULT_2 });
    const pa = await plan(a);
    const pb = await plan(b);
    await Promise.all([submitter.submit(pa), submitter.submit(pb)]);
    expect(chain.sent.map((t) => t.nonce)).toEqual([5, 6]);
  });

  it('resyncs the nonce and retries when the node rejects it', async () => {
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1) });
    chain.broadcastErrors = [Object.assign(new Error('nonce too low'), { code: 'NONCE_EXPIRED' })];
    const p = await plan(a);
    // Something else used nonce 5 meanwhile
    chain.onBroadcast = undefined;
    const original = chain.broadcast.bind(chain);
    chain.broadcast = async (raw) => {
      chain.pendingNonce = 6;
      return original(raw);
    };
    await submitter.submit(p);
    expect(chain.sent.map((t) => t.nonce)).toEqual([6]);
    expect(status(a)).toBe('settling');
  });

  it('treats a failed broadcast as sent when the node already has the tx', async () => {
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1) });
    const p = await plan(a);
    chain.broadcast = async (raw) => {
      chain.known.add(raw);
      throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
    };
    await submitter.submit(p);
    expect(status(a)).toBe('settling');
  });

  it('retries transient broadcast errors with the same nonce', async () => {
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1) });
    chain.broadcastErrors = [Object.assign(new Error('socket hang up'), { code: 'NETWORK_ERROR' })];
    await submitter.submit(await plan(a));
    expect(chain.sent.map((t) => t.nonce)).toEqual([5]);
  });

  it('pauses and requeues on a configuration revert like OnlySolver', async () => {
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1) });
    chain.simulateError = revert('OnlySolver');
    await submitter.submit(await plan(a));
    expect(chain.sent).toHaveLength(0);
    expect(status(a)).toBe('pending');
    expect(mempool.get(a.id)?.lastExclusion).toMatch(/OnlySolver/);
    expect(mempool.get(a.id)?.attempts ?? 0).toBe(0);
    expect(submitter.isAvailable()).toBe(false);
    clock += 60_000;
    expect(submitter.isAvailable()).toBe(true);
  });

  it('drops legs the vault would reject before spending gas', async () => {
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1) });
    const b = await makeIntent(bob, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1), vault: VAULT_2 });
    chain.filled = 1n;
    chain.legStates.set(VAULT_2.toLowerCase(), { ...okState, frozen: true });

    await submitter.submit(await plan(a, b));
    expect(chain.sent).toHaveLength(0);
    expect(status(b)).toBe('failed');
    expect(mempool.get(b.id)?.lastExclusion).toBe('vault is frozen');
    expect(status(a)).toBe('pending');
  });

  it('counts unattributable failures and gives up after the limit', async () => {
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1) });
    // A pool error bubbling up through the engine still decodes
    chain.estimateError = revert('InsufficientOutput', [1n, 2n], new Interface(StablePoolAbi));
    mempool.add(a);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const p = (await planBatch(DAI, USDC, mempool.pending(`${DAI.toLowerCase()}-${USDC.toLowerCase()}`), mockQuoter(PARITY), {
        nowSec: NOW_SEC,
        deadlineBufferSec: 6,
      }))!;
      for (const i of p.intents) mempool.setStatus(i.id, 'matched');
      await submitter.submit(p);
    }
    expect(status(a)).toBe('failed');
    expect(mempool.get(a.id)?.lastExclusion).toMatch(/InsufficientOutput\(1, 2\).*gave up after 3/);
  });

  it('fails the intents of a malformed batch', async () => {
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1) });
    chain.simulateError = revert('BatchTooLarge', [201n, 200n]);
    await submitter.submit(await plan(a));
    expect(status(a)).toBe('failed');
  });

  it('pauses when the solver cannot pay for gas', async () => {
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1) });
    chain.broadcastErrors = [Object.assign(new Error('insufficient funds for gas'), { code: 'INSUFFICIENT_FUNDS' })];
    await submitter.submit(await plan(a));
    expect(status(a)).toBe('pending');
    expect(submitter.isAvailable()).toBe(false);
  });

  it('replaces a stuck transaction with bumped fees', async () => {
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1) });
    let broadcasts = 0;
    chain.onBroadcast = (_tx, hash) => {
      if (++broadcasts === 2) chain.receipts.set(hash, { status: 1, blockNumber: 11, logs: [filledLog(a, dai(0.9996))] });
    };

    await submitter.submit(await plan(a));
    await submitter.drain();
    expect(chain.sent).toHaveLength(2);
    expect(chain.sent[1].nonce).toBe(chain.sent[0].nonce);
    expect(chain.sent[1].maxFeePerGas).toBe(1_250n);
    expect(chain.sent[1].maxPriorityFeePerGas).toBe(125n);
    expect(status(a)).toBe('settled');
    expect(mempool.get(a.id)?.txHash).toBe([...chain.receipts.keys()][0]);
  });

  it('requeues intents when the tx reverts on-chain', async () => {
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1) });
    chain.replayError = revert('RouterPaused');
    chain.onBroadcast = (_tx, hash) => chain.receipts.set(hash, { status: 0, blockNumber: 12, logs: [] });
    await submitter.submit(await plan(a));
    await submitter.drain();
    expect(status(a)).toBe('pending');
    expect(mempool.get(a.id)?.lastExclusion).toMatch(/execution failed: RouterPaused/);
  });

  it('marks intents expired if the tx never mines before their deadlines', async () => {
    setup({ maxReplacements: 0 });
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1), deadline: NOW_SEC + 30 });
    await submitter.submit(await plan(a));
    await submitter.drain();
    expect(status(a)).toBe('expired');
  });
});

describe('diagnoseLegs', () => {
  it('consumes nonces and balances cumulatively in batch order', async () => {
    const n0 = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(6) });
    const n1 = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(6), nonce: 1 });
    const n3 = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1), nonce: 3 });
    const used = await makeIntent(bob, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1), vault: VAULT_2 });
    const state = { ...okState, balance: usdc(10) };
    const states = new Map([
      [n0.id, state],
      [n1.id, state],
      [n3.id, state],
      [used.id, { ...okState, keyNonce: 1n }],
    ]);

    const problems = diagnoseLegs([n0, n1, n3, used], states, NOW_SEC);
    expect(problems.get(n0.id)).toBeUndefined();
    expect(problems.get(n1.id)).toEqual({ fatal: true, reason: `vault balance ${usdc(4)} is below amountIn` });
    expect(problems.get(n3.id)).toEqual({ fatal: false, reason: 'waiting for nonce 1' });
    expect(problems.get(used.id)).toEqual({ fatal: true, reason: 'nonce 0 already used' });
    expect(VAULT).not.toBe(VAULT_2);
  });
});
