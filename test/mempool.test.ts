import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { DuplicateIntentError, Mempool, pairKey } from '../src/engine/mempool.js';
import { DAI, USDC, WETH, makeIntent, usdc } from './helpers.js';

const key = Wallet.createRandom();

describe('Mempool', () => {
  it('groups intents by sorted pair regardless of direction', async () => {
    const pool = new Mempool();
    const a = pool.add(await makeIntent(key, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1) }));
    const b = pool.add(await makeIntent(key, { tokenIn: DAI, tokenOut: USDC, amountIn: 1n, nonce: 1 }));
    pool.add(await makeIntent(key, { tokenIn: USDC, tokenOut: WETH, amountIn: usdc(1), nonce: 2 }));

    expect(pairKey(USDC, DAI)).toBe(pairKey(DAI, USDC));
    expect(pool.activePairs()).toHaveLength(2);
    expect(pool.pending(pairKey(DAI, USDC)).map((i) => i.id)).toEqual([a.id, b.id]);
    expect(pool.pendingCount()).toBe(3);
  });

  it('rejects duplicates and a second live intent on the same nonce', async () => {
    const pool = new Mempool();
    const a = await makeIntent(key, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1) });
    pool.add(a);
    expect(() => pool.add(a)).toThrow(DuplicateIntentError);

    const sameNonce = await makeIntent(key, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(2) });
    expect(() => pool.add(sameNonce)).toThrow(/nonce/);

    // Once the first is finished, its nonce can be reused by a new intent
    pool.setStatus(a.id, 'failed');
    expect(() => pool.add(sameNonce)).not.toThrow();
  });

  it('expires intents past their deadline and forgets finished ones after retention', async () => {
    let now = 1_000_000_000;
    const pool = new Mempool(() => now, 60_000);
    const a = pool.add(
      await makeIntent(key, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1), deadline: now / 1000 + 10 }),
    );

    expect(pool.expire()).toEqual([]);
    now += 10_000;
    expect(pool.expire().map((i) => i.id)).toEqual([a.id]);
    expect(pool.get(a.id)?.status).toBe('expired');
    expect(pool.activePairs()).toEqual([]);

    now += 61_000;
    pool.expire();
    expect(pool.get(a.id)).toBeUndefined();
  });

  it('only returns pending intents to the matcher', async () => {
    const pool = new Mempool();
    const a = pool.add(await makeIntent(key, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1) }));
    pool.setStatus(a.id, 'settling');
    expect(pool.pending(pairKey(USDC, DAI))).toEqual([]);
    expect(pool.activePairs()).toEqual([]);
  });
});
