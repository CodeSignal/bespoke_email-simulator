import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { defaultRubricPath, rubricLines } from '../lib/rubric.js';

describe('defaultRubricPath', () => {
  it('maps scenario.json to rubric.json', () => {
    expect(defaultRubricPath('/tmp/exercise/scenario.json')).toBe(
      join('/tmp/exercise', 'rubric.json'),
    );
  });

  it('maps scenario.example.json to rubric.example.json', () => {
    expect(defaultRubricPath('/tmp/scenario.example.json')).toBe(
      join('/tmp', 'rubric.example.json'),
    );
  });

  it('maps foo.scenario.json to foo.rubric.json', () => {
    expect(defaultRubricPath('/tmp/02-reply.scenario.json')).toBe(
      join('/tmp', '02-reply.rubric.json'),
    );
  });
});

describe('rubricLines', () => {
  it('returns empty for missing rubric', () => {
    expect(rubricLines(null)).toEqual([]);
  });

  it('renders notes-only objects as prose', () => {
    expect(rubricLines({ notes: 'Reward a clear ask.' })).toEqual([
      '### Rubric hints',
      '',
      'Reward a clear ask.',
      '',
    ]);
  });
});
