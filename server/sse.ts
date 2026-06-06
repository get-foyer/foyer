import type { Request, Response } from 'express';
import type { SseType } from '../src/types.js';
import { getAllSessions, getActiveSessionId } from './state.js';

// Active SSE client connections
const clients = new Set<Response>();

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
  sendTo(res, 'snapshot', { sessions: getAllSessions(), activeSessionId: getActiveSessionId() });

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
