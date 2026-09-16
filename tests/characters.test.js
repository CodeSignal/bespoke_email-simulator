import { describe, it, expect } from 'vitest';
import {
  normalizeCharacters,
  constrainToCharacters,
  availableCharacters,
  characterByEmail,
  validateCharacters,
  emailsFromAddresses,
  normalizeAvatar,
  avatarPath,
  initialsFromName,
} from '../lib/characters.js';

const jordan = {
  id: 'jordan',
  name: 'Jordan Lee',
  email: 'jordan.lee@candidatemail.com',
  role: 'Candidate',
};
const morgan = {
  id: 'morgan',
  name: 'Morgan Hale',
  email: 'morgan.hale@northwind.co',
  role: 'Hiring manager',
  prompt: 'You are a concise hiring manager.',
};

describe('normalizeCharacters', () => {
  it('keeps extra persona fields and fills a missing id', () => {
    const [character] = normalizeCharacters([{ name: 'Priya Nair', email: 'priya@brightlabs.io', department: 'BD' }]);
    expect(character.id).toBe('priya');
    expect(character.department).toBe('BD');
  });

  it('drops entries without a name or email and de-duplicates', () => {
    expect(
      normalizeCharacters([
        { name: 'No Email' },
        jordan,
        { id: 'jordan', name: 'Jordan Clone', email: 'jordan.lee@candidatemail.com' },
        morgan,
      ]).map((character) => character.id),
    ).toEqual(['jordan', 'morgan']);
  });
});

describe('constrainToCharacters / availableCharacters', () => {
  const directory = normalizeCharacters([jordan, morgan]);

  it('keeps only directory emails and canonicalizes them', () => {
    expect(
      constrainToCharacters(
        ['Jordan.Lee@candidatemail.com', 'stranger@example.com', morgan.email],
        directory,
      ),
    ).toEqual([jordan.email, morgan.email]);
  });

  it('leaves addresses alone when no directory is configured', () => {
    expect(constrainToCharacters(['anyone@example.com'], [])).toEqual(['anyone@example.com']);
  });

  it('omits already-selected people and the learner', () => {
    expect(
      availableCharacters(directory, {
        selected: [jordan.email],
        exclude: ['recruiting@northwind.co', morgan.email],
      }).map((character) => character.id),
    ).toEqual([]);
  });

  it('looks up a character by email, case-insensitively', () => {
    expect(characterByEmail(directory, 'MORGAN.HALE@northwind.co')?.name).toBe('Morgan Hale');
  });
});

describe('avatars', () => {
  it('accepts 0–12, empty, and avatar-prefixed strings', () => {
    expect(normalizeAvatar(0)).toBe(0);
    expect(normalizeAvatar('empty')).toBe(0);
    expect(normalizeAvatar('avatar-00')).toBe(0);
    expect(normalizeAvatar(5)).toBe(5);
    expect(normalizeAvatar('12')).toBe(12);
    expect(normalizeAvatar('avatar-03')).toBe(3);
    expect(normalizeAvatar(-1)).toBeNull();
    expect(normalizeAvatar(13)).toBeNull();
    expect(avatarPath(0)).toBe('/avatars/avatar-00.svg');
    expect(avatarPath(5)).toBe('/avatars/avatar-05.png');
  });

  it('builds initials from a display name', () => {
    expect(initialsFromName('Jordan Lee')).toBe('JL');
    expect(initialsFromName('Priya')).toBe('PR');
    expect(initialsFromName('')).toBe('?');
  });

  it('stores a valid avatar on the character and flags a bad one', () => {
    expect(normalizeCharacters([{ ...jordan, avatar: 11 }])[0].avatar).toBe(11);
    expect(normalizeCharacters([{ ...jordan, avatar: 0 }])[0].avatar).toBe(0);
    expect(validateCharacters([{ ...jordan, avatar: 99 }]).some((error) => error.includes('avatar'))).toBe(true);
  });
});

describe('validateCharacters', () => {
  it('requires name, email, and unique ids/emails', () => {
    const errors = validateCharacters([
      { id: 'a', name: 'A' },
      { id: 'a', name: 'B', email: 'b@x.com' },
      { id: 'c', name: 'C', email: 'b@x.com' },
    ]);
    expect(errors.some((error) => error.includes('characters[0].email'))).toBe(true);
    expect(errors.some((error) => error.includes('.id is not unique'))).toBe(true);
    expect(errors.some((error) => error.includes('.email is not unique'))).toBe(true);
  });
});

describe('emailsFromAddresses', () => {
  it('accepts strings, objects, and comma-delimited values', () => {
    expect(emailsFromAddresses('a@x.com, b@x.com')).toEqual(['a@x.com', 'b@x.com']);
    expect(emailsFromAddresses([{ email: 'a@x.com' }, 'b@x.com'])).toEqual(['a@x.com', 'b@x.com']);
  });
});
