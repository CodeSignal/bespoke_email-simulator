import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { rmSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = join(tmpdir(), `cmail-sessions-${process.pid}-${Date.now()}.json`);

// Isolate the server from the real sessions.json / scenario.json before import.
process.env.NODE_ENV = 'test';
process.env.SESSIONS_FILE = SESSIONS_FILE;
process.env.SCENARIO_FILE = join(__dirname, '..', 'scenario.example.json');
// Keep API tests off the live Octavus service: dotenv does not override
// pre-set vars, so blanking these makes the server treat the agent as unset.
process.env.OCTAVUS_AGENT_ID_PROD = '';
process.env.OCTAVUS_AGENT_ID_DEV = '';
process.env.OCTAVUS_AGENT_ID = '';

let app;
beforeAll(async () => {
  ({ app } = await import('../server.js'));
});
afterAll(() => {
  try { rmSync(SESSIONS_FILE); } catch { /* ignore */ }
});

describe('config & scenario routes', () => {
  it('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /api/config exposes client config without the seed and with strings', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('reply-to-vendor-negotiation');
    expect(res.body.seed).toBeUndefined();
    expect(res.body.strings).toBeTypeOf('object');
    expect(res.body.characters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'dana',
          name: 'Dana Reyes',
          email: 'dana@acme-vendor.com',
        }),
      ]),
    );
  });

  it('GET /api/scenario returns resolved seed threads', async () => {
    const res = await request(app).get('/api/scenario');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.threads)).toBe(true);
    expect(res.body.threads.length).toBeGreaterThan(0);
    expect(res.body.activeThreadId).toBe('thread-1');
  });
});

describe('session lifecycle', () => {
  let sessionId;

  it('POST /api/sessions seeds a session from the scenario inbox', async () => {
    const res = await request(app).post('/api/sessions');
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.threads.length).toBeGreaterThan(0);
    sessionId = res.body.sessionId;
  });

  it('POST /api/email/send appends an outbound email and allows a recipient reply', async () => {
    const res = await request(app)
      .post('/api/email/send')
      .send({
        sessionId,
        threadId: 'thread-1',
        to: ['dana@acme-vendor.com'],
        subject: 'Re: Proposal for annual license',
        body: 'Thanks Dana — I can commit to 24 months for a 15% discount.',
      });
    expect(res.status).toBe(200);
    expect(res.body.email.outbound).toBe(true);
    expect(res.body.email.to[0]).toEqual({ name: 'Dana Reyes', email: 'dana@acme-vendor.com' });
    expect(res.body.responders).toEqual([
      expect.objectContaining({ id: 'dana', email: 'dana@acme-vendor.com' }),
    ]);
  });

  it('POST /api/email/send rejects recipients outside the character directory', async () => {
    const res = await request(app)
      .post('/api/email/send')
      .send({
        sessionId,
        threadId: 'thread-1',
        to: ['stranger@example.com'],
        subject: 'Nope',
        body: 'This should not send.',
      });
    expect(res.status).toBe(400);
  });

  it('POST /api/email/send removes only the matching scoped draft', async () => {
    await request(app).post('/api/session/save').send({
      sessionId,
      drafts: [
        { scope: 'new', to: [], cc: [], subject: 'Keep me', body: 'new message draft' },
        { scope: 'reply', threadId: 'thread-1', to: ['dana@acme-vendor.com'], cc: [], subject: 'Re: Proposal', body: 'reply draft' },
      ],
    });

    const res = await request(app).post('/api/email/send').send({
      sessionId,
      threadId: 'thread-1',
      to: ['dana@acme-vendor.com'],
      subject: 'Re: Proposal',
      body: 'Sent reply.',
    });
    expect(res.status).toBe(200);

    const reload = await request(app).get('/api/session').query({ id: sessionId });
    expect(reload.body.drafts).toEqual([
      expect.objectContaining({ scope: 'new', subject: 'Keep me' }),
    ]);
  });

  it('POST /api/session/save persists drafts and assistant messages', async () => {
    const save = await request(app)
      .post('/api/session/save')
      .send({
        sessionId,
        drafts: [{ to: ['dana@acme-vendor.com'], cc: [], subject: 'WIP', body: 'draft body' }],
        assistantMessages: [{ role: 'user', content: 'help me' }],
      });
    expect(save.status).toBe(200);

    const reload = await request(app).get('/api/session').query({ id: sessionId });
    expect(reload.status).toBe(200);
    expect(reload.body.drafts[0].subject).toBe('WIP');
    expect(reload.body.assistantMessages[0].content).toBe('help me');
  });

  it('POST /api/session/events appends provenance events', async () => {
    const append = await request(app)
      .post('/api/session/events')
      .send({
        sessionId,
        events: [
          {
            type: 'draft_proposed',
            timestamp: '2026-01-02T00:01:00.000Z',
            draftId: 'draft-1',
            source: 'propose-draft',
            toolCallId: 'call-1',
            draft: {
              to: ['dana@acme-vendor.com'],
              cc: [],
              subject: 'Re: Proposal',
              body: 'Thanks.',
            },
          },
        ],
      });
    expect(append.status).toBe(200);
    expect(append.body.events).toHaveLength(1);

    // Duplicate toolCallId is ignored.
    const again = await request(app)
      .post('/api/session/events')
      .send({
        sessionId,
        events: [
          {
            type: 'draft_proposed',
            draftId: 'draft-2',
            toolCallId: 'call-1',
            draft: { to: ['dana@acme-vendor.com'], subject: 'Re: Proposal', body: 'Thanks.' },
          },
          {
            type: 'draft_inserted',
            draftId: 'draft-1',
            source: 'propose-draft',
            scope: { scope: 'reply', threadId: 'thread-1' },
            draft: { to: ['dana@acme-vendor.com'], subject: 'Re: Proposal', body: 'Thanks.' },
          },
        ],
      });
    expect(again.status).toBe(200);
    expect(again.body.events.map((e) => e.type)).toEqual(['draft_proposed', 'draft_inserted']);

    const reload = await request(app).get('/api/session').query({ id: sessionId });
    expect(reload.body.events).toHaveLength(2);
  });

  it('POST /api/assistant/clear wipes the assistant transcript', async () => {
    const clear = await request(app).post('/api/assistant/clear').send({ sessionId });
    expect(clear.status).toBe(200);
    expect(clear.body.ok).toBe(true);
    // No agent configured under test → no backing Octavus session is created.
    expect(clear.body.octavusSessionId).toBeNull();

    const reload = await request(app).get('/api/session').query({ id: sessionId });
    expect(reload.status).toBe(200);
    expect(reload.body.assistantMessages).toEqual([]);
    // Drafts are untouched.
    expect(reload.body.drafts[0].subject).toBe('WIP');
  });

  it('POST /api/assistant/clear rejects unknown sessions', async () => {
    const res = await request(app).post('/api/assistant/clear').send({ sessionId: 'nope' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/sessions/:id removes the session', async () => {
    const del = await request(app).delete(`/api/sessions/${sessionId}`);
    expect(del.status).toBe(200);
    const reload = await request(app).get('/api/session').query({ id: sessionId });
    expect(reload.status).toBe(404);
  });
});
