import { useEffect, useRef, useState } from 'react';
import type { SseType } from '../types';

type Handler<T = unknown> = (data: T) => void;
type HandlerMap = Partial<Record<SseType, Handler>>;

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/**
 * Subscribe to the server's SSE stream at /events.
 * Reconnects automatically on close/error (EventSource does this natively).
 * Returns the current connection status so the UI can surface it.
 */
export function useSSE(handlers: HandlerMap): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');

  // Keep a stable ref to the handlers so we don't re-subscribe on every render
  const handlersRef = useRef<HandlerMap>(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  // Run once — handlersRef keeps handlers current without re-subscribing.
  useEffect(() => {
    const es = new EventSource('/events');

    es.onopen = () => setStatus('connected');

    es.onerror = () => {
      // EventSource auto-reconnects; map readyState to a display status
      setStatus(es.readyState === EventSource.CONNECTING ? 'reconnecting' : 'disconnected');
      console.debug('[SSE] Connection error / reconnecting...');
    };

    const dispatch = (type: SseType) => (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as unknown;
        handlersRef.current[type]?.(data);
      } catch (err) {
        console.warn('[SSE] Failed to parse event:', type, err);
      }
    };

    const types: SseType[] = [
      'snapshot',
      'task',
      'active',
      'touch',
      'activity',
      'activity_generating',
      'activity_error',
      'done',
      'waiting',
      'research_result',
      'research_primed',
      'heartbeat',
    ];

    for (const type of types) {
      es.addEventListener(type, dispatch(type));
    }

    return () => {
      es.close();
    };
  }, []); // run once

  return status;
}
