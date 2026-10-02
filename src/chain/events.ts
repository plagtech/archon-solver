import { Interface, type Log, type LogDescription, type Provider } from 'ethers';
import type { Config, PairConfig } from '../config.js';
import type { EventBus } from '../events.js';
import type { Mempool } from '../engine/mempool.js';
import { applyEngineLog } from '../engine/settlement.js';
import type { Market } from './market.js';
import { AgentVaultAbi, IntentEngineAbi, StablePoolAbi } from './contracts.js';
import { parseError } from './errors.js';

export interface EventListenerOptions {
  pollMs?: number;
  /** Max blocks per eth_getLogs call */
  maxBlockRange?: number;
  /** Max getLogs calls per poll, so a long outage catches up gradually */
  maxRangesPerPoll?: number;
  /** Publish pool.price when a pair's price moves at least this much */
  priceMoveBps?: number;
}

interface PriceState {
  raw: bigint;
  display: string;
}

const engineIface = new Interface(IntentEngineAbi);
const vaultIface = new Interface(AgentVaultAbi);
// StablePool and VolatilePool share BasePool's Swap event
const poolIface = new Interface(StablePoolAbi);

const VAULT_EVENTS: Record<string, Parameters<EventBus['publish']>[0]> = {
  SwapExecuted: 'vault.swapExecuted',
  SwapIntentBlocked: 'vault.swapBlocked',
  CircuitBreakerTriggered: 'vault.circuitBreaker',
  Frozen: 'vault.frozen',
  Unfrozen: 'vault.unfrozen',
};

/**
 * Polls eth_getLogs for the IntentEngine, every pool, and every vault the mempool knows about.
 * Polling works on any HTTP RPC and recovers from outages by resuming at the last processed
 * block. Engine logs update intent statuses (idempotently, alongside the submitter's own
 * receipt handling); vault and batch events are published to the bus; pool swaps trigger a
 * price check.
 */
export class ChainEventListener {
  private lastBlock?: number;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private readonly prices = new Map<string, PriceState>();
  private readonly poolsByAddress: Map<string, PairConfig>;
  private readonly opts: Required<EventListenerOptions>;

  constructor(
    private readonly provider: Pick<Provider, 'getBlockNumber' | 'getLogs'>,
    private readonly config: Config,
    private readonly market: Market,
    private readonly mempool: Mempool,
    private readonly bus: EventBus,
    options: EventListenerOptions = {},
  ) {
    this.poolsByAddress = new Map(config.pairs.map((p) => [p.pool.toLowerCase(), p]));
    this.opts = { pollMs: 2_000, maxBlockRange: 500, maxRangesPerPoll: 10, priceMoveBps: 10, ...options };
  }

