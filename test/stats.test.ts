import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Interface, Wallet, type LogDescription } from 'ethers';
import { createApp } from '../src/api/routes.js';
import { IntentEngineAbi } from '../src/chain/contracts.js';
import type { Market } from '../src/chain/market.js';
import type { Config } from '../src/config.js';
import { Mempool } from '../src/engine/mempool.js';
import { StatsCollector } from '../src/stats.js';
import type { PendingIntent } from '../src/types/intent.js';
import { DAI, PARITY, USDC, VAULT_2, WETH, dai, makeIntent, usdc } from './helpers.js';

const SOLVER = '0x5050505050505050505050505050505050505050';
const engine = new Interface(IntentEngineAbi);
const alice = Wallet.createRandom();
const bob = Wallet.createRandom();

const config = {
  chainId: 8453,
  matchIntervalMs: 3000,
  tokens: [
    { symbol: 'USDC', address: USDC, decimals: 6 },
    { symbol: 'DAI', address: DAI, decimals: 18 },
    { symbol: 'WETH', address: WETH, decimals: 18 },
  ],
  pairs: [
    { name: 'USDC/DAI', pool: '0x98B17F4615a5c32C7e3B0b91ba46445f3b582B40', type: 'stable', tokenA: DAI, tokenB: USDC },
    { name: 'USDC/WETH', pool: '0xEed7535E76Ac2ddF8bb649007d28A30b8f3B2CD8', type: 'volatile', tokenA: WETH, tokenB: USDC },
  ],
} as unknown as Config;

/** Parsed IntentEngine log, as the submitter hands it over */
function engineLog(name: string, args: unknown[]): LogDescription {
  const { topics, data } = engine.encodeEventLog(name, args);
  return engine.parseLog({ topics, data })!;
}

const filled = (batchId: bigint, intent: PendingIntent, amountOut: bigint) =>
  engineLog('IntentFilled', [batchId, intent.vault, intent.sessionKey, intent.nonce, intent.tokenIn, intent.amountIn, amountOut]);

/** BatchSettled(batchId, tokenA, tokenB, price, sellA, sellB, residualIn, residualOut, residualIsA, filled) */
const batchSettled = (batchId: bigint, sellA: bigint, sellB: bigint, residualIn: bigint, residualIsA: boolean, n: bigint) =>
  engineLog('BatchSettled', [batchId, DAI, USDC, PARITY, sellA, sellB, residualIn, residualIn, residualIsA, n]);

