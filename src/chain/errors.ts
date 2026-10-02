import { AbiCoder, Interface, isHexString } from 'ethers';
import { AgentVaultAbi, ArchonRouterAbi, IntentEngineAbi, StablePoolAbi, VolatilePoolAbi } from './contracts.js';

/**
 * - nonce: the tx nonce was already used or is otherwise rejected → resync and retry
 * - underpriced: a replacement didn't bump fees enough → bump and retry
 * - funds: the solver can't pay for gas
 * - revert: the contract reverted (see `name` / `reason`)
 * - transient: network / RPC trouble → retry later
 */
export type ErrorKind = 'nonce' | 'underpriced' | 'funds' | 'revert' | 'transient' | 'unknown';

export interface ParsedError {
  kind: ErrorKind;
  /** Custom error name, "Error" for require strings, or "Panic" */
  name?: string;
  args?: unknown[];
  /** Human-readable summary */
  message: string;
}

/** Every Archon contract's errors, so a revert bubbling up from any of them decodes */
const INTERFACES = [IntentEngineAbi, ArchonRouterAbi, AgentVaultAbi, StablePoolAbi, VolatilePoolAbi].map(
  (abi) => new Interface(abi),
);

const ERROR_STRING = '0x08c379a0';
const PANIC = '0x4e487b71';

/** Decode raw revert data. Returns null if the data is empty or unrecognized. */
export function decodeRevertData(data: string): { name: string; args: unknown[] } | null {
  if (!isHexString(data) || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();
  const coder = AbiCoder.defaultAbiCoder();
  try {
    if (selector === ERROR_STRING) return { name: 'Error', args: [...coder.decode(['string'], '0x' + data.slice(10))] };
    if (selector === PANIC) return { name: 'Panic', args: [...coder.decode(['uint256'], '0x' + data.slice(10))] };
  } catch {
    return null;
  }
  for (const iface of INTERFACES) {
    try {
      const parsed = iface.parseError(data);
      if (parsed) return { name: parsed.name, args: [...parsed.args] };
    } catch {
      // not this contract's error
    }
  }
  return null;
}

/** Revert data can sit at different depths depending on the RPC and the ethers call path */
function findRevertData(err: unknown, depth = 0): string | undefined {
  if (!err || typeof err !== 'object' || depth > 5) return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.data === 'string' && isHexString(e.data) && e.data.length >= 10) return e.data;
  for (const key of ['error', 'info', 'cause']) {
    const found = findRevertData(e[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

function collectMessages(err: unknown, depth = 0): string {
  if (!err || typeof err !== 'object' || depth > 5) return '';
  const e = err as Record<string, unknown>;
  const own = [e.shortMessage, e.message, e.reason].filter((m) => typeof m === 'string').join(' ');
  return [own, ...['error', 'info', 'cause'].map((k) => collectMessages(e[k], depth + 1))].join(' ');
}

function formatArgs(args: unknown[]): string {
  return args.map((a) => (typeof a === 'bigint' ? a.toString() : String(a))).join(', ');
}

export function parseError(err: unknown): ParsedError {
  const e = (err ?? {}) as { code?: string; revert?: { name: string; args: unknown[] } };

  // ethers already decoded it against the calling contract's ABI
  if (e.revert?.name) {
    return { kind: 'revert', name: e.revert.name, args: [...e.revert.args], message: `${e.revert.name}(${formatArgs([...e.revert.args])})` };
  }

  const data = findRevertData(err);
  const decoded = data ? decodeRevertData(data) : null;
  if (decoded) {
    return { kind: 'revert', ...decoded, message: `${decoded.name}(${formatArgs(decoded.args)})` };
  }

  const text = collectMessages(err);
  const lower = text.toLowerCase();
  if (e.code === 'NONCE_EXPIRED' || /nonce too low|nonce has already been used|already known|invalid nonce|nonce too high/.test(lower)) {
    return { kind: 'nonce', message: text.trim() || 'nonce rejected' };
  }
  if (e.code === 'REPLACEMENT_UNDERPRICED' || /underpriced/.test(lower)) {
    return { kind: 'underpriced', message: text.trim() };
  }
  if (e.code === 'INSUFFICIENT_FUNDS' || /insufficient funds/.test(lower)) {
    return { kind: 'funds', message: text.trim() };
  }
  if (e.code === 'CALL_EXCEPTION' || /execution reverted/.test(lower)) {
    return { kind: 'revert', message: text.trim() || 'execution reverted without data' };
  }
  if (
    e.code === 'TIMEOUT' ||
    e.code === 'NETWORK_ERROR' ||
    e.code === 'SERVER_ERROR' ||
    /timeout|rate limit|econnreset|socket hang up|fetch failed|429|502|503/.test(lower)
  ) {
    return { kind: 'transient', message: text.trim() };
  }
  return { kind: 'unknown', message: text.trim() || String(err) };
}

/**
 * How the submitter should react to a whole-batch revert from IntentEngine.settleBatch.
 * Per-leg failures never revert the batch — the engine skips or refunds them — so these are
 * all batch preconditions or failures during execution.
 *
 * - config: the solver or protocol is misconfigured or paused; requeue and back off
 * - pool: the pool can't price the pair right now; requeue
 * - invalid: the batch itself is malformed (a solver bug); fail the intents
 * - unknown: unattributable; requeue with an attempt limit
 */
export type RevertPolicy = 'config' | 'pool' | 'invalid' | 'unknown';

const POLICIES: Record<string, RevertPolicy> = {
  OnlySolver: 'config',
  NotRegisteredEngine: 'config',
  SpraayNotConfigured: 'config',
  RouterPaused: 'config',
  EmptyPool: 'pool',
  PoolNotFound: 'pool',
  EmptyBatch: 'invalid',
  BatchTooLarge: 'invalid',
  SameToken: 'invalid',
};

export function revertPolicy(parsed: ParsedError): RevertPolicy {
  return (parsed.name && POLICIES[parsed.name]) || 'unknown';
}
