import { Wallet } from 'ethers';
import type { ClearingQuote, ClearingQuoter } from '../src/engine/matcher.js';
import type { PendingIntent, SignedIntent } from '../src/types/intent.js';
import { intentId, signBatchIntent } from '../src/engine/signature.js';

export const CHAIN_ID = 8453;
export const DAI = '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb'; // lower address → tokenA
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // tokenB
export const WETH = '0x4200000000000000000000000000000000000006';
export const VAULT = '0x1111111111111111111111111111111111111111';
export const VAULT_2 = '0x2222222222222222222222222222222222222222';

const ONE = 10n ** 18n;
/** USDC per DAI in native units, 1e18-scaled, at parity: 1e6 / 1e18 * 1e18 */
export const PARITY = 10n ** 6n;

export const usdc = (n: number) => BigInt(Math.round(n * 1e6));
export const dai = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

/**
 * Re-implementation of IntentEngine._clear for a pool that converts at `price` minus
 * `poolFeeBps`, with an optional Spraay fee on outputs (IntentEngine._afterSpraayFee).
 */
export function mockQuoter(price: bigint, poolFeeBps = 4n, spraayFeeBps = 0n): ClearingQuoter & { calls: number } {
  const simulate = (sellsA: boolean, amountIn: bigint) => {
    const net = amountIn - (amountIn * poolFeeBps + 9_999n) / 10_000n;
    return sellsA ? (net * price) / ONE : (net * ONE) / price;
  };
  const afterFee = (total: bigint) => (spraayFeeBps === 0n ? total : (total * 10_000n) / (10_000n + spraayFeeBps));

  const quoter = async (_a: string, _b: string, sellA: bigint, sellB: bigint): Promise<ClearingQuote> => {
    quoter.calls++;
    const sellBInA = (sellB * ONE) / price;
    let toASellers: bigint, toBSellers: bigint, residualIn: bigint, residualOut: bigint;
    if (sellA >= sellBInA) {
      residualIn = sellA - sellBInA;
      residualOut = residualIn === 0n ? 0n : simulate(true, residualIn);
      toBSellers = sellBInA;
      toASellers = sellB + residualOut;
    } else {
      const sellAInB = (sellA * price) / ONE;
      residualIn = sellB - sellAInB;
      residualOut = simulate(false, residualIn);
      toASellers = sellAInB;
      toBSellers = sellA + residualOut;
    }
    return { price, toASellers: afterFee(toASellers), toBSellers: afterFee(toBSellers), residualIn, residualOut };
  };
  quoter.calls = 0;
  return quoter;
}

let clock = 1_000;

/** Build a pending intent with a real batch signature from `key` */
export async function makeIntent(
  key: Wallet,
  fields: Partial<SignedIntent> & Pick<SignedIntent, 'tokenIn' | 'tokenOut' | 'amountIn'>,
): Promise<PendingIntent> {
  const unsigned = {
    vault: VAULT,
    sessionKey: key.address,
    minAmountOut: 0n,
    deadline: 2_000_000_000,
    nonce: 0,
    ...fields,
  };
  const signed: SignedIntent = { ...unsigned, signature: await signBatchIntent(key, unsigned, CHAIN_ID) };
  return { ...signed, id: intentId(signed), receivedAt: clock++, status: 'pending' };
}
