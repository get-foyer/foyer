import type { Request, Response } from 'express';
import type { SseType } from '../src/types.js';
import { getAllSessions, getActiveSessionId } from './state.js';

// Active SSE client connections
const clients = new Set<Response>();

/**
 * Injected getter for a session's currently-primed (warmed) research topics. Set at boot via
 * `setPrimedTopicsProvider(getPrimedTopics)` so this module never imports `prefetch.ts` — that
 * would create an `sse → prefetch → sse` cycle (prefetch imports `broadcast` from here).
 */
let primedTopicsProvider: ((sessionId: string) => string[]) | null = null;

export function setPrimedTopicsProvider(fn: (sessionId: string) => string[]): void {
  primedTopicsProvider = fn;
}

/**
 * Injected getter for a session's currently-warming (in-flight prefetch) topics — same boot-time
 * wiring as the primed provider, for the same no-import-cycle reason. Lets a reconnecting client
 * re-light the pulsing "warming" ring for the one topic the warm-loop is mid-research on.
 */
let warmingTopicsProvider: ((sessionId: string) => string[]) | null = null;

export function setWarmingTopicsProvider(fn: (sessionId: string) => string[]): void {
  warmingTopicsProvider = fn;
}

/** Register a new SSE client. Sends an initial snapshot and sets up cleanup. */
export function handleSseConnection(req: Request, res: Response): void {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // Send immediate snapshot so the browser isn't blank on connect/reconnect.
  // Carries all sessions (working + done) so tabs survive EventSource reconnects.
  const sessions = getAllSessions();
  sendTo(res, 'snapshot', { sessions, activeSessionId: getActiveSessionId() });

  // Replay primed-topic state AFTER the snapshot so reconnecting clients re-light the right
  // dots. The client resets its primed set on every snapshot, so this replay is the single
  // source of truth — a dot can never survive a server restart / TTL expiry it doesn't reflect.
  if (primedTopicsProvider) {
    for (const s of sessions) {
      for (const topic of primedTopicsProvider(s.sessionId)) {
        sendTo(res, 'research_primed', { sessionId: s.sessionId, topic });
      }
    }
  }

  // Likewise replay any in-flight warm so the ring re-lights on reconnect. The client clears its
  // warming set on every snapshot, so this replay (like the primed one) is the source of truth.
  if (warmingTopicsProvider) {
    for (const s of sessions) {
      for (const topic of warmingTopicsProvider(s.sessionId)) {
        sendTo(res, 'research_warming', { sessionId: s.sessionId, topic, active: true });
      }
    }
  }

  clients.add(res);

  // Heartbeat every 25s to keep the connection alive through proxies
  const heartbeat = setInterval(() => sendTo(res, 'heartbeat', null), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

/** Broadcast an SSE event to all connected clients. */
export function broadcast(type: SseType, data: unknown): void {
  for (const client of clients) {
    sendTo(client, type, data);
  }
}

function sendTo(res: Response, type: SseType, data: unknown): void {
  try {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Client already gone; will be cleaned up on close event
  }
}
