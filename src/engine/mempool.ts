import { getAddress } from 'ethers';
import type { IntentStatus, PairKey, PendingIntent, SignedIntent } from '../types/intent.js';
import { intentId } from './signature.js';

const TERMINAL: ReadonlySet<IntentStatus> = new Set(['settled', 'refunded', 'expired', 'failed']);

/** How long finished intents stay queryable via GET /status */
const DEFAULT_RETENTION_MS = 60 * 60 * 1000;

export function pairKey(tokenX: string, tokenY: string): PairKey {
  const [a, b] = [tokenX.toLowerCase(), tokenY.toLowerCase()].sort();
  return `${a}-${b}`;
}

export class DuplicateIntentError extends Error {}

/**
 * In-memory intent store. Not persistent: intents have short deadlines and the solver
 * restarts clean.
 */
export class Mempool {
  private readonly byId = new Map<string, PendingIntent>();
  private readonly byPair = new Map<PairKey, Set<string>>();
  /** "vault:sessionKey:nonce" of every live (non-terminal) intent, to reject nonce conflicts */
  private readonly liveNonces = new Map<string, string>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly retentionMs = DEFAULT_RETENTION_MS,
  ) {}

  add(intent: SignedIntent): PendingIntent {
    const id = intentId(intent);
    if (this.byId.has(id)) throw new DuplicateIntentError('intent already submitted');

    const nonceKey = this.nonceKey(intent);
    if (this.liveNonces.has(nonceKey)) {
      throw new DuplicateIntentError('another live intent already uses this session key nonce');
    }

    const pending: PendingIntent = {
      ...intent,
      vault: getAddress(intent.vault),
      sessionKey: getAddress(intent.sessionKey),
      tokenIn: getAddress(intent.tokenIn),
      tokenOut: getAddress(intent.tokenOut),
      id,
      receivedAt: this.now(),
      status: 'pending',
    };

    this.byId.set(id, pending);
    this.liveNonces.set(nonceKey, id);
    const key = pairKey(pending.tokenIn, pending.tokenOut);
    let set = this.byPair.get(key);
    if (!set) this.byPair.set(key, (set = new Set()));
    set.add(id);
    return pending;
  }

  get(id: string): PendingIntent | undefined {
    return this.byId.get(id);
  }

  setStatus(id: string, status: IntentStatus, patch: Partial<PendingIntent> = {}): PendingIntent | undefined {
    const intent = this.byId.get(id);
    if (!intent) return undefined;
    Object.assign(intent, patch, { status });
    if (TERMINAL.has(status)) {
      this.liveNonces.delete(this.nonceKey(intent));
      this.byPair.get(pairKey(intent.tokenIn, intent.tokenOut))?.delete(id);
    }
    return intent;
  }

  /** Pairs that currently have at least one pending intent */
  activePairs(): PairKey[] {
    return [...this.byPair.entries()]
      .filter(([, ids]) => [...ids].some((id) => this.byId.get(id)?.status === 'pending'))
      .map(([key]) => key);
  }

  /** Pending intents for a pair, oldest first */
  pending(key: PairKey): PendingIntent[] {
    const ids = this.byPair.get(key);
    if (!ids) return [];
    return [...ids]
      .map((id) => this.byId.get(id)!)
      .filter((i) => i.status === 'pending')
      .sort((x, y) => x.receivedAt - y.receivedAt);
  }

  pendingCount(): number {
    let n = 0;
    for (const intent of this.byId.values()) if (intent.status === 'pending') n++;
    return n;
  }

  /**
   * Mark pending intents whose deadline has passed as expired, and forget finished intents
   * older than the retention window. Returns the newly expired intents.
   */
  expire(): PendingIntent[] {
    const nowMs = this.now();
    const nowSec = Math.floor(nowMs / 1000);
    const expired: PendingIntent[] = [];
    for (const intent of this.byId.values()) {
      if (intent.status === 'pending' && intent.deadline <= nowSec) {
        this.setStatus(intent.id, 'expired');
        expired.push(intent);
      } else if (TERMINAL.has(intent.status) && nowMs - intent.receivedAt > this.retentionMs) {
        this.byId.delete(intent.id);
      }
    }
    return expired;
  }

  private nonceKey(intent: SignedIntent): string {
    return `${intent.vault.toLowerCase()}:${intent.sessionKey.toLowerCase()}:${intent.nonce}`;
  }
}
