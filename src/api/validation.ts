import { getAddress, isAddress } from 'ethers';
import type { SignedIntent } from '../types/intent.js';
import { checkSignatureFormat, recoverBatchSigner } from '../engine/signature.js';

const UINT256_MAX = 2n ** 256n - 1n;

export class ValidationError extends Error {}

function addressField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || !isAddress(value)) throw new ValidationError(`${name} must be an address`);
  return getAddress(value);
}

/** uint256 as a decimal string. JSON numbers lose precision above 2^53, so they are rejected. */
export function parseUintString(value: unknown, name: string): bigint {
  if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) {
    throw new ValidationError(`${name} must be a decimal string of base units`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX) throw new ValidationError(`${name} exceeds uint256`);
  return parsed;
}

function intField(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${name} must be a non-negative integer`);
  }
  return value;
}

/**
 * Parse and statically validate a POST /intent body: field types, deadline, signature format,
 * and that the signature recovers to sessionKey under the batch-intent digest. Recovering
 * off-chain costs nothing and keeps intents that would certainly be skipped out of batches;
 * the vault still verifies on-chain.
 */
export function parseIntent(body: unknown, opts: { chainId: number; nowSec: number }): SignedIntent {
  if (typeof body !== 'object' || body === null) throw new ValidationError('body must be a JSON object');
  const b = body as Record<string, unknown>;

  const intent: SignedIntent = {
    vault: addressField(b, 'vault'),
    sessionKey: addressField(b, 'sessionKey'),
    tokenIn: addressField(b, 'tokenIn'),
    tokenOut: addressField(b, 'tokenOut'),
    amountIn: parseUintString(b.amountIn, 'amountIn'),
    minAmountOut: parseUintString(b.minAmountOut, 'minAmountOut'),
    deadline: intField(b, 'deadline'),
    nonce: intField(b, 'nonce'),
    signature: typeof b.signature === 'string' ? b.signature : '',
  };

  if (intent.tokenIn === intent.tokenOut) throw new ValidationError('tokenIn and tokenOut must differ');
  if (intent.amountIn === 0n) throw new ValidationError('amountIn must be positive');
  if (intent.deadline <= opts.nowSec) throw new ValidationError('deadline has passed');

  const formatError = checkSignatureFormat(intent.signature);
  if (formatError) throw new ValidationError(formatError);

  if (recoverBatchSigner(intent, opts.chainId) !== intent.sessionKey) {
    throw new ValidationError(
      'signature does not recover to sessionKey; sign the batch-intent digest ' +
        'keccak256(keccak256(BATCH_INTENT_TAG, tokenIn, tokenOut, amountIn, minAmountOut, deadline), nonce, vault, chainId)',
    );
  }
  return intent;
}
