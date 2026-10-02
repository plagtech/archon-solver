import { describe, expect, it } from 'vitest';
import { Wallet, Interface } from 'ethers';
import { MatchingLoop, encodeSettleBatch, planBatch, type BatchPlan } from '../src/engine/matcher.js';
import { Mempool } from '../src/engine/mempool.js';
import { IntentEngineAbi } from '../src/chain/contracts.js';
import type { PairConfig } from '../src/config.js';
import { DAI, PARITY, USDC, VAULT_2, dai, makeIntent, mockQuoter, usdc } from './helpers.js';

const opts = { nowSec: 1_900_000_000, deadlineBufferSec: 6 };
const alice = Wallet.createRandom();
const bob = Wallet.createRandom();
const carol = Wallet.createRandom();

describe('planBatch', () => {
  it('matches opposing intents at spot price and routes only the residual through the pool', async () => {
    // A sells 1000 USDC for DAI, B sells 500 DAI for USDC (the CLAUDE.md example)
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1000) });
    const b = await makeIntent(bob, { tokenIn: DAI, tokenOut: USDC, amountIn: dai(500), vault: VAULT_2 });

    const plan = (await planBatch(DAI, USDC, [a, b], mockQuoter(PARITY), opts))!;

    expect(plan.intents.map((i) => i.id)).toEqual([a.id, b.id]);
    expect(plan.sellA).toBe(dai(500));
    expect(plan.sellB).toBe(usdc(1000));
    expect(plan.matchedA).toBe(dai(500));
    expect(plan.matchedB).toBe(usdc(500));
    expect(plan.residualIsA).toBe(false);
    expect(plan.quote.residualIn).toBe(usdc(500));
    // B is fully matched: exactly 500 USDC, no fee, no impact
    expect(plan.expectedOut.get(b.id)).toBe(usdc(500));
    // A gets 500 DAI from B plus the pool output for 500 USDC (4 bps fee)
    expect(plan.expectedOut.get(a.id)).toBe(dai(500) + dai(499.8));
  });

  it('settles a one-sided batch entirely through the pool', async () => {
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(100) });
    const plan = (await planBatch(DAI, USDC, [a], mockQuoter(PARITY), opts))!;
    expect(plan.matchedA).toBe(0n);
    expect(plan.matchedB).toBe(0n);
    expect(plan.expectedOut.get(a.id)).toBe(dai(99.96));
  });

  it('splits a side pro-rata by amountIn', async () => {
    const a1 = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(300) });
    const a2 = await makeIntent(carol, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(100) });
    const b = await makeIntent(bob, { tokenIn: DAI, tokenOut: USDC, amountIn: dai(400), vault: VAULT_2 });

    const plan = (await planBatch(DAI, USDC, [a1, a2, b], mockQuoter(PARITY), opts))!;
    expect(plan.quote.residualIn).toBe(0n);
    expect(plan.expectedOut.get(a1.id)).toBe(dai(300));
    expect(plan.expectedOut.get(a2.id)).toBe(dai(100));
    expect(plan.expectedOut.get(b.id)).toBe(usdc(400));
  });

  it('excludes legs whose share misses minAmountOut and re-clears without them', async () => {
    // B demands more than parity; without B, A goes fully through the pool
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1000), minAmountOut: dai(990) });
    const b = await makeIntent(bob, {
      tokenIn: DAI,
      tokenOut: USDC,
      amountIn: dai(500),
      minAmountOut: usdc(501),
      vault: VAULT_2,
    });
    const quoter = mockQuoter(PARITY);

    const plan = (await planBatch(DAI, USDC, [a, b], quoter, opts))!;
    expect(plan.intents.map((i) => i.id)).toEqual([a.id]);
    expect(plan.excluded).toHaveLength(1);
    expect(plan.excluded[0].intent.id).toBe(b.id);
    expect(plan.excluded[0].reason).toMatch(/below minAmountOut/);
    expect(plan.expectedOut.get(a.id)).toBe(dai(999.6));
    expect(quoter.calls).toBe(2);
  });

  it('accounts for the Spraay fee the engine deducts from outputs', async () => {
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1000), minAmountOut: dai(999) });
    const b = await makeIntent(bob, { tokenIn: DAI, tokenOut: USDC, amountIn: dai(1000), vault: VAULT_2 });

    // Fully matched, but a 30 bps Spraay fee leaves ~997 DAI for A
    const plan = (await planBatch(DAI, USDC, [a, b], mockQuoter(PARITY, 4n, 30n), opts))!;
    expect(plan.intents.map((i) => i.id)).toEqual([b.id]);
  });

  it('returns null when nothing can be included', async () => {
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(10), minAmountOut: dai(11) });
    expect(await planBatch(DAI, USDC, [a], mockQuoter(PARITY), opts)).toBeNull();
  });

  it('skips intents whose deadline is inside the settlement buffer', async () => {
    const soon = await makeIntent(alice, {
      tokenIn: USDC,
      tokenOut: DAI,
      amountIn: usdc(10),
      deadline: opts.nowSec + 3,
    });
    const later = await makeIntent(bob, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(10), vault: VAULT_2 });
    const plan = (await planBatch(DAI, USDC, [soon, later], mockQuoter(PARITY), opts))!;
    expect(plan.intents.map((i) => i.id)).toEqual([later.id]);
    expect(plan.excluded[0].reason).toMatch(/deadline/);
  });

  it('orders a session key by nonce and holds back intents after a nonce gap', async () => {
    const n2 = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1), nonce: 2 });
    const n0 = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1), nonce: 0 });
    const n4 = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1), nonce: 4 });
    const n1 = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1), nonce: 1 });

    const plan = (await planBatch(DAI, USDC, [n2, n0, n4, n1], mockQuoter(PARITY), opts))!;
    expect(plan.intents.map((i) => i.nonce)).toEqual([0, 1, 2]);
    expect(plan.excluded.map((e) => [e.intent.nonce, e.reason])).toEqual([[4, 'waiting for nonce 3']]);
  });

  it('drops later nonces of a session key when an earlier one is excluded', async () => {
    const n0 = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1), minAmountOut: dai(5) });
    const n1 = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1), nonce: 1 });
    const other = await makeIntent(bob, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1), vault: VAULT_2 });

    const plan = (await planBatch(DAI, USDC, [n0, n1, other], mockQuoter(PARITY), opts))!;
    expect(plan.intents.map((i) => i.id)).toEqual([other.id]);
    expect(plan.excluded.find((e) => e.intent.id === n1.id)?.reason).toMatch(/earlier nonce/);
  });

  it('caps the batch size', async () => {
    const intents = await Promise.all(
      [0, 1, 2].map((nonce) => makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1), nonce })),
    );
    const plan = (await planBatch(DAI, USDC, intents, mockQuoter(PARITY), { ...opts, maxBatchSize: 2 }))!;
    expect(plan.intents).toHaveLength(2);
    expect(plan.excluded.map((e) => e.reason)).toEqual(['batch full']);
  });

  it('encodes settleBatch calldata the engine ABI can decode', async () => {
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1000) });
    const plan = (await planBatch(DAI, USDC, [a], mockQuoter(PARITY), opts)) as BatchPlan;
    const iface = new Interface(IntentEngineAbi);
    const decoded = iface.decodeFunctionData('settleBatch', encodeSettleBatch(iface, plan));
    expect(decoded[0]).toBe(DAI);
    expect(decoded[1]).toBe(USDC);
    expect(decoded[2][0].vault).toBe(a.vault);
    expect(decoded[2][0].amountIn).toBe(a.amountIn);
    expect(decoded[2][0].signature).toBe(a.signature);
  });
});

