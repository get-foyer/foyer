// Shared types between the server (SSE payloads) and the React frontend.

export interface TouchPoint {
  path: string;
  tool: string;
  ts: number;
}

export interface ResearchLink {
  title: string;
  url: string;
}

export interface ResearchResult {
  topic: string;
  summary: string;
  links: ResearchLink[];
  ts: number;
}

export interface Session {
  sessionId: string;
  status: 'working' | 'done';
  prompt: string;
  plan: string | null;
  /** Mermaid graph TD syntax, populated asynchronously after plan capture. */
  graph: string | null;
  graphStatus: 'idle' | 'generating' | 'ready' | 'error';
  graphError: string | null;
  touchPoints: TouchPoint[];
  research: ResearchResult[];
  startedAt: number;
  finishedAt: number | null;
}

// SSE event types the server pushes to the browser
export type SseType =
  | 'snapshot'
  | 'task'
  | 'touch'
  | 'plan'
  | 'graph'
  | 'graph_error'
  | 'graph_generating'
  | 'done'
  | 'research_result'
  | 'heartbeat';
