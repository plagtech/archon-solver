import type { Server } from 'node:http';
import { isAddress } from 'ethers';
import { WebSocket, WebSocketServer } from 'ws';
import type { EventBus, SolverEvent } from '../events.js';

export interface WebSocketOptions {
  path?: string;
  heartbeatMs?: number;
  /** Disconnect clients that fall this far behind instead of buffering without bound */
  maxBufferedBytes?: number;
  maxClients?: number;
}

interface ClientState {
  alive: boolean;
  /** Only vault-scoped events for these vaults (lowercase); null = all vaults */
  vaults: Set<string> | null;
  /** Event names, or "prefix.*" patterns; null = all events */
  events: string[] | null;
}

/**
 * Real-time event stream at /ws.
 *
 * Every client receives every event until it narrows the stream:
 *   → {"op":"subscribe","vaults":["0x…"],"events":["intent.*","batch.settled"]}
 *   → {"op":"unsubscribe"}            back to everything
 *   → {"op":"ping"}                   ← {"event":"pong"}
 * Vault filters apply only to vault-scoped events (intent.*, vault.*); batch.settled and
 * pool.price reach every client whose event filter allows them.
 */
export function attachWebSocket(server: Server, bus: EventBus, options: WebSocketOptions = {}) {
  const { path = '/ws', heartbeatMs = 30_000, maxBufferedBytes = 1 << 20, maxClients = 1_000 } = options;
  const wss = new WebSocketServer({ server, path, maxPayload: 16 * 1024 });
  const clients = new Map<WebSocket, ClientState>();

  wss.on('connection', (ws) => {
    if (clients.size >= maxClients) {
      ws.close(1013, 'too many clients');
      return;
    }
    const state: ClientState = { alive: true, vaults: null, events: null };
    clients.set(ws, state);

    ws.on('pong', () => (state.alive = true));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    ws.on('message', (raw) => {
      const reply = handleMessage(state, raw.toString());
      if (reply) send(ws, reply);
    });
    send(ws, { event: 'hello', data: { subscribe: 'send {"op":"subscribe","vaults":[...],"events":[...]}' } });
  });

  const unsubscribe = bus.subscribe((event) => {
    let payload: string | undefined;
    for (const [ws, state] of clients) {
      if (ws.readyState !== WebSocket.OPEN || !matches(state, event)) continue;
      if (ws.bufferedAmount > maxBufferedBytes) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      payload ??= JSON.stringify(event);
      ws.send(payload);
    }
  });

  const heartbeat = setInterval(() => {
    for (const [ws, state] of clients) {
      if (!state.alive) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }, heartbeatMs);

  return {
    clientCount: () => clients.size,
    close: () => {
      clearInterval(heartbeat);
      unsubscribe();
      for (const ws of clients.keys()) ws.close(1001, 'server shutting down');
      wss.close();
    },
  };
}

function send(ws: WebSocket, message: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ timestamp: Date.now(), ...message }));
}

function matches(state: ClientState, event: SolverEvent): boolean {
  if (state.vaults && event.vault && !state.vaults.has(event.vault.toLowerCase())) return false;
  if (state.events) {
    return state.events.some((pattern) =>
      pattern.endsWith('.*') ? event.event.startsWith(pattern.slice(0, -1)) : pattern === event.event,
    );
  }
  return true;
}

function handleMessage(state: ClientState, raw: string): Record<string, unknown> | null {
  let msg: { op?: unknown; vaults?: unknown; events?: unknown };
  try {
    msg = JSON.parse(raw);
  } catch {
    return { event: 'error', data: { message: 'invalid JSON' } };
  }

  switch (msg.op) {
    case 'ping':
      return { event: 'pong' };
    case 'unsubscribe':
      state.vaults = null;
      state.events = null;
      return { event: 'subscribed', data: { vaults: null, events: null } };
    case 'subscribe': {
      if (msg.vaults !== undefined) {
        if (!Array.isArray(msg.vaults) || !msg.vaults.every((v) => typeof v === 'string' && isAddress(v))) {
          return { event: 'error', data: { message: 'vaults must be an array of addresses' } };
        }
        state.vaults = new Set(msg.vaults.map((v: string) => v.toLowerCase()));
      }
      if (msg.events !== undefined) {
        if (!Array.isArray(msg.events) || !msg.events.every((e) => typeof e === 'string')) {
          return { event: 'error', data: { message: 'events must be an array of event names' } };
        }
        state.events = msg.events;
      }
      return {
        event: 'subscribed',
        data: { vaults: state.vaults ? [...state.vaults] : null, events: state.events },
      };
    }
    default:
      return { event: 'error', data: { message: 'unknown op (expected subscribe, unsubscribe or ping)' } };
  }
}
