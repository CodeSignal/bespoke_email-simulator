import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCRIPT = join(ROOT, 'extract-conversations.js');

describe('extract-conversations provenance', () => {
  let dir;
  let sessionsFile;
  let scenarioFile;
  let outputFile;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cmail-extract-'));
    sessionsFile = join(dir, 'sessions.json');
    scenarioFile = join(dir, 'scenario.json');
    outputFile = join(dir, 'out.md');
    writeFileSync(
      scenarioFile,
      JSON.stringify({
        id: 'test',
        assistant: { enabled: true },
        characters: [{ id: 'dana', name: 'Dana', email: 'dana@acme-vendor.com' }],
      }),
    );
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('includes AI draft provenance events in assistant mode', () => {
    writeFileSync(
      sessionsFile,
      JSON.stringify({
        sessions: [
          {
            session_id: 's1',
            updated_at: '2026-01-02T00:00:00.000Z',
            created_at: '2026-01-01T00:00:00.000Z',
            threads: [],
            assistant_messages: [
              { role: 'user', content: 'Draft a reply' },
              {
                role: 'assistant',
                content: 'Here is a draft.',
                drafts: [
                  {
                    draftId: 'draft-1',
                    to: ['dana@acme-vendor.com'],
                    subject: 'Re: Proposal',
                    body: 'Thanks Dana.',
                  },
                ],
              },
            ],
            events: [
              {
                type: 'draft_proposed',
                timestamp: '2026-01-02T00:01:00.000Z',
                draftId: 'draft-1',
                source: 'propose-draft',
                draft: {
                  to: ['dana@acme-vendor.com'],
                  cc: [],
                  subject: 'Re: Proposal',
                  body: 'Thanks Dana.',
                },
              },
              {
                type: 'draft_inserted',
                timestamp: '2026-01-02T00:02:00.000Z',
                draftId: 'draft-1',
                source: 'propose-draft',
                scope: { scope: 'reply', threadId: 'thread-1' },
                draft: {
                  to: ['dana@acme-vendor.com'],
                  cc: [],
                  subject: 'Re: Proposal',
                  body: 'Thanks Dana.',
                },
              },
              {
                type: 'draft_sent',
                timestamp: '2026-01-02T00:03:00.000Z',
                draftId: 'draft-1',
                emailId: 'email-9',
                editDistance: {
                  body: 4,
                  subject: 0,
                  to: { added: 0, removed: 0, total: 0 },
                  cc: { added: 0, removed: 0, total: 0 },
                  total: 4,
                },
                sent: {
                  to: ['dana@acme-vendor.com'],
                  subject: 'Re: Proposal',
                  body: 'Thanks Dana — edited.',
                },
              },
              {
                type: 'quick_action',
                timestamp: '2026-01-02T00:04:00.000Z',
                action: 'suggested_replies',
                source: 'quick-action',
                threadId: 'thread-1',
                replies: ['Happy to discuss pricing next week.'],
              },
            ],
          },
        ],
      }),
    );

    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--mode', 'assistant', '--output', outputFile],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          SESSIONS_FILE: sessionsFile,
          SCENARIO_FILE: scenarioFile,
        },
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    const out = readFileSync(outputFile, 'utf8');
    expect(out).toContain('### AI draft provenance');
    expect(out).toContain('**Draft proposed**');
    expect(out).toContain('**Draft inserted**');
    expect(out).toContain('**Draft sent**');
    expect(out).toContain('body edit distance 4');
    expect(out).toContain('Proposed draft (structured)');
    expect(out).toContain('Thanks Dana.');
    expect(out).toContain('**Quick action** `suggested_replies`');
    expect(out).toContain('Happy to discuss pricing next week.');
  });

  it('includes sidecar rubric hints in report mode', () => {
    writeFileSync(
      sessionsFile,
      JSON.stringify({
        sessions: [
          {
            session_id: 's1',
            updated_at: '2026-01-02T00:00:00.000Z',
            created_at: '2026-01-01T00:00:00.000Z',
            threads: [],
            assistant_messages: [],
          },
        ],
      }),
    );
    writeFileSync(
      join(dir, 'rubric.json'),
      JSON.stringify({ notes: 'Reward a clear meeting ask.' }),
    );

    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--mode', 'report', '--output', outputFile, '--stdout'],
      {
        env: {
          ...process.env,
          SESSIONS_FILE: sessionsFile,
          SCENARIO_FILE: scenarioFile,
        },
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    const out = readFileSync(outputFile, 'utf8');
    expect(out).toContain('### Rubric hints');
    expect(out).toContain('Reward a clear meeting ask.');
  });

  it('errors when --rubric points at a missing file in report mode', () => {
    writeFileSync(sessionsFile, JSON.stringify({ sessions: [] }));
    const missing = join(dir, 'missing-rubric.json');
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--mode', 'report', '--rubric', missing, '--output', outputFile, '--stdout'],
      {
        env: {
          ...process.env,
          SESSIONS_FILE: sessionsFile,
          SCENARIO_FILE: scenarioFile,
        },
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('rubric file not found');
  });

  it('skips rubric loading outside report mode', () => {
    writeFileSync(sessionsFile, JSON.stringify({ sessions: [] }));
    const missing = join(dir, 'missing-rubric.json');
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--mode', 'full', '--rubric', missing, '--output', outputFile],
      {
        env: {
          ...process.env,
          SESSIONS_FILE: sessionsFile,
          SCENARIO_FILE: scenarioFile,
        },
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(0);
  });
});
