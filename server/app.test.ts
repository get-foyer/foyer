import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { setActiveProvider, type LlmProvider } from './providers/index.js';
import { _resetStateForTest } from './state.js';

const app = createApp();

function stubProvider(over: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id: 'anthropic-api',
    isAvailable: async () => true,
    research: async () => ({ topic: 't', lede: '', sections: [], links: [], ts: 0 }),
    summarizeActivity: async () => ({ summary: '', topics: [] }),
    ...over,
  } as LlmProvider;
}

beforeEach(() => {
  _resetStateForTest();
});

describe('localhostGuard wiring', () => {
  it('rejects a DNS-rebound Host on /events', async () => {
    const res = await request(app).get('/events').set('Host', 'rebind.attacker.com');
    expect(res.status).toBe(403);
  });

  it('rejects a cross-origin POST', async () => {
    const res = await request(app)
      .post('/close')
      .set('Origin', 'https://attacker.example')
      .send({ sessionId: 'abc' });
    expect(res.status).toBe(403);
  });

  it('serves same-origin localhost requests', async () => {
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('body size limits', () => {
  it('413s a control route with an oversized body', async () => {
    const res = await request(app)
      .post('/pin')
      .send({ sessionId: 'abc', pinned: true, pad: 'x'.repeat(100 * 1024) });
    expect(res.status).toBe(413);
  });

  it('413s /hook past 1mb', async () => {
    const res = await request(app)
      .post('/hook')
      .send({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'abc',
        prompt: 'x'.repeat(2 * 1024 * 1024),
      });
    expect(res.status).toBe(413);
  });

  it('accepts a large-but-legit /hook prompt (500kb)', async () => {
    const res = await request(app)
      .post('/hook')
      .send({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'abc',
        prompt: 'x'.repeat(500 * 1024),
      });
    expect(res.status).toBe(200);
  });
});

describe('sessionId validation', () => {
  it('400s /close with a traversal-shaped id', async () => {
    const res = await request(app).post('/close').send({ sessionId: '../x' });
    expect(res.status).toBe(400);
  });

  it('400s /activity with an over-long id', async () => {
    const res = await request(app)
      .post('/activity')
      .send({ sessionId: 'a'.repeat(129) });
    expect(res.status).toBe(400);
  });

  it('accepts a valid id on /close', async () => {
    const res = await request(app).post('/close').send({ sessionId: 'abc-123' });
    expect(res.status).toBe(200);
  });
});

describe('/research error handling', () => {
  it('never leaks provider error detail to the client', async () => {
    setActiveProvider(
      stubProvider({
        research: async () => {
          throw new Error('ANTHROPIC_API_KEY=sk-ant-secret leaked from stderr');
        },
      }),
    );
    const res = await request(app).post('/research').send({ topic: 'event loops' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('sk-ant-secret');
    expect(res.body.error).toBe('Research failed — see the foyer server logs.');
  });
});
