import { beforeAll, describe, expect, it } from 'vitest';
import { Signature, Wallet } from 'ethers';
import { parseIntent } from '../src/api/validation.js';
import { BATCH_INTENT_TAG, batchMessageHash, checkSignatureFormat, signBatchIntent } from '../src/engine/signature.js';
import { CHAIN_ID, DAI, USDC, VAULT } from './helpers.js';

const key = Wallet.createRandom();
const nowSec = 1_900_000_000;
const ctx = { chainId: CHAIN_ID, nowSec };

const fields = {
  vault: VAULT,
  sessionKey: key.address,
  tokenIn: USDC,
  tokenOut: DAI,
  amountIn: 1_000_000n,
  minAmountOut: 990_000_000_000_000_000n,
  deadline: nowSec + 60,
  nonce: 7,
};

/** A valid POST /intent body for `fields` */
let body: Record<string, unknown>;
beforeAll(async () => {
  body = {
    ...fields,
    amountIn: fields.amountIn.toString(),
    minAmountOut: fields.minAmountOut.toString(),
    signature: await signBatchIntent(key, fields, CHAIN_ID),
  };
});

describe('batch intent digest', () => {
  // Reference values computed independently with Foundry:
  //   cast keccak "ARCHON_BATCH_INTENT"
  //   cast keccak $(cast abi-encode --packed "f(bytes32,address,address,uint256,uint256,uint256)" ...)
  it('matches AgentVault.BATCH_INTENT_TAG', () => {
    expect(BATCH_INTENT_TAG).toBe('0x49f0cb72cd3c14cf07a15f3c0ccf497b73c34be55261e3e11e0ec73dd6cfb2de');
  });

  it('matches the message hash AgentVault.executeBatchLeg verifies', () => {
    expect(batchMessageHash(fields, CHAIN_ID)).toBe(
      '0x94f6848b0cf486aa3565ebcbb9e0d9c260aac1ed255e6fb495abb028917b0534',
    );
  });

  it('binds the digest to vault, nonce and chain', () => {
    const base = batchMessageHash(fields, CHAIN_ID);
    expect(batchMessageHash(fields, 1)).not.toBe(base);
    expect(batchMessageHash({ ...fields, vault: DAI }, CHAIN_ID)).not.toBe(base);
    expect(batchMessageHash({ ...fields, nonce: 8 }, CHAIN_ID)).not.toBe(base);
  });
});

describe('checkSignatureFormat', () => {
  it('accepts a normal signature and rejects wrong lengths', () => {
    expect(checkSignatureFormat(body.signature as string)).toBeNull();
    expect(checkSignatureFormat('0x1234')).toMatch(/65 bytes/);
  });

  it('rejects the malleable high-s twin, which OpenZeppelin ECDSA would reject', () => {
    const sig = Signature.from(body.signature as string);
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = (N - BigInt(sig.s)).toString(16).padStart(64, '0');
    const flippedV = sig.v === 27 ? '1c' : '1b';
    expect(checkSignatureFormat(sig.r + highS + flippedV)).toMatch(/lower half/);
  });
});

describe('parseIntent', () => {
  it('accepts a correctly signed batch intent', () => {
    const intent = parseIntent(body, ctx);
    expect(intent.amountIn).toBe(1_000_000n);
    expect(intent.nonce).toBe(7);
    expect(intent.sessionKey).toBe(key.address);
  });

  it('rejects a signature for another chain', () => {
    expect(() => parseIntent(body, { ...ctx, chainId: 1 })).toThrow(/does not recover/);
  });

  it('rejects tampered fields', () => {
    expect(() => parseIntent({ ...body, minAmountOut: '1' }, ctx)).toThrow(/does not recover/);
  });

  it('rejects a single-swap signature (no batch tag)', async () => {
    // A signature over the submitSwapIntent digest must not be accepted as a batch leg
    const { solidityPackedKeccak256, getBytes } = await import('ethers');
    const intentHash = solidityPackedKeccak256(
      ['address', 'address', 'uint256', 'uint256', 'uint256'],
      [fields.tokenIn, fields.tokenOut, fields.amountIn, fields.minAmountOut, fields.deadline],
    );
    const messageHash = solidityPackedKeccak256(
      ['bytes32', 'uint256', 'address', 'uint256'],
      [intentHash, fields.nonce, fields.vault, CHAIN_ID],
    );
    const signature = await key.signMessage(getBytes(messageHash));
    expect(() => parseIntent({ ...body, signature }, ctx)).toThrow(/does not recover/);
  });

  it('rejects bad field types and values', () => {
    expect(() => parseIntent(null, ctx)).toThrow(/JSON object/);
    expect(() => parseIntent({ ...body, amountIn: 1000000 }, ctx)).toThrow(/decimal string/);
    expect(() => parseIntent({ ...body, amountIn: '0' }, ctx)).toThrow(/positive/);
    expect(() => parseIntent({ ...body, vault: '0x123' }, ctx)).toThrow(/vault must be an address/);
    expect(() => parseIntent({ ...body, nonce: -1 }, ctx)).toThrow(/nonce/);
    expect(() => parseIntent({ ...body, nonce: 1.5 }, ctx)).toThrow(/nonce/);
    expect(() => parseIntent({ ...body, tokenOut: USDC }, ctx)).toThrow(/differ/);
    expect(() => parseIntent({ ...body, deadline: nowSec }, ctx)).toThrow(/deadline/);
    expect(() => parseIntent({ ...body, signature: '0xdead' }, ctx)).toThrow(/65 bytes/);
  });
});
