import { describe, expect, test } from 'vitest';

import { OUTCOME_TONE, OUTCOME_WORDS, PRESET_CAPTIONS, PRESET_WORDS, outcomePhrase, type RuleMode } from './outcomeWords.ts';

/** A preset's card, as far as its caption can describe it. */
interface PresetCard {
  applies_to: string;
  mode: RuleMode;
  who: 'anyone' | 'record_owner';
  /** What else the card limits, in the table's words. */
  limits?: 'no discount' | 'weekday hours';
}

const anyoneAuto = (applies_to: string): PresetCard => ({ applies_to, mode: 'auto', who: 'anyone' });

/**
 * `desk.presets.PRESETS`, copied from plan 01a Task 3: each preset's cards. A tool without a card
 * falls to the default ask. When the presets change there, this copy and the captions change too.
 */
const PRESETS: Record<'ask_first' | 'auto', readonly PresetCard[]> = (() => {
  const askFirst = [
    'native.find_slots',
    'native.capture_lead',
    'native.request_callback',
    'native.start_verification',
    'native.fetch_website',
    'native.read_memory',
  ].map(anyoneAuto);
  return {
    ask_first: askFirst,
    auto: [
      ...askFirst,
      { ...anyoneAuto('native.quote'), limits: 'no discount' },
      { ...anyoneAuto('native.book'), limits: 'weekday hours' },
      { applies_to: 'native.release_document', mode: 'auto', who: 'record_owner' },
      { applies_to: 'effect:charge', mode: 'ask', who: 'anyone' },
      { applies_to: 'effect:pay_out', mode: 'ask', who: 'anyone' },
    ],
  };
})();

/** What a caption says about one tool: its words in the caption, and the card they describe. */
interface Claim {
  words: string;
  applies_to: string;
  mode: RuleMode;
  who?: PresetCard['who'];
  limits?: PresetCard['limits'];
}

/** Each preset caption's claims, phrase by phrase. */
const CLAIMS: Record<'ask_first' | 'auto', readonly Claim[]> = {
  ask_first: [
    { words: 'asks you before it quotes', applies_to: 'native.quote', mode: 'ask' },
    { words: 'books', applies_to: 'native.book', mode: 'ask' },
    { words: 'shares a document', applies_to: 'native.release_document', mode: 'ask' },
    { words: 'takes a payment', applies_to: 'effect:charge', mode: 'ask' },
    { words: 'still finds open times', applies_to: 'native.find_slots', mode: 'auto', who: 'anyone' },
    { words: 'saves leads', applies_to: 'native.capture_lead', mode: 'auto', who: 'anyone' },
    { words: 'confirms who people are', applies_to: 'native.start_verification', mode: 'auto', who: 'anyone' },
  ],
  auto: [
    { words: 'quotes at list price', applies_to: 'native.quote', mode: 'auto', who: 'anyone', limits: 'no discount' },
    { words: 'books weekdays in your hours', applies_to: 'native.book', mode: 'auto', who: 'anyone', limits: 'weekday hours' },
    {
      words: 'sends verified customers their own documents',
      applies_to: 'native.release_document',
      mode: 'auto',
      who: 'record_owner',
    },
    { words: 'Payments ask you first', applies_to: 'effect:charge', mode: 'ask' },
  ],
};

/** A tool's outcome under a preset: its card's, or the default ask. */
function outcomeIn(preset: 'ask_first' | 'auto', appliesTo: string): PresetCard {
  return PRESETS[preset].find((card) => card.applies_to === appliesTo) ?? { applies_to: appliesTo, mode: 'ask', who: 'anyone' };
}

/** The tools a preset makes automatic. */
function automatic(preset: 'ask_first' | 'auto'): string[] {
  return PRESETS[preset].filter((card) => card.mode === 'auto').map((card) => card.applies_to);
}

describe('outcome words', () => {
  test('preset_captions_match_the_presets', () => {
    for (const preset of ['ask_first', 'auto'] as const) {
      for (const claim of CLAIMS[preset]) {
        // The caption says it, and the preset's card does what it says.
        expect(PRESET_CAPTIONS[preset]).toContain(claim.words);
        const card = outcomeIn(preset, claim.applies_to);
        expect({ words: claim.words, mode: card.mode }).toEqual({ words: claim.words, mode: claim.mode });
        if (claim.who !== undefined) expect(card.who).toBe(claim.who);
        expect(card.limits).toBe(claim.limits);
      }
    }
    // Automatic names exactly what it turns automatic beyond the starter preset, Ask me first,
    // and Ask me first says it asks for each of them.
    const added = automatic('auto').filter((tool) => !automatic('ask_first').includes(tool));
    const claimedAuto = CLAIMS.auto.filter((claim) => claim.mode === 'auto').map((claim) => claim.applies_to);
    expect(claimedAuto.sort()).toEqual([...added].sort());
    const askedFirst = CLAIMS.ask_first.filter((claim) => claim.mode === 'ask').map((claim) => claim.applies_to);
    for (const tool of added) expect(askedFirst).toContain(tool);
    // Custom describes no preset: it is the owner's own rules. The captions, word for word.
    expect(Object.keys(PRESET_CAPTIONS)).toEqual(PRESET_WORDS.map((option) => option.value));
    expect(PRESET_CAPTIONS).toEqual({
      ask_first:
        'Claude asks you before it quotes, books, shares a document or takes a payment. It still finds open times, saves leads and confirms who people are.',
      auto: 'Claude quotes at list price, books weekdays in your hours and sends verified customers their own documents. Payments ask you first.',
      custom: 'Your own rules, tool by tool. Change any of them below.',
    });
  });

  test('outcome_phrase_with_limit', () => {
    // An auto card with an amount limit holds anything over it for the owner, through its hold twin.
    expect(outcomePhrase('auto', '$100')).toBe('Automatic up to $100; over $100, ask me first');
    // No mode but auto has a limit to show.
    expect(outcomePhrase('ask', '$100')).toBe('Ask me first');
    expect(outcomePhrase('never', '$100')).toBe('Never');
    expect(outcomePhrase('auto')).toBe('Automatic');
    // A blank limit is no limit.
    expect(outcomePhrase('auto', ' ')).toBe('Automatic');

    expect(OUTCOME_WORDS).toEqual({ auto: 'Automatic', ask: 'Ask me first', never: 'Never' });
    expect(OUTCOME_TONE).toEqual({ auto: 'handled', ask: 'held', never: 'refused' });
    expect(PRESET_WORDS.map(({ value, label }) => [value, label])).toEqual([
      ['ask_first', 'Ask me first'],
      ['auto', 'Automatic'],
      ['custom', 'Custom'],
    ]);
  });
});
