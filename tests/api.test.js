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
    expect(res.body.email.to[0].email).toBe('dana@acme-vendor.com');
    // scenario.example.json enables a multi_turn simulated recipient
    expect(res.body.recipient.allowed).toBe(true);
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

  it('DELETE /api/sessions/:id removes the session', async () => {
    const del = await request(app).delete(`/api/sessions/${sessionId}`);
    expect(del.status).toBe(200);
    const reload = await request(app).get('/api/session').query({ id: sessionId });
    expect(reload.status).toBe(404);
  });
});