  async start(): Promise<void> {
    this.lastBlock = await this.provider.getBlockNumber();
    for (const pair of this.config.pairs) {
      await this.refreshPrice(pair, false).catch((err) =>
        console.warn(`[events] initial price for ${pair.name} failed: ${parseError(err).message}`),
      );
    }
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Latest known price per pair, e.g. { "USDC/DAI": "1.0022" } (empty pools omitted) */
  poolPrices(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, price] of this.prices) if (price.raw > 0n) out[name] = price.display;
    return out;
  }

  private async tick(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.poll();
    } catch (err) {
      console.warn(`[events] poll failed: ${parseError(err).message}`);
    } finally {
      this.polling = false;
    }
  }

  /** Process new blocks since the last poll */
  async poll(): Promise<void> {
    if (this.lastBlock === undefined) this.lastBlock = await this.provider.getBlockNumber();
    const latest = await this.provider.getBlockNumber();
    const address = [
      this.config.addresses.engine,
      ...this.config.pairs.map((p) => p.pool),
      ...this.mempool.knownVaults(),
    ];

    const touchedPools = new Set<PairConfig>();
    for (let n = 0; n < this.opts.maxRangesPerPoll && this.lastBlock < latest; n++) {
      const fromBlock = this.lastBlock + 1;
      const toBlock = Math.min(latest, fromBlock + this.opts.maxBlockRange - 1);
      const logs = await this.provider.getLogs({ address, fromBlock, toBlock });
      for (const log of logs) this.handle(log, touchedPools);
      // Advance only after the whole range is handled, so a failure retries the range
      this.lastBlock = toBlock;
    }

    for (const pair of touchedPools) {
      await this.refreshPrice(pair, true).catch((err) =>
        console.warn(`[events] price refresh for ${pair.name} failed: ${parseError(err).message}`),
      );
    }
  }

  private handle(log: Log, touchedPools: Set<PairConfig>): void {
    const address = log.address.toLowerCase();
    try {
      if (address === this.config.addresses.engine.toLowerCase()) {
        const parsed = engineIface.parseLog(log);
        if (parsed) this.handleEngine(parsed, log);
        return;
      }
      const pair = this.poolsByAddress.get(address);
      if (pair) {
        if (poolIface.parseLog(log)?.name === 'Swap') touchedPools.add(pair);
        return;
      }
      const parsed = vaultIface.parseLog(log);
      if (parsed) this.handleVault(parsed, log);
    } catch (err) {
      console.warn(`[events] could not handle log ${log.transactionHash}:${log.index}`, err);
    }
  }

  private handleEngine(parsed: LogDescription, log: Log): void {
    if (parsed.name !== 'BatchSettled') {
      applyEngineLog(this.mempool, parsed, log.transactionHash);
      return;
    }
    const { batchId, tokenA, tokenB, price, sellA, sellB, residualIn, residualOut, residualIsA, filled } = parsed.args;
    const pair = this.market.pairFor(tokenA, tokenB);
    const symA = this.market.token(tokenA)?.symbol ?? tokenA;
    const symB = this.market.token(tokenB)?.symbol ?? tokenB;
    this.bus.publish('batch.settled', {
      batchId,
      pair: pair?.name ?? `${symA}/${symB}`,
      tokenA,
      tokenB,
      count: filled,
      volume: { [symA]: sellA, [symB]: sellB },
      price,
      residualIn,
      residualOut,
      residualToken: residualIsA ? tokenA : tokenB,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
    });
  }

  private handleVault(parsed: LogDescription, log: Log): void {
    const name = VAULT_EVENTS[parsed.name];
    if (!name) return;
    const data: Record<string, unknown> = { vault: log.address, txHash: log.transactionHash, blockNumber: log.blockNumber };
    parsed.fragment.inputs.forEach((input, k) => (data[input.name] = parsed.args[k]));
    this.bus.publish(name, data, log.address);

    // A frozen vault rejects every leg until the operator unfreezes it (after a cooldown)
    if (parsed.name === 'Frozen') {
      for (const intent of this.mempool.pendingForVault(log.address)) {
        this.mempool.setStatus(intent.id, 'failed', { lastExclusion: 'vault is frozen' });
      }
    }
  }

  /** Re-read a pair's price; publish pool.price if it moved enough */
  private async refreshPrice(pair: PairConfig, publish: boolean): Promise<void> {
    // Price of the pair's second token in the first, e.g. WETH in USDC for "USDC/WETH"
    const [firstSymbol, secondSymbol] = pair.name.split('/');
    const first = this.config.tokens.find((t) => t.symbol === firstSymbol)!;
    const second = this.config.tokens.find((t) => t.symbol === secondSymbol)!;
    const raw = await this.market.spotPrice(pair, second.address);
    const display = this.market.formatPrice(raw, second.address, first.address);
    const previous = this.prices.get(pair.name);
    this.prices.set(pair.name, { raw, display });

    if (!publish || raw === 0n) return;
    const changeBps = previous && previous.raw > 0n ? Number((abs(raw - previous.raw) * 10_000n) / previous.raw) : null;
    if (changeBps === null || changeBps >= this.opts.priceMoveBps) {
      this.bus.publish('pool.price', {
        pair: pair.name,
        pool: pair.pool,
        price: display,
        previous: previous?.display,
        changeBps,
      });
    }
  }
}

const abs = (x: bigint) => (x < 0n ? -x : x);
