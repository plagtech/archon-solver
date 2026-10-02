import { formatUnits, getAddress } from 'ethers';
import type { Config, PairConfig, TokenInfo } from '../config.js';
import type { Contracts } from './contracts.js';
import type { ClearingQuote, ClearingQuoter } from '../engine/matcher.js';

const ONE = 10n ** 18n;
const BPS = 10_000n;

export interface Quote {
  expectedOut: bigint;
  /** Pool fee, denominated in tokenIn */
  fee: bigint;
  spotPrice: bigint;
  priceImpactBps: number;
}

export interface PairInfo {
  name: string;
  pool: string;
  type: PairConfig['type'];
  tokens: { symbol: string; address: string; decimals: number }[];
  feeBps: number;
  /** Pool reserves by token symbol, native units */
  liquidity: Record<string, string>;
  /** Price of the second token in the first, e.g. WETH in USDC for "USDC/WETH" */
  spotPrice: string;
}

export interface SessionKeyState {
  active: boolean;
  canBatchSwap: boolean;
  expiry: bigint;
  nonce: bigint;
}

/** Read-only chain access for quoting, pricing and intent validation */
export class Market {
  private readonly tokensByAddress: Map<string, TokenInfo>;
  private readonly poolToken0 = new Map<string, Promise<string>>();

  constructor(
    private readonly config: Config,
    private readonly contracts: Contracts,
  ) {
    this.tokensByAddress = new Map(config.tokens.map((t) => [t.address.toLowerCase(), t]));
  }

  token(address: string): TokenInfo | undefined {
    return this.tokensByAddress.get(address.toLowerCase());
  }

  pairFor(tokenX: string, tokenY: string): PairConfig | undefined {
    const x = tokenX.toLowerCase();
    const y = tokenY.toLowerCase();
    return this.config.pairs.find((p) => {
      const a = p.tokenA.toLowerCase();
      const b = p.tokenB.toLowerCase();
      return (a === x && b === y) || (a === y && b === x);
    });
  }

  /** Marginal price of tokenIn in tokenOut (native units, 1e18-scaled) */
  async spotPrice(pair: PairConfig, tokenIn: string): Promise<bigint> {
    return this.pool(pair).spotPrice(tokenIn);
  }

  /** Human-readable price of one whole tokenIn in tokenOut */
  formatPrice(raw: bigint, tokenIn: string, tokenOut: string): string {
    const decIn = this.token(tokenIn)?.decimals ?? 18;
    const decOut = this.token(tokenOut)?.decimals ?? 18;
    const human = Number(formatUnits((raw * 10n ** BigInt(decIn)) / 10n ** BigInt(decOut), 18));
    if (human === 0) return '0';
    return human >= 1 ? human.toFixed(4) : human.toPrecision(6);
  }

  async quote(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<Quote> {
    const pair = this.requirePair(tokenIn, tokenOut);
    const pool = this.pool(pair);
    const [[expectedOut, fee], spotPrice] = (await Promise.all([
      pool.simulateSwap(tokenIn, amountIn),
      pool.spotPrice(tokenIn),
    ])) as [[bigint, bigint], bigint];

    // Impact is measured after the fee: what the net input would get at the marginal price
    const ideal = ((amountIn - fee) * spotPrice) / ONE;
    const priceImpactBps = ideal > expectedOut ? Number(((ideal - expectedOut) * BPS) / ideal) : 0;
    return { expectedOut, fee, spotPrice, priceImpactBps };
  }

  async pairInfo(pair: PairConfig): Promise<PairInfo> {
    const pool = this.pool(pair);
    const [first, second] = pair.name.split('/').map((s) => this.config.tokens.find((t) => t.symbol === s)!);
    const [feeBps, balances, token0, price] = (await Promise.all([
      pool.feeBps(),
      pool.getBalances(),
      this.token0(pair),
      pool.spotPrice(second.address),
    ])) as [bigint, [bigint, bigint], string, bigint];

    const liquidity: Record<string, string> = {};
    for (const [idx, address] of [token0, token0 === pair.tokenA ? pair.tokenB : pair.tokenA].entries()) {
      liquidity[this.token(address)?.symbol ?? address] = balances[idx].toString();
    }

    return {
      name: pair.name,
      pool: pair.pool,
      type: pair.type,
      tokens: [first, second].map(({ symbol, address, decimals }) => ({ symbol, address, decimals })),
      feeBps: Number(feeBps),
      liquidity,
      spotPrice: this.formatPrice(price, second.address, first.address),
    };
  }

  /** Clearing preview straight from the IntentEngine, so off-chain matching uses on-chain math */
  readonly clearingQuoter: ClearingQuoter = async (tokenA, tokenB, sellA, sellB): Promise<ClearingQuote> => {
    try {
      const [price, toASellers, toBSellers, residualIn, residualOut] = (await this.contracts.engine.quoteClearing(
        tokenA,
        tokenB,
        sellA,
        sellB,
      )) as bigint[];
      return { price, toASellers, toBSellers, residualIn, residualOut };
    } catch (err) {
      // planBatch treats a zero price as "pool is empty"
      if ((err as { revert?: { name?: string } }).revert?.name === 'EmptyPool') {
        return { price: 0n, toASellers: 0n, toBSellers: 0n, residualIn: 0n, residualOut: 0n };
      }
      throw err;
    }
  };

  async isVault(address: string): Promise<boolean> {
    return this.contracts.router.isVault(address);
  }

  async sessionKey(vault: string, key: string): Promise<SessionKeyState> {
    const sk = await this.contracts.vault(vault).sessionKeys(key);
    return { active: sk.active, canBatchSwap: sk.canBatchSwap, expiry: sk.expiry, nonce: sk.nonce };
  }

  async vaultBalance(vault: string, token: string): Promise<bigint> {
    return this.contracts.vault(vault).getBalance(token);
  }

  private requirePair(tokenX: string, tokenY: string): PairConfig {
    const pair = this.pairFor(tokenX, tokenY);
    if (!pair) throw new Error(`Unsupported pair ${tokenX}/${tokenY}`);
    return pair;
  }

  private pool(pair: PairConfig) {
    return this.contracts.pools.get(pair.pool)!;
  }

  private token0(pair: PairConfig): Promise<string> {
    let cached = this.poolToken0.get(pair.pool);
    if (!cached) {
      cached = (this.pool(pair).token0() as Promise<string>).then(getAddress);
      cached.catch(() => this.poolToken0.delete(pair.pool));
      this.poolToken0.set(pair.pool, cached);
    }
    return cached;
  }
}
