/** Tool targets in the owner's words, with listed business titles and the existing fallbacks. */
import { expect, it } from 'vitest';

import { chenBusinessTools } from '../../mocks/businessTools.ts';
import { businessTools } from '../connectors/catalog.ts';
import { targetWords } from './ruleWords.ts';

it('names a listed business target and preserves unknown and effect words', () => {
  const map = businessTools(chenBusinessTools);
  expect(targetWords('desk.intro-call', map)).toBe('Book a free intro call');
  expect(targetWords('desk.unknown', map)).toBe('A connected tool');
  expect(targetWords('desk.intro-call')).toBe('A connected tool');
  expect(targetWords('native.unknown', map)).toBe('A connected tool');
  expect(targetWords('native.quote', map)).toBe('Quote');
  expect(targetWords('effect:change', map)).toBe('Every tool that changes something');
  expect(targetWords('effect:private_data', map)).toBe('Every tool that touches private data');
  expect(targetWords('effect:charge', map)).toBe('Every tool that charges money');
  expect(targetWords('effect:pay_out', map)).toBe('Every tool that sends money out');
  expect(targetWords('effect:send_message', map)).toBe('Every tool that sends a message out');
  expect(targetWords('effect:read', map)).toBe('Every tool that only reads');
  expect(targetWords('effect:unknown', map)).toBe('A group of tools');
});
