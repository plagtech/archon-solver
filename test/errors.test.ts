import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface } from 'ethers';
import { AgentVaultAbi, IntentEngineAbi } from '../src/chain/contracts.js';
import { decodeRevertData, parseError, revertPolicy } from '../src/chain/errors.js';

const engine = new Interface(IntentEngineAbi);
const vault = new Interface(AgentVaultAbi);

describe('parseError', () => {
  it('decodes engine custom errors nested inside RPC errors', () => {
    const data = engine.encodeErrorResult('PoolNotFound', [
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    ]);
    const err = { code: 'CALL_EXCEPTION', info: { error: { code: 3, message: 'execution reverted', data } } };
    const parsed = parseError(err);
    expect(parsed.kind).toBe('revert');
    expect(parsed.name).toBe('PoolNotFound');
    expect(revertPolicy(parsed)).toBe('pool');
  });

  it('decodes vault errors and require strings and panics', () => {
    expect(decodeRevertData(vault.encodeErrorResult('InvalidNonce', [3n, 2n]))).toEqual({ name: 'InvalidNonce', args: [3n, 2n] });
    const reason = '0x08c379a0' + AbiCoder.defaultAbiCoder().encode(['string'], ['ETH transfer failed']).slice(2);
    expect(parseError({ data: reason }).message).toBe('Error(ETH transfer failed)');
    const panic = '0x4e487b71' + AbiCoder.defaultAbiCoder().encode(['uint256'], [0x11]).slice(2);
    expect(parseError({ data: panic }).message).toBe('Panic(17)');
  });

  it('uses the revert ethers already decoded', () => {
    const parsed = parseError({ code: 'CALL_EXCEPTION', revert: { name: 'OnlySolver', args: [] } });
    expect(parsed).toMatchObject({ kind: 'revert', name: 'OnlySolver' });
    expect(revertPolicy(parsed)).toBe('config');
  });

  it('classifies node errors', () => {
    expect(parseError({ code: 'NONCE_EXPIRED', message: 'nonce has already been used' }).kind).toBe('nonce');
    expect(parseError(new Error('replacement transaction underpriced')).kind).toBe('underpriced');
    expect(parseError({ code: 'INSUFFICIENT_FUNDS' }).kind).toBe('funds');
    expect(parseError({ error: { code: -32016, message: 'over rate limit' } }).kind).toBe('transient');
    expect(parseError({ code: 'CALL_EXCEPTION', message: 'execution reverted' })).toMatchObject({ kind: 'revert' });
    expect(revertPolicy(parseError({ code: 'CALL_EXCEPTION' }))).toBe('unknown');
  });
});
