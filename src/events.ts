import type { Mempool } from './engine/mempool.js';
import type { IntentStatus, PendingIntent } from './types/intent.js';

export type SolverEventName =
  | 'intent.accepted'
  | 'intent.matched'
  | 'intent.settling'
  | 'intent.settled'
  | 'intent.refunded'
  | 'intent.expired'
  | 'intent.failed'
  | 'batch.settled'
  | 'pool.price'
  | 'vault.swapExecuted'
  | 'vault.swapBlocked'
  | 'vault.circuitBreaker'
  | 'vault.frozen'
  | 'vault.unfrozen';

export interface SolverEvent {
  event: SolverEventName;
  /** JSON-safe payload (bigints already converted to decimal strings) */
  data: Record<string, unknown>;
  /** Set on vault-scoped events so WebSocket clients can filter by vault */
  vault?: string;
  timestamp: number;
}

type Subscriber = (event: SolverEvent) => void;

/** In-process fan-out of solver events (consumed by the WebSocket broadcaster) */
export class EventBus {
  private readonly subscribers = new Set<Subscriber>();

  publish(event: SolverEventName, data: Record<string, unknown>, vault?: string): void {
    const message: SolverEvent = { event, data: jsonSafe(data), vault, timestamp: Date.now() };
    for (const subscriber of this.subscribers) {
      try {
        subscriber(message);
      } catch (err) {
        console.error('[events] subscriber failed', err);
      }
    }
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }
}

/** Recursively convert bigints to decimal strings */
export function jsonSafe<T>(value: T): T {
  if (typeof value === 'bigint') return value.toString() as T;
  if (Array.isArray(value)) return value.map(jsonSafe) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)])) as T;
  }
  return value;
}

const STATUS_EVENTS: Partial<Record<IntentStatus, SolverEventName>> = {
  matched: 'intent.matched',
  settling: 'intent.settling',
  settled: 'intent.settled',
  refunded: 'intent.refunded',
  expired: 'intent.expired',
  failed: 'intent.failed',
};

export function intentEventData(intent: PendingIntent): Record<string, unknown> {
  return {
    intentId: intent.id,
    status: intent.status,
    vault: intent.vault,
    sessionKey: intent.sessionKey,
    tokenIn: intent.tokenIn,
    tokenOut: intent.tokenOut,
    amountIn: intent.amountIn,
    minAmountOut: intent.minAmountOut,
    nonce: intent.nonce,
    expectedOut: intent.expectedOut,
    amountOut: intent.amountOut,
    txHash: intent.txHash,
    batchId: intent.batchId,
    reason: intent.lastExclusion,
  };
}

/** Publish intent.* events for every mempool status change */
export function publishIntentEvents(mempool: Mempool, bus: EventBus): void {
  mempool.onStatusChange((intent, from) => {
    const name = from === null ? 'intent.accepted' : STATUS_EVENTS[intent.status];
    if (name) bus.publish(name, intentEventData(intent), intent.vault);
  });
}
