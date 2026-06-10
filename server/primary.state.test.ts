import { describe, it, expect, beforeEach } from 'vitest';
import {
  _resetStateForTest,
  startSession,
  setActivity,
  addResearch,
  addResearchInFlight,
  getSession,
  designatePrimary,
  setPrimaryReady,
  recordPrimaryFailure,
  retryPrimary,
  dismissPrimary,
  clearPrimary,
  markResearchRead,
} from './state.js';
import type { ResearchResult } from '../src/types.js';

const briefing = (topic: string, over: Partial<ResearchResult> = {}): ResearchResult => ({
  topic,
  lede: '',
  sections: [{ heading: topic, body: 'body' }],
  links: [],
  ts: Date.now(),
  ...over,
});

const activity = (topics: { topic: string; reason: string }[]) => ({
  summary: 'working',
  topics,
  turnSeq: 1,
  turnPrompt: 'p',
  allowAppend: true,
});

beforeEach(() => {
  _resetStateForTest();
  startSession('s1', 'build the thing');
});

describe('primary designation lifecycle', () => {
  it('designates as warming with reason/docs and persists on the session', () => {
    const p = designatePrimary('s1', {
      topic: 'DNS rebinding guard',
      reason: 'editing security',
      docs: [{ path: 'docs/a.md', title: 'A' }],
    });
    expect(p?.status).toBe('warming');
    expect(getSession('s1')?.primary?.reason).toBe('editing security');
    expect(getSession('s1')?.primary?.docs).toEqual([{ path: 'docs/a.md', title: 'A' }]);
  });

  it('is born READY when the topic was already researched (briefing exists, unread)', () => {
    addResearch('s1', briefing('DNS rebinding guard'));
    const p = designatePrimary('s1', { topic: 'DNS rebinding guard', reason: 'r' });
    expect(p?.status).toBe('ready');
    expect(p?.readyMs).toBe(0);
  });

  it('refuses to designate a dismissed topic', () => {
    designatePrimary('s1', { topic: 'Bad pick', reason: 'r' });
    dismissPrimary('s1');
    expect(designatePrimary('s1', { topic: 'Bad pick', reason: 'r' })).toBeNull();
    expect(getSession('s1')?.primary ?? null).toBeNull();
  });

  it('warming → ready freezes time-to-ready; only the matching topic can flip it', () => {
    designatePrimary('s1', { topic: 'T', reason: 'r' });
    expect(setPrimaryReady('s1', 'Other', 1000)).toBe(false);
    expect(setPrimaryReady('s1', 't', 1234)).toBe(true); // case-insensitive identity
    const p = getSession('s1')?.primary;
    expect(p?.status).toBe('ready');
    expect(p?.readyMs).toBe(1234);
    // ready → ready again is rejected (status guard)
    expect(setPrimaryReady('s1', 'T', 99)).toBe(false);
  });

  it('two failures flip warming → error; retry resets to warming with failures cleared', () => {
    designatePrimary('s1', { topic: 'T', reason: 'r' });
    expect(recordPrimaryFailure('s1', 'T')).toBe(false); // ×1 — still warming
    expect(getSession('s1')?.primary?.status).toBe('warming');
    expect(recordPrimaryFailure('s1', 'T')).toBe(true); // ×2 — error
    expect(getSession('s1')?.primary?.status).toBe('error');
    expect(getSession('s1')?.primary?.failures).toBe(2);
    const retried = retryPrimary('s1');
    expect(retried?.status).toBe('warming');
    expect(retried?.failures).toBe(0);
    // retry only works from error
    expect(retryPrimary('s1')).toBeNull();
  });

  it('opening the PRIMARY briefing flips ready → read via the shared readAt write (DR10)', () => {
    const b = briefing('T');
    addResearch('s1', b);
    designatePrimary('s1', { topic: 'T', reason: 'r' });
    expect(getSession('s1')?.primary?.status).toBe('ready');
    markResearchRead('s1', b.ts);
    expect(getSession('s1')?.primary?.status).toBe('read');
    expect(getSession('s1')?.research[0].readAt).not.toBeNull();
  });

  it('opening a NON-primary briefing leaves the primary untouched', () => {
    const other = briefing('Other');
    addResearch('s1', other);
    designatePrimary('s1', { topic: 'T', reason: 'r' });
    markResearchRead('s1', other.ts);
    expect(getSession('s1')?.primary?.status).toBe('warming');
  });

  it('clearPrimary demotes (pointer only — the briefing stays in research[])', () => {
    const b = briefing('T');
    addResearch('s1', b);
    designatePrimary('s1', { topic: 'T', reason: 'r' });
    expect(clearPrimary('s1')).toBe(true);
    expect(getSession('s1')?.primary ?? null).toBeNull();
    expect(getSession('s1')?.research).toHaveLength(1);
  });
});

describe('dismissPrimary (eng D18 / design DR8)', () => {
  it('excludes the topic, drops its chip, marks its unread briefing read, clears the pointer', () => {
    setActivity(
      's1',
      activity([
        { topic: 'T', reason: 'r' },
        { topic: 'U', reason: 'r2' },
      ]),
    );
    const b = briefing('T');
    addResearch('s1', b);
    designatePrimary('s1', { topic: 'T', reason: 'r' });
    const dismissed = dismissPrimary('s1');
    expect(dismissed?.topic).toBe('T');
    const s = getSession('s1')!;
    expect(s.primary ?? null).toBeNull();
    expect(s.dismissedTopics).toEqual(['t']);
    expect(s.suggestedTopics.map((t) => t.topic)).toEqual(['U']);
    expect(s.research[0].readAt).not.toBeNull(); // out of the way, in the read rows
  });

  it('returns null with no primary (idempotent route path)', () => {
    expect(dismissPrimary('s1')).toBeNull();
  });

  it('dismissed topics never re-enter suggestions on later ticks', () => {
    designatePrimary('s1', { topic: 'T', reason: 'r' });
    dismissPrimary('s1');
    setActivity(
      's1',
      activity([
        { topic: 'T', reason: 'again' },
        { topic: 'U', reason: 'r2' },
      ]),
    );
    expect(getSession('s1')?.suggestedTopics.map((t) => t.topic)).toEqual(['U']);
  });
});

describe('CRITICAL regression — topics filtering unchanged with the primary machinery present', () => {
  it('still excludes researched and in-flight topics exactly as before', () => {
    addResearch('s1', briefing('Researched'));
    addResearchInFlight('s1', 'InFlight');
    designatePrimary('s1', { topic: 'Primary T', reason: 'r' });
    setActivity(
      's1',
      activity([
        { topic: 'Researched', reason: 'x' },
        { topic: 'InFlight', reason: 'y' },
        { topic: 'Fresh', reason: 'z' },
        { topic: 'Primary T', reason: 'w' },
      ]),
    );
    // Researched + in-flight drop (as shipped); the PRIMARY topic is NOT server-filtered —
    // the client excludes it from chips by topicKey (design DR5), the server list stays honest.
    expect(getSession('s1')?.suggestedTopics.map((t) => t.topic)).toEqual(['Fresh', 'Primary T']);
  });

  it('setActivity persists touchedAreas/contextDocs when provided (the D14 flush)', () => {
    setActivity('s1', {
      ...activity([]),
      touchedAreas: ['server/providers'],
      contextDocs: [{ path: 'docs/a.md', title: 'A' }],
    });
    const s = getSession('s1')!;
    expect(s.touchedAreas).toEqual(['server/providers']);
    expect(s.contextDocs).toEqual([{ path: 'docs/a.md', title: 'A' }]);
  });
});
