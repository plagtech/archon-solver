import {
  AbiCoder,
  Signature,
  getBytes,
  hashMessage,
  keccak256,
  recoverAddress,
  solidityPackedKeccak256,
  toUtf8Bytes,
  type Signer,
} from 'ethers';
import type { SignedIntent } from '../types/intent.js';

/** AgentVault.BATCH_INTENT_TAG */
export const BATCH_INTENT_TAG = keccak256(toUtf8Bytes('ARCHON_BATCH_INTENT'));

/** secp256k1n / 2 — OpenZeppelin ECDSA rejects signatures with a larger s */
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

type SignableIntent = Omit<SignedIntent, 'signature'>;

/**
 * The digest a session key signs for a batch leg, exactly as AgentVault.executeBatchLeg builds it:
 *   intentHash  = keccak256(abi.encodePacked(BATCH_INTENT_TAG, tokenIn, tokenOut, amountIn, minAmountOut, deadline))
 *   messageHash = keccak256(abi.encodePacked(intentHash, nonce, vault, chainId))
 * The signature is an EIP-191 personal_sign over messageHash (32 raw bytes).
 */
export function batchMessageHash(intent: SignableIntent, chainId: number): string {
  const intentHash = solidityPackedKeccak256(
    ['bytes32', 'address', 'address', 'uint256', 'uint256', 'uint256'],
    [BATCH_INTENT_TAG, intent.tokenIn, intent.tokenOut, intent.amountIn, intent.minAmountOut, intent.deadline],
  );
  return solidityPackedKeccak256(
    ['bytes32', 'uint256', 'address', 'uint256'],
    [intentHash, intent.nonce, intent.vault, chainId],
  );
}

/** Sign a batch intent with a session key (used by agents and tests) */
export async function signBatchIntent(signer: Signer, intent: SignableIntent, chainId: number): Promise<string> {
  return signer.signMessage(getBytes(batchMessageHash(intent, chainId)));
}

/**
 * Checks the signature the way OpenZeppelin ECDSA.recover will: 65 bytes, v ∈ {27, 28}, low s.
 * Returns an error message, or null if the format is valid.
 */
export function checkSignatureFormat(signature: string): string | null {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return 'signature must be 65 bytes of hex';
  const bytes = getBytes(signature);
  const v = bytes[64];
  if (v !== 27 && v !== 28) return 'signature v must be 27 or 28';
  const s = BigInt('0x' + signature.slice(66, 130));
  if (s > HALF_N) return 'signature s must be in the lower half order';
  return null;
}

/** Recover the batch-intent signer off-chain. Returns null if recovery fails. */
export function recoverBatchSigner(intent: SignedIntent, chainId: number): string | null {
  try {
    const digest = hashMessage(getBytes(batchMessageHash(intent, chainId)));
    return recoverAddress(digest, Signature.from(intent.signature));
  } catch {
    return null;
  }
}

/** Intent ID: keccak256 of the ABI-encoded signed intent (all fields including the signature) */
export function intentId(intent: SignedIntent): string {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'address', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes'],
    [
      intent.vault,
      intent.sessionKey,
      intent.tokenIn,
      intent.tokenOut,
      intent.amountIn,
      intent.minAmountOut,
      intent.deadline,
      intent.nonce,
      intent.signature,
    ],
  );
  return keccak256(encoded);
}
