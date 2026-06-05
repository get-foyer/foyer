import type { Session, TouchPoint, ResearchResult } from '../src/types.js';

export type { Session };

const sessions = new Map<string, Session>();
let activeSessionId: string | null = null;

export function getActiveSessionId(): string | null {
  return activeSessionId;
}

export function getActiveSession(): Session | null {
  return activeSessionId ? (sessions.get(activeSessionId) ?? null) : null;
}

export function getSession(id: string): Session | null {
  return sessions.get(id) ?? null;
}

export function startSession(sessionId: string, prompt: string): Session {
  const session: Session = {
    sessionId,
    status: 'working',
    prompt,
    plan: null,
    graph: null,
    graphStatus: 'idle',
    graphError: null,
    touchPoints: [],
    research: [],
    startedAt: Date.now(),
    finishedAt: null,
  };
  sessions.set(sessionId, session);
  activeSessionId = sessionId;
  return session;
}

export function addTouchPoint(sessionId: string, tp: TouchPoint): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.touchPoints.unshift(tp); // newest first
  return true;
}

export function setPlan(sessionId: string, plan: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.plan = plan;
  return true;
}

export function setGraphGenerating(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.graphStatus = 'generating';
  return true;
}

export function setGraph(sessionId: string, graph: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.graph = graph;
  s.graphStatus = 'ready';
  s.graphError = null;
  return true;
}

export function setGraphError(sessionId: string, error: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.graphStatus = 'error';
  s.graphError = error;
  return true;
}

export function finishSession(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.status = 'done';
  s.finishedAt = Date.now();
  return true;
}

export function addResearch(sessionId: string, result: ResearchResult): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.research.unshift(result); // newest first
  return true;
}
