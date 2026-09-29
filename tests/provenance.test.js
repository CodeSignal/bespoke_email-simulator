import { describe, it, expect } from 'vitest';
import {
  appendSessionEvents,
  draftEditDistance,
  draftFieldsToMarkdown,
  draftsFromMessageParts,
  EVENT_TYPES,
  levenshtein,
  makeDraftInsertedEvent,
  makeDraftProposedEvent,
  makeDraftSentEvent,
  normalizeDraftFields,
  PROPOSE_DRAFT_TOOL,
} from '../lib/provenance.js';

describe('normalizeDraftFields', () => {
  it('splits comma-separated recipients and trims body', () => {
    expect(
      normalizeDraftFields({
        to: 'a@x.com, b@y.com',
        cc: 'c@z.com',
        subject: ' Hello ',
        body: '\n\nHi there.\n',
      }),
    ).toEqual({
      to: ['a@x.com', 'b@y.com'],
      cc: ['c@z.com'],
      subject: 'Hello',
      body: 'Hi there.',
    });
  });

  it('accepts array recipients', () => {
    expect(normalizeDraftFields({ to: ['a@x.com'], cc: [], subject: 'S', body: 'B' })).toEqual({
      to: ['a@x.com'],
      cc: [],
      subject: 'S',
      body: 'B',
    });
  });
});

describe('draftFieldsToMarkdown', () => {
  it('round-trips header lines for parseInsertedDraft', () => {
    expect(
      draftFieldsToMarkdown({
        to: ['dana@acme-vendor.com'],
        cc: ['sam@example.com'],
        subject: 'Re: Proposal',
        body: 'Thanks.',
      }),
    ).toBe(
      'To: dana@acme-vendor.com\nCc: sam@example.com\nSubject: Re: Proposal\n\nThanks.',
    );
  });
});

describe('draftsFromMessageParts', () => {
  it('extracts propose_draft tool calls into draft cards + events', () => {
    const { drafts, events } = draftsFromMessageParts([
      { type: 'text', text: 'Here you go.' },
      {
        type: 'tool-call',
        toolName: PROPOSE_DRAFT_TOOL,
        toolCallId: 'call-1',
        status: 'done',
        args: {
          to: 'dana@acme-vendor.com',
          subject: 'Re: Proposal',
          body: 'I can do 24 months.',
        },
      },
    ]);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      toolCallId: 'call-1',
      to: ['dana@acme-vendor.com'],
      subject: 'Re: Proposal',
      body: 'I can do 24 months.',
      source: PROPOSE_DRAFT_TOOL,
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(EVENT_TYPES.DRAFT_PROPOSED);
    expect(events[0].toolCallId).toBe('call-1');
  });

  it('keeps draft cards when toolCallId was already logged, but skips events', () => {
    const seen = new Set(['call-1']);
    const { drafts, events } = draftsFromMessageParts(
      [
        {
          type: 'tool-call',
          toolName: PROPOSE_DRAFT_TOOL,
          toolCallId: 'call-1',
          status: 'done',
          args: { to: 'a@x.com', subject: 'S', body: 'B' },
        },
      ],
      { seenToolCallIds: seen },
    );
    expect(drafts).toHaveLength(1);
    expect(events).toEqual([]);
  });
});

describe('edit distance + sent event', () => {
  it('computes levenshtein and recipient set distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    const dist = draftEditDistance(
      {
        to: ['dana@acme-vendor.com'],
        cc: [],
        subject: 'Re: Proposal',
        body: 'I can do 24 months.',
      },
      {
        to: ['dana@acme-vendor.com', 'sam@example.com'],
        cc: [],
        subject: 'Re: Proposal',
        body: 'I can do 24 months for 15%.',
      },
    );
    expect(dist.subject).toBe(0);
    expect(dist.body).toBeGreaterThan(0);
    expect(dist.to.added).toBe(1);
    expect(dist.total).toBe(dist.body + dist.to.total);
  });

  it('makeDraftSentEvent includes editDistance when insert baseline exists', () => {
    const event = makeDraftSentEvent({
      draftId: 'draft-1',
      emailId: 'email-1',
      inserted: { to: ['a@x.com'], subject: 'Hi', body: 'Hello' },
      sent: { to: ['a@x.com'], subject: 'Hi', body: 'Hello there' },
    });
    expect(event.type).toBe(EVENT_TYPES.DRAFT_SENT);
    expect(event.editDistance.body).toBeGreaterThan(0);
  });
});

describe('appendSessionEvents', () => {
  it('dedupes draft_proposed by toolCallId', () => {
    const first = makeDraftProposedEvent({
      draftId: 'd1',
      toolCallId: 'call-1',
      draft: { to: ['a@x.com'], subject: 'S', body: 'B' },
    });
    const second = makeDraftProposedEvent({
      draftId: 'd2',
      toolCallId: 'call-1',
      draft: { to: ['a@x.com'], subject: 'S', body: 'B' },
    });
    const inserted = makeDraftInsertedEvent({
      draftId: 'd1',
      draft: { to: ['a@x.com'], subject: 'S', body: 'B' },
    });
    const out = appendSessionEvents([], [first, second, inserted]);
    expect(out.filter((e) => e.type === EVENT_TYPES.DRAFT_PROPOSED)).toHaveLength(1);
    expect(out.filter((e) => e.type === EVENT_TYPES.DRAFT_INSERTED)).toHaveLength(1);
  });
});
