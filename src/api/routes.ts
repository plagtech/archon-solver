import express, { type NextFunction, type Request, type Response } from 'express';
import { getAddress, isAddress } from 'ethers';
import type { Config } from '../config.js';
import type { Market } from '../chain/market.js';
import { DuplicateIntentError, type Mempool } from '../engine/mempool.js';
import type { StatsCollector } from '../stats.js';
import type { PendingIntent } from '../types/intent.js';
import { ValidationError, parseIntent, parseUintString } from './validation.js';

const PAIRS_CACHE_MS = 5_000;

export interface ApiDeps {
  config: Config;
  market: Market;
  mempool: Mempool;
  solverAddress: string;
  stats: Pick<StatsCollector, 'snapshot'>;
  /** Latest pool prices by pair name (from the event listener) */
  poolPrices?: () => Record<string, string>;
  lastSettlement?: () => Date | undefined;
  now?: () => number;
}

export function createApp(deps: ApiDeps) {
  const { config, market, mempool } = deps;
  const now = deps.now ?? Date.now;
  const nowSec = () => Math.floor(now() / 1000);
  const startedAt = now();
  const app = express();
  app.use(express.json({ limit: '16kb' }));

  app.post('/intent', async (req, res) => {
    const intent = parseIntent(req.body, { chainId: config.chainId, nowSec: nowSec() });
    const pair = market.pairFor(intent.tokenIn, intent.tokenOut);
    if (!pair) throw new ValidationError('unsupported token pair');

    // Cheap reads that catch legs the engine would certainly skip, before they cost gas.
    // The vault must be confirmed first: its getters don't exist on arbitrary addresses.
    const [isVault, price] = await Promise.all([
      market.isVault(intent.vault),
      market.spotPrice(pair, intent.tokenIn),
    ]);
    if (!isVault) throw new ValidationError('vault is not a registered Archon vault');
    // settleBatch reverts on an empty pool even when every leg is matched
    if (price === 0n) throw new ValidationError(`${pair.name} pool has no liquidity`);

    const [key, balance] = await Promise.all([
      market.sessionKey(intent.vault, intent.sessionKey),
      market.vaultBalance(intent.vault, intent.tokenIn),
    ]);
    if (!key.active) throw new ValidationError('session key is not active on this vault');
    if (!key.canBatchSwap) throw new ValidationError('session key lacks the canBatchSwap permission');
    if (key.expiry <= BigInt(nowSec() + config.deadlineBufferSec)) throw new ValidationError('session key has expired');
    if (BigInt(intent.nonce) < key.nonce) {
      throw new ValidationError(`nonce ${intent.nonce} already used (next is ${key.nonce})`);
    }
    if (balance < intent.amountIn) throw new ValidationError(`vault balance ${balance} is below amountIn`);

    const pending = mempool.add(intent);
    res.status(202).json({
      intentId: pending.id,
      status: pending.status,
      estimatedSettlement: nowSec() + Math.ceil(config.matchIntervalMs / 1000) + 2,
    });
  });

  app.get('/quote', async (req, res) => {
    const { tokenIn, tokenOut } = req.query;
    if (typeof tokenIn !== 'string' || !isAddress(tokenIn)) throw new ValidationError('tokenIn must be an address');
    if (typeof tokenOut !== 'string' || !isAddress(tokenOut)) throw new ValidationError('tokenOut must be an address');
    const amountIn = parseUintString(req.query.amountIn, 'amountIn');
    if (amountIn === 0n) throw new ValidationError('amountIn must be positive');
    if (!market.pairFor(tokenIn, tokenOut)) throw new ValidationError('unsupported token pair');

    const quote = await market.quote(getAddress(tokenIn), getAddress(tokenOut), amountIn);
    res.json({
      expectedOut: quote.expectedOut.toString(),
      priceImpactBps: quote.priceImpactBps,
      poolFee: quote.fee.toString(),
      spotPrice: market.formatPrice(quote.spotPrice, tokenIn, tokenOut),
    });
  });

  // Pool state changes slowly relative to how often clients poll, so cache briefly. Pairs are
  // read one at a time to stay under public-RPC burst limits.
  let pairsCache: { at: number; body: unknown } | undefined;
  app.get('/pairs', async (_req, res) => {
    if (!pairsCache || now() - pairsCache.at > PAIRS_CACHE_MS) {
      const pairs = [];
      for (const pair of config.pairs) pairs.push(await market.pairInfo(pair));
      pairsCache = { at: now(), body: { pairs } };
    }
    res.json(pairsCache.body);
  });

  app.get('/status/:intentId', (req, res) => {
    const intent = mempool.get(req.params.intentId);
    if (!intent) {
      res.status(404).json({ error: 'unknown intent' });
      return;
    }
    res.json(statusView(intent));
  });

  // Railway health check. Served from memory only, so an RPC outage doesn't fail it.
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      chain: config.chainId,
      solverAddress: deps.solverAddress,
      pendingIntents: mempool.pendingCount(),
      lastSettlement: deps.lastSettlement?.()?.toISOString() ?? null,
      poolPrices: deps.poolPrices?.() ?? {},
      uptime: Math.floor((now() - startedAt) / 1000),
    });
  });

  // Counters since process start, served from memory (no RPC), like /health
  app.get('/stats', (_req, res) => {
    res.json(deps.stats.snapshot());
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
    } else if (err instanceof DuplicateIntentError) {
      res.status(409).json({ error: err.message });
    } else if ((err as { type?: string })?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid JSON' });
    } else {
      console.error('[api]', err);
      res.status(502).json({ error: 'chain read failed' });
    }
  });

  return app;
}

function statusView(intent: PendingIntent) {
  return {
    intentId: intent.id,
    status: intent.status,
    vault: intent.vault,
    tokenIn: intent.tokenIn,
    tokenOut: intent.tokenOut,
    amountIn: intent.amountIn.toString(),
    minAmountOut: intent.minAmountOut.toString(),
    deadline: intent.deadline,
    expectedOut: intent.expectedOut?.toString(),
    amountOut: intent.amountOut?.toString(),
    batchId: intent.batchId?.toString(),
    txHash: intent.txHash,
    reason: intent.lastExclusion,
  };
}
