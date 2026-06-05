import { useEffect, useRef, useCallback } from 'react';
import type { Session, SseType } from '../types';

type Handler<T = unknown> = (data: T) => void;
type HandlerMap = Partial<Record<SseType, Handler>>;

/**
 * Subscribe to the server's SSE stream at /events.
 * Reconnects automatically on close/error (EventSource does this natively).
 */
export function useSSE(handlers: HandlerMap): void {
  // Keep a stable ref to the handlers so we don't re-subscribe on every render
  const handlersRef = useRef<HandlerMap>(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const es = new EventSource('/events');

    const dispatch = (type: SseType) => (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        handlersRef.current[type]?.(data);
      } catch (err) {
        console.warn('[SSE] Failed to parse event:', type, err);
      }
    };

    const types: SseType[] = [
      'snapshot', 'task', 'touch', 'plan',
      'graph', 'graph_error', 'graph_generating', 'done',
      'research_result', 'heartbeat',
    ];

    for (const type of types) {
      es.addEventListener(type, dispatch(type));
    }

    es.onerror = () => {
      // EventSource auto-reconnects; log for debugging only
      console.debug('[SSE] Connection error / reconnecting...');
    };

    return () => {
      es.close();
    };
  }, []); // run once
}
