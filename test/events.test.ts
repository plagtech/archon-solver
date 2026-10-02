import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Interface, Wallet, type Log } from 'ethers';
import { WebSocket } from 'ws';
import { AgentVaultAbi, IntentEngineAbi, StablePoolAbi } from '../src/chain/contracts.js';
import { ChainEventListener } from '../src/chain/events.js';
import type { Market } from '../src/chain/market.js';
import type { Config } from '../src/config.js';
import { Mempool } from '../src/engine/mempool.js';
import { EventBus, publishIntentEvents, type SolverEvent } from '../src/events.js';
import { attachWebSocket } from '../src/api/websocket.js';
import { DAI, USDC, VAULT, VAULT_2, dai, makeIntent, usdc } from './helpers.js';

const ENGINE = '0xf8614FED7664B2505EfD04581f1417D8317648D8';
const POOL = '0x98B17F4615a5c32C7e3B0b91ba46445f3b582B40';
const engine = new Interface(IntentEngineAbi);
const vaultIface = new Interface(AgentVaultAbi);
const pool = new Interface(StablePoolAbi);
const alice = Wallet.createRandom();

const config = {
  chainId: 8453,
  addresses: { engine: ENGINE, router: ENGINE, vaultFactory: ENGINE },
  tokens: [
    { symbol: 'USDC', address: USDC, decimals: 6 },
    { symbol: 'DAI', address: DAI, decimals: 18 },
  ],
  pairs: [{ name: 'USDC/DAI', pool: POOL, type: 'stable', tokenA: DAI, tokenB: USDC }],
} as unknown as Config;

let price = 10n ** 30n; // DAI priced in USDC, native units (1.0)
const market = {
  pairFor: () => config.pairs[0],
  token: (a: string) => config.tokens.find((t) => t.address.toLowerCase() === a.toLowerCase()),
  spotPrice: async () => price,
  formatPrice: (raw: bigint) => (Number(raw / 10n ** 26n) / 10_000).toFixed(4),
} as unknown as Market;

function log(address: string, iface: Interface, name: string, args: unknown[], blockNumber = 101): Log {
  const { topics, data } = iface.encodeEventLog(name, args);
  return { address, topics, data, blockNumber, transactionHash: '0x' + 'ab'.repeat(32), index: 0 } as unknown as Log;
}

class FakeProvider {
  block = 100;
  logs: Log[] = [];
  ranges: [number, number][] = [];
  async getBlockNumber() {
    return this.block;
  }
  async getLogs(filter: { fromBlock: number; toBlock: number }) {
    this.ranges.push([filter.fromBlock, filter.toBlock]);
    return this.logs.filter((l) => l.blockNumber >= filter.fromBlock && l.blockNumber <= filter.toBlock);
  }
}

