import { describe, it, expect } from 'vitest';
import {
  characterIsLive,
  hasPersona,
  compileCharacterCard,
  selectResponders,
  parseCharacterReply,
  buildCharacterReplyHeaders,
  characterMentionedIn,
  normalizeWorld,
} from '../lib/character-replies.js';
import { normalizeCharacters } from '../lib/characters.js';

const dana = {
  id: 'dana',
  name: 'Dana Reyes',
  email: 'dana@acme-vendor.com',
  role: 'Vendor account manager',
  persona: { goal: 'Close the deal', personality: 'Firm but fair' },
};
const marcus = {
  id: 'marcus',
  name: 'Marcus Bell',
  email: 'marcus.bell@example.com',
  role: 'Customer',
  prompt: 'You are frustrated but reasonable.',
};
const morgan = {
  id: 'morgan',
  name: 'Morgan Hale',
  email: 'morgan.hale@northwind.co',
  role: 'Hiring manager',
};
const priyaSilent = {
  id: 'priya',
  name: 'Priya Nair',
  email: 'priya@brightlabs.io',
  role: 'Partner',
  responds: false,
  persona: { personality: 'Warm' },
};

const directory = normalizeCharacters([dana, marcus, morgan, priyaSilent]);

describe('live vs directory-only', () => {
  it('treats persona or prompt as live, and explicit responds as override', () => {
    expect(hasPersona(dana)).toBe(true);
    expect(characterIsLive(dana)).toBe(true);
    expect(characterIsLive(marcus)).toBe(true);
    expect(characterIsLive(morgan)).toBe(false);
    expect(characterIsLive(priyaSilent)).toBe(false);
    expect(characterIsLive({ ...morgan, responds: true })).toBe(true);
  });
});

describe('compileCharacterCard', () => {
  it('renders identity plus known persona fields, including extras', () => {
    const card = compileCharacterCard({
      ...dana,
      persona: {
        personality: 'Sharp',
        goal: 'Close',
        quirks: 'Drinks espresso',
      },
    });
    expect(card).toContain('You are Dana Reyes, Vendor account manager.');
    expect(card).toContain('Personality:');
    expect(card).toContain('Sharp');
    expect(card).toContain('Goal:');
    expect(card).toContain('Quirks:');
    expect(card).toContain('Drinks espresso');
  });
});

describe('normalizeWorld', () => {
  it('accepts a string or a summary object', () => {
    expect(normalizeWorld('Acme is negotiating.')).toBe('Acme is negotiating.');
    expect(normalizeWorld({ summary: 'Shared facts' })).toBe('Shared facts');
    expect(normalizeWorld(null)).toBe('');
  });
});

describe('selectResponders', () => {
  const email = (overrides) => ({
    to: [dana.email, marcus.email],
    cc: [morgan.email],
    body: 'Thanks for the proposal.',
    ...overrides,
  });

  it('returns the named person when the body asks for them', () => {
    const picked = selectResponders(
      email({ body: 'Dana, can you confirm the 24-month option?' }),
      directory,
    );
    expect(picked.map((c) => c.id)).toEqual(['dana']);
  });

  it('lets every clearly asked person reply', () => {
    const picked = selectResponders(
      email({ body: 'Dana — pricing? Marcus — can you confirm shipping?' }),
      directory,
    );
    expect(picked.map((c) => c.id).sort()).toEqual(['dana', 'marcus']);
  });

  it('picks one at random when nobody is clearly asked', () => {
    const picked = selectResponders(email(), directory, { random: () => 0 });
    expect(picked).toHaveLength(1);
    expect(['dana', 'marcus']).toContain(picked[0].id);
  });

  it('prefers a sole To recipient over Cc', () => {
    const picked = selectResponders(
      email({ to: [dana.email], cc: [marcus.email], body: 'Following up.' }),
      directory,
    );
    expect(picked.map((c) => c.id)).toEqual(['dana']);
  });

  it('skips done characters for the random pick but still replies if asked', () => {
    const random = selectResponders(email(), directory, {
      doneIds: ['dana', 'marcus'],
      random: () => 0,
    });
    expect(random).toHaveLength(1);

    const asked = selectResponders(
      email({ body: 'Dana, one more question on the term.' }),
      directory,
      { doneIds: ['dana'] },
    );
    expect(asked.map((c) => c.id)).toEqual(['dana']);
  });

  it('does not animate directory-only people', () => {
    const picked = selectResponders(
      { to: [morgan.email], cc: [], body: 'Morgan, can you join the panel?' },
      directory,
    );
    expect(picked).toEqual([]);
  });
});

describe('characterMentionedIn', () => {
  it('matches full name, first name, or email', () => {
    expect(characterMentionedIn(dana, 'Hi Dana — circling back.')).toBe(true);
    expect(characterMentionedIn(dana, 'Please ask dana@acme-vendor.com.')).toBe(true);
    expect(characterMentionedIn(dana, 'Hi team, circling back.')).toBe(false);
  });
});

describe('parseCharacterReply', () => {
  it('strips a trailing [[done]] / [[continue]] tag', () => {
    expect(parseCharacterReply('Thanks, that works.\n\n[[done]]')).toEqual({
      body: 'Thanks, that works.',
      done: true,
    });
    expect(parseCharacterReply('Could you send a redline?\n[[continue]]')).toEqual({
      body: 'Could you send a redline?',
      done: false,
    });
  });

  it('treats a short "nothing left to say" body as done', () => {
    expect(parseCharacterReply('I have nothing left to say.')).toMatchObject({ done: true });
  });
});

describe('buildCharacterReplyHeaders', () => {
  it('reply-alls to the learner and remaining recipients', () => {
    expect(
      buildCharacterReplyHeaders(
        {
          from: { name: 'You', email: 'you@company.com' },
          to: [dana.email, marcus.email],
          cc: [morgan.email],
          subject: 'Proposal for annual license',
        },
        dana,
        { learnerEmail: 'you@company.com' },
      ),
    ).toEqual({
      to: ['you@company.com', marcus.email],
      cc: [morgan.email],
      subject: 'Re: Proposal for annual license',
    });
  });
});
