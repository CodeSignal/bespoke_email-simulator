import { describe, it, expect } from 'vitest';
import {
  newSessionRecord,
  findSession,
  latestSession,
  upsertSession,
  removeSession,
  toClientSession,
} from '../lib/sessions.js';

const seedThreads = [{ id: 'thread-1', subject: 'Hi', emails: [{ id: 'e1', body: 'a' }] }];

describe('newSessionRecord', () => {
  it('seeds a deep copy of the threads and initializes empty state', () => {
    const rec = newSessionRecord('scn-1', seedThreads);
    expect(rec.session_id).toBeTruthy();
    expect(rec.scenario_id).toBe('scn-1');
    expect(rec.threads).toHaveLength(1);
    expect(rec.drafts).toEqual([]);
    expect(rec.assistant_messages).toEqual([]);
    // deep clone — mutating the copy must not touch the seed
    rec.threads[0].emails[0].body = 'changed';
    expect(seedThreads[0].emails[0].body).toBe('a');
  });
});

describe('session collection ops', () => {
  it('upserts, finds, and removes; latest tracks updated_at', async () => {
    const data = { sessions: [] };
    const a = newSessionRecord('scn', seedThreads);
    upsertSession(data, a);
    expect(findSession(data, a.session_id)).toBeTruthy();
    expect(data.sessions).toHaveLength(1);

    // update in place
    a.drafts.push({ subject: 'Re', body: 'x' });
    upsertSession(data, a);
    expect(data.sessions).toHaveLength(1);
    expect(findSession(data, a.session_id).drafts).toHaveLength(1);

    // second, newer session becomes latest
    await new Promise((r) => setTimeout(r, 5));
    const b = newSessionRecord('scn', seedThreads);
    upsertSession(data, b);
    expect(latestSession(data).session_id).toBe(b.session_id);

    removeSession(data, a.session_id);
    expect(findSession(data, a.session_id)).toBeNull();
    expect(data.sessions).toHaveLength(1);
  });
});

describe('toClientSession', () => {
  it('maps internal fields to the client shape', () => {
    const rec = newSessionRecord('scn', seedThreads);
    const client = toClientSession(rec);
    expect(client.sessionId).toBe(rec.session_id);
    expect(client.threads).toHaveLength(1);
  });
});