describe('MatchingLoop', () => {
  const pair: PairConfig = { name: 'USDC/DAI', pool: '0x98B17F4615a5c32C7e3B0b91ba46445f3b582B40', type: 'stable', tokenA: DAI, tokenB: USDC };

  it('marks planned intents matched and hands the plan to the submitter', async () => {
    const mempool = new Mempool(() => opts.nowSec * 1000);
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(10) });
    mempool.add(a);

    const submitted: BatchPlan[] = [];
    const loop = new MatchingLoop({
      mempool,
      pairs: [pair],
      quoter: mockQuoter(PARITY),
      submitter: { submit: async (p) => void submitted.push(p) },
      intervalMs: 1000,
      deadlineBufferSec: 6,
      now: () => opts.nowSec * 1000,
    });

    await loop.runCycle();
    expect(submitted).toHaveLength(1);
    expect(mempool.get(a.id)?.status).toBe('matched');
    expect(mempool.get(a.id)?.expectedOut).toBe(dai(9.996));
    // Matched intents are not re-planned
    await loop.runCycle();
    expect(submitted).toHaveLength(1);
  });

  it('returns intents to pending when submission throws', async () => {
    const mempool = new Mempool(() => opts.nowSec * 1000);
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(10) });
    mempool.add(a);
    const loop = new MatchingLoop({
      mempool,
      pairs: [pair],
      quoter: mockQuoter(PARITY),
      submitter: {
        submit: async () => {
          throw new Error('rpc down');
        },
      },
      intervalMs: 1000,
      deadlineBufferSec: 6,
      now: () => opts.nowSec * 1000,
    });
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      await loop.runCycle();
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(1);
    expect(mempool.get(a.id)?.status).toBe('pending');
  });
});