describe('ChainEventListener', () => {
  let provider: FakeProvider;
  let mempool: Mempool;
  let bus: EventBus;
  let events: SolverEvent[];
  let listener: ChainEventListener;

  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    price = 10n ** 30n;
    provider = new FakeProvider();
    mempool = new Mempool();
    bus = new EventBus();
    events = [];
    bus.subscribe((e) => void events.push(e));
    publishIntentEvents(mempool, bus);
    listener = new ChainEventListener(provider, config, market, mempool, bus, { maxBlockRange: 10 });
    await listener.start();
    listener.stop(); // drive poll() by hand
  });

  it('settles mempool intents from engine logs and publishes batch.settled', async () => {
    const a = mempool.add(await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(10) }));
    mempool.setStatus(a.id, 'settling');
    provider.block = 101;
    provider.logs = [
      log(ENGINE, engine, 'IntentFilled', [7n, a.vault, a.sessionKey, 0n, a.tokenIn, a.amountIn, dai(9.99)]),
      log(ENGINE, engine, 'BatchSettled', [7n, DAI, USDC, 10n ** 6n, 0n, usdc(10), usdc(10), dai(9.99), false, 1n]),
    ];

    await listener.poll();
    expect(mempool.get(a.id)?.status).toBe('settled');
    expect(mempool.get(a.id)?.batchId).toBe(7n);

    const settled = events.find((e) => e.event === 'intent.settled')!;
    expect(settled.vault).toBe(a.vault);
    expect(settled.data.amountOut).toBe(dai(9.99).toString());

    const batch = events.find((e) => e.event === 'batch.settled')!;
    expect(batch.data).toMatchObject({ pair: 'USDC/DAI', count: '1', volume: { DAI: '0', USDC: '10000000' } });
  });

  it('publishes vault events and fails pending intents when a vault freezes', async () => {
    const a = mempool.add(await makeIntent(alice, { tokenIn: USDC, tokenOut: DAI, amountIn: usdc(10) }));
    provider.block = 101;
    provider.logs = [
      log(VAULT, vaultIface, 'CircuitBreakerTriggered', ['window cap exceeded', 123n, alice.address]),
      log(VAULT, vaultIface, 'Frozen', []),
    ];

    await listener.poll();
    expect(events.find((e) => e.event === 'vault.circuitBreaker')?.data).toMatchObject({
      reason: 'window cap exceeded',
      sessionKey: alice.address,
    });
    expect(events.some((e) => e.event === 'vault.frozen' && e.vault === VAULT)).toBe(true);
    expect(mempool.get(a.id)?.status).toBe('failed');
    expect(mempool.get(a.id)?.lastExclusion).toBe('vault is frozen');
  });

  it('publishes pool.price only on significant moves', async () => {
    const swap = (block: number) => log(POOL, pool, 'Swap', [VAULT, USDC, 1n, 1n, 0n, VAULT], block);

    provider.block = 101;
    provider.logs = [swap(101)];
    price = 10n ** 30n + 10n ** 26n; // +1 bp
    await listener.poll();
    expect(events.filter((e) => e.event === 'pool.price')).toHaveLength(0);

    provider.block = 102;
    provider.logs = [swap(102)];
    price = (10n ** 30n * 10_050n) / 10_000n; // +50 bps
    await listener.poll();
    const moves = events.filter((e) => e.event === 'pool.price');
    expect(moves).toHaveLength(1);
    expect(moves[0].data).toMatchObject({ pair: 'USDC/DAI', price: '1.0050', changeBps: 48 });
    expect(listener.poolPrices()).toEqual({ 'USDC/DAI': '1.0050' });
  });

  it('catches up in bounded ranges and retries a failed range', async () => {
    provider.block = 125;
    await listener.poll();
    expect(provider.ranges).toEqual([
      [101, 110],
      [111, 120],
      [121, 125],
    ]);

    provider.ranges = [];
    provider.block = 130;
    const original = provider.getLogs.bind(provider);
    provider.getLogs = async () => {
      throw new Error('rate limit');
    };
    await expect(listener.poll()).rejects.toThrow();
    provider.getLogs = original;
    await listener.poll();
    expect(provider.ranges).toEqual([[126, 130]]);
  });
});

describe('WebSocket broadcaster', () => {
  async function withServer(fn: (url: string, bus: EventBus) => Promise<void>) {
    const bus = new EventBus();
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const ws = attachWebSocket(server, bus);
    try {
      await fn(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`, bus);
    } finally {
      ws.close();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  function connect(url: string) {
    const socket = new WebSocket(url);
    const received: Record<string, unknown>[] = [];
    const waiters: (() => void)[] = [];
    socket.on('message', (m) => {
      received.push(JSON.parse(m.toString()));
      waiters.splice(0).forEach((w) => w());
    });
    const next = async (count: number) => {
      while (received.length < count) await new Promise<void>((resolve) => waiters.push(resolve));
      return received;
    };
    return { socket, received, next, open: new Promise((resolve) => socket.once('open', resolve)) };
  }

  it('streams events and filters by vault and event pattern', async () => {
    await withServer(async (url, bus) => {
      const all = connect(url);
      const mine = connect(url);
      await Promise.all([all.open, mine.open]);
      await all.next(1); // hello
      await mine.next(1);

      mine.socket.send(JSON.stringify({ op: 'subscribe', vaults: [VAULT], events: ['intent.*', 'batch.settled'] }));
      const [, subscribed] = await mine.next(2);
      expect(subscribed).toMatchObject({ event: 'subscribed', data: { vaults: [VAULT.toLowerCase()] } });

      bus.publish('intent.settled', { amountOut: 5n }, VAULT_2); // other vault
      bus.publish('pool.price', { pair: 'USDC/DAI' }); // filtered by event pattern
      bus.publish('intent.accepted', { intentId: '0x1' }, VAULT);
      bus.publish('batch.settled', { count: 1 });

      const allEvents = (await all.next(5)).slice(1).map((m) => m.event);
      expect(allEvents).toEqual(['intent.settled', 'pool.price', 'intent.accepted', 'batch.settled']);
      expect(all.received[1].data).toEqual({ amountOut: '5' });

      const mineEvents = (await mine.next(4)).slice(2).map((m) => m.event);
      expect(mineEvents).toEqual(['intent.accepted', 'batch.settled']);

      mine.socket.send('not json');
      expect((await mine.next(5))[4]).toMatchObject({ event: 'error' });
      mine.socket.send(JSON.stringify({ op: 'subscribe', vaults: ['0xnope'] }));
      expect((await mine.next(6))[5]).toMatchObject({ event: 'error' });

      all.socket.close();
      mine.socket.close();
    });
  });
});