describe('StatsCollector', () => {
  let clock: number;
  let mempool: Mempool;
  let stats: StatsCollector;

  beforeEach(() => {
    clock = Date.parse('2026-10-01T12:00:00Z');
    mempool = new Mempool(() => clock);
    stats = new StatsCollector(config, SOLVER, mempool, () => clock);
  });

  it('starts empty, with every configured pair listed', () => {
    clock += 90_500;
    const s = stats.snapshot();
    expect(s.solver).toEqual({ address: SOLVER, chainId: 8453 });
    expect(s.uptime).toEqual({ startedAt: '2026-10-01T12:00:00.000Z', now: '2026-10-01T12:01:30.500Z', seconds: 90 });
    expect(s.intents).toEqual({ received: 0, settled: 0, matched: 0, routedThroughPool: 0, refunded: 0, expired: 0, failed: 0 });
    expect(s.mempool).toEqual({
      pending: 0,
      inFlight: 0,
      byPair: { 'USDC/DAI': { pending: 0, inFlight: 0 }, 'USDC/WETH': { pending: 0, inFlight: 0 } },
    });
    expect(s.volume.matchRate).toBeNull();
    expect(s.volume.byPair['USDC/DAI']).toEqual({ quoteToken: 'USDC', settled: '0', matched: '0', routedThroughPool: '0', matchRate: null });
    expect(s.settlement).toEqual({
      batchesSubmitted: 0,
      batchesSettled: 0,
      batchesReverted: 0,
      gasUsed: '0',
      gasSpentWei: '0',
      lastSettlement: null,
      averageSettlementMs: null,
    });
  });

  it('tracks mempool depth by pair and lifecycle counts', async () => {
    const a = mempool.add(await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(10) }));
    const b = mempool.add(await makeIntent(bob, { tokenIn: DAI, tokenOut: USDC, amountIn: dai(5), vault: VAULT_2 }));
    const c = mempool.add(await makeIntent(alice, { tokenIn: USDC, tokenOut: WETH, amountIn: usdc(1), nonce: 1 }));
    mempool.setStatus(b.id, 'matched');
    let s = stats.snapshot();
    expect(s.intents.received).toBe(3);
    expect(s.mempool).toEqual({
      pending: 2,
      inFlight: 1,
      byPair: { 'USDC/DAI': { pending: 1, inFlight: 1 }, 'USDC/WETH': { pending: 1, inFlight: 0 } },
    });

    clock += 4_000;
    mempool.setStatus(b.id, 'settling');
    mempool.setStatus(b.id, 'settled');
    mempool.setStatus(a.id, 'expired');
    mempool.setStatus(c.id, 'refunded');
    s = stats.snapshot();
    expect(s.intents).toMatchObject({ received: 3, settled: 1, refunded: 1, expired: 1, failed: 0 });
    expect(s.mempool.pending + s.mempool.inFlight).toBe(0);
    expect(s.settlement.averageSettlementMs).toBe(clock - b.receivedAt);
  });

  it('splits CoW vs pool volume exactly as IntentEngine._clear does', async () => {
    // Batch 0: bob sells 50 DAI (tokenA), alice sells 100 USDC (tokenB) at parity.
    // B side has the excess: residualIn = 100 − 50 = 50 USDC through the pool.
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(100) });
    const b = await makeIntent(bob, { tokenIn: DAI, tokenOut: USDC, amountIn: dai(50), vault: VAULT_2 });
    stats.recordSubmitted();
    stats.recordReceipt({ status: 1, gasUsed: 200_000n, effectiveGasPrice: 3n }, [
      filled(0n, a, dai(99.9)),
      filled(0n, b, usdc(49.9)),
      batchSettled(0n, dai(50), usdc(100), usdc(50), false, 2n),
    ]);
    let s = stats.snapshot();
    // bob is on the fully matched side; alice is half matched, half pool
    expect(s.intents).toMatchObject({ matched: 2, routedThroughPool: 1 });
    expect(s.volume.byPair['USDC/DAI']).toEqual({
      quoteToken: 'USDC',
      settled: usdc(150).toString(), // 50 DAI ≈ 50 USDC + 100 USDC
      matched: usdc(100).toString(), // both matched sides: 50 + 50
      routedThroughPool: usdc(50).toString(),
      matchRate: 0.666666,
    });

    // Batch 1: a lone 10 USDC seller — nothing to match, all through the pool
    const lone = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(10), nonce: 1 });
    stats.recordSubmitted();
    stats.recordReceipt({ status: 1, gasUsed: 100_000n, effectiveGasPrice: 5n }, [
      filled(1n, lone, dai(9.9)),
      batchSettled(1n, 0n, usdc(10), usdc(10), false, 1n),
    ]);
    // Batch 2: mined but reverted — gas is still spent
    stats.recordSubmitted();
    clock += 1_000;
    stats.recordReceipt({ status: 0, gasUsed: 50_000n, effectiveGasPrice: 4n }, []);

    s = stats.snapshot();
    expect(s.intents).toMatchObject({ matched: 2, routedThroughPool: 2 });
    expect(s.volume.byPair['USDC/DAI']).toMatchObject({ settled: usdc(160).toString(), matched: usdc(100).toString() });
    expect(s.volume.matchRate).toBe(0.625);
    expect(s.settlement).toEqual({
      batchesSubmitted: 3,
      batchesSettled: 2,
      batchesReverted: 1,
      gasUsed: '350000',
      gasSpentWei: (200_000n * 3n + 100_000n * 5n + 50_000n * 4n).toString(),
      lastSettlement: new Date(clock - 1_000).toISOString(),
      averageSettlementMs: null, // no mempool intent reached 'settled' in this test
    });
  });

  it('reports no overall match rate when pairs are quoted in different tokens', () => {
    const mixed = { ...config, pairs: [config.pairs[0], { ...config.pairs[1], name: 'WETH/USDC' }] } as Config;
    const s = new StatsCollector(mixed, SOLVER, mempool, () => clock);
    s.recordReceipt({ status: 1, gasUsed: 1n, effectiveGasPrice: 1n }, [batchSettled(0n, dai(1), usdc(1), 0n, true, 2n)]);
    expect(s.snapshot().volume.byPair['WETH/USDC'].quoteToken).toBe('WETH');
    expect(s.snapshot().volume.matchRate).toBeNull();
  });
});

describe('GET /stats', () => {
  let server: Server;
  let baseUrl: string;
  let mempool: Mempool;
  let stats: StatsCollector;

  beforeEach(async () => {
    mempool = new Mempool();
    stats = new StatsCollector(config, SOLVER, mempool);
    const app = createApp({ config, market: {} as Market, mempool, solverAddress: SOLVER, stats });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('returns the SolverStats shape', async () => {
    mempool.add(await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(1) }));
    const res = await fetch(`${baseUrl}/stats`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();

    const count = expect.any(Number);
    const amount = expect.stringMatching(/^\d+$/);
    const iso = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(body).toEqual({
      solver: { address: SOLVER, chainId: 8453 },
      uptime: { startedAt: iso, now: iso, seconds: count },
      intents: { received: 1, settled: 0, matched: 0, routedThroughPool: 0, refunded: 0, expired: 0, failed: 0 },
      mempool: {
        pending: 1,
        inFlight: 0,
        byPair: { 'USDC/DAI': { pending: 1, inFlight: 0 }, 'USDC/WETH': { pending: 0, inFlight: 0 } },
      },
      volume: {
        matchRate: null,
        byPair: {
          'USDC/DAI': { quoteToken: 'USDC', settled: amount, matched: amount, routedThroughPool: amount, matchRate: null },
          'USDC/WETH': { quoteToken: 'USDC', settled: amount, matched: amount, routedThroughPool: amount, matchRate: null },
        },
      },
      settlement: {
        batchesSubmitted: 0,
        batchesSettled: 0,
        batchesReverted: 0,
        gasUsed: amount,
        gasSpentWei: amount,
        lastSettlement: null,
        averageSettlementMs: null,
      },
    });
  });

  it('serializes amounts as decimal strings, never JSON numbers', async () => {
    const a = await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(100) });
    stats.recordReceipt({ status: 1, gasUsed: 10n ** 7n, effectiveGasPrice: 10n ** 12n }, [
      filled(0n, a, dai(99)),
      batchSettled(0n, 0n, usdc(100), usdc(100), false, 1n),
    ]);
    const body = await (await fetch(`${baseUrl}/stats`)).json();
    expect(body.settlement.gasSpentWei).toBe('10000000000000000000'); // 1e19 > 2^53
    expect(body.settlement.lastSettlement).not.toBeNull();
    expect(body.volume.byPair['USDC/DAI'].routedThroughPool).toBe('100000000');
  });
});
