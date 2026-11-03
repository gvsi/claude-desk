import { expect, it } from 'vitest';

import { jsonText, jsonTokens } from './detailsJson.ts';

/** REV-RULES-D's "As your Desk lists it", for Payment link. */
const TOOL = {
  tool: 'native.payment_link',
  source: 'native',
  effects: ['charge'],
  reversible: false,
  status: 'enabled',
  description_confirmed: 'Makes a one-time link for a quote.',
  definition_sha256: '7f3a9ce21b',
};

it('pretty_json_with_a_two_space_indent_and_short_lists_on_one_line', () => {
  expect(jsonText(TOOL)).toBe(
    [
      '{',
      '  "tool": "native.payment_link",',
      '  "source": "native",',
      '  "effects": ["charge"],',
      '  "reversible": false,',
      '  "status": "enabled",',
      '  "description_confirmed": "Makes a one-time link for a quote.",',
      '  "definition_sha256": "7f3a9ce21b"',
      '}',
    ].join('\n'),
  );
  expect(JSON.parse(jsonText(TOOL))).toEqual(TOOL);
});

it('each_token_is_a_key_a_string_a_value_or_punctuation', () => {
  const tokens = jsonTokens({ max_amount_cents: 30000, review: true, who: 'anyone', person_id: null });
  const kinds = (kind: string) => tokens.filter((token) => token.kind === kind).map((token) => token.text);
  expect(kinds('key')).toEqual(['"max_amount_cents"', '"review"', '"who"', '"person_id"']);
  expect(kinds('string')).toEqual(['"anyone"']);
  // Numbers, booleans and null read alike: values that aren't words.
  expect(kinds('value')).toEqual(['30000', 'true', 'null']);
  expect(kinds('punct').join('')).toBe('{: ,: ,: ,: }');
  // Whatever isn't tinted is the layout: new lines and the indent.
  expect(tokens.filter((token) => token.kind === 'space').every((token) => /^\s+$/.test(token.text))).toBe(true);
  expect(tokens.map((token) => token.text).join('')).toBe(jsonText({ max_amount_cents: 30000, review: true, who: 'anyone', person_id: null }));
});

it('nested_objects_and_lists_of_objects_break_onto_their_own_lines', () => {
  const cards = [
    { card_id: 'rv-book-wk', hours: { days: ['mon', 'tue'], start: '08:00', end: '18:00' } },
    { card_id: 'rv-book-sat', hours: null },
  ];
  expect(jsonText(cards)).toBe(
    [
      '[',
      '  {',
      '    "card_id": "rv-book-wk",',
      '    "hours": {',
      '      "days": ["mon", "tue"],',
      '      "start": "08:00",',
      '      "end": "18:00"',
      '    }',
      '  },',
      '  {',
      '    "card_id": "rv-book-sat",',
      '    "hours": null',
      '  }',
      ']',
    ].join('\n'),
  );
  expect(JSON.parse(jsonText(cards))).toEqual(cards);
  expect(jsonText({})).toBe('{}');
  expect(jsonText([])).toBe('[]');
});

it('reads_as_json_does_escapes_and_all', () => {
  // A field left undefined is left out, as JSON.stringify leaves it out; quotes and new lines are escaped.
  const value = { reason: 'Says "hi"\nthen <b>bye</b>', review: undefined, max_discount_bp: 0 };
  expect(JSON.parse(jsonText(value))).toEqual(JSON.parse(JSON.stringify(value)));
  expect(jsonText(value)).not.toContain('review');
});
