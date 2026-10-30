import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import type { RuleCard } from '../../../api/contracts.ts';
import { OUTCOME_TONE, OUTCOME_WORDS, PRESET_CAPTIONS, PRESET_WORDS, outcomePhrase } from './outcomeWords.ts';

/**
 * The presets export: `desk.presets.PRESETS` (plan 01a Task 3) as JSON, generated into
 * `web/src/api/presets.gen.json` as `{"ask_first": [RuleCard, ...], "auto": [RuleCard, ...]}`.
 * Until it is generated, the check against it is skipped.
 */
const PRESETS_EXPORT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../api/presets.gen.json');

type PresetName = 'ask_first' | 'auto';

/** Each preset's rule cards, as the export lists them. */
type PresetCards = Record<PresetName, readonly RuleCard[]>;

const MODES: ReadonlySet<string> = new Set(['auto', 'ask', 'never']);
const WHO: ReadonlySet<string> = new Set(['anyone', 'verified', 'record_owner', 'person', 'agent']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The export, read: both presets, each a list of cards with a target, a mode and who they are for. Anything else throws. */
function parsePresetCards(value: unknown): PresetCards {
  if (!isRecord(value)) throw new Error('The presets export is not an object');
  const read = (name: PresetName): RuleCard[] => {
    const list = value[name];
    if (!Array.isArray(list)) throw new Error(`The presets export has no "${name}" list`);
    return list.map((card: unknown, i) => {
      const ok =
        isRecord(card) &&
        typeof card.applies_to === 'string' &&
        typeof card.mode === 'string' &&
        MODES.has(card.mode) &&
        typeof card.who === 'string' &&
        WHO.has(card.who);
      if (!ok) throw new Error(`Card ${i} of "${name}" is not a rule card`);
      return card as unknown as RuleCard;
    });
  };
  return { ask_first: read('ask_first'), auto: read('auto') };
}

/**
 * Owner-session setup tools: Claude reads the owner's own website and notes. Visitors can't reach
 * them and the Rules page doesn't list them (the web app's `capabilities`), so no caption names them.
 */
const SETUP_TOOLS: ReadonlySet<string> = new Set(['native.fetch_website', 'native.read_memory']);

/** Every target that takes or sends money: the money effects and the tools that have them. */
const MONEY_TARGETS = ['effect:charge', 'effect:pay_out', 'native.payment_link', 'native.charge_mandate', 'payments.create_refund'];

const WEEKDAYS: ReadonlySet<string> = new Set(['mon', 'tue', 'wed', 'thu', 'fri']);

/** A preset's automatic cards for one target. */
function autoCards(cards: readonly RuleCard[], target: string): RuleCard[] {
  return cards.filter((card) => card.applies_to === target && card.mode === 'auto');
}

/** One thing a caption says: its words, whether they say Claude runs the targets on its own, and what must hold. */
interface Claim {
  words: string;
  runsOnItsOwn: boolean;
  targets: readonly string[];
  /** Further targets the words account for, such as the other tool of the same connector. */
  covers?: readonly string[];
  /** What's wrong with the preset's cards, or null when the claim holds. */
  problem: (cards: readonly RuleCard[]) => string | null;
}

/** Claude asks before any of the targets: no automatic card for them. */
function asks(words: string, targets: readonly string[]): Claim {
  return {
    words,
    runsOnItsOwn: false,
    targets,
    problem: (cards) => {
      const automatic = targets.filter((target) => autoCards(cards, target).length > 0);
      return automatic.length === 0 ? null : `runs ${automatic.join(', ')} on its own`;
    },
  };
}

/** Claude runs each target on its own for anyone, and every automatic card for it passes `each`. */
function runs(words: string, targets: readonly string[], each: (card: RuleCard) => string | null = () => null, covers?: readonly string[]): Claim {
  return {
    words,
    runsOnItsOwn: true,
    targets,
    covers,
    problem: (cards) => {
      for (const target of targets) {
        const found = autoCards(cards, target);
        if (found.length === 0) return `has no automatic card for ${target}`;
        for (const card of found) {
          const wrong = each(card);
          if (wrong !== null) return `${card.card_id}: ${wrong}`;
        }
      }
      return null;
    },
  };
}

const forAnyone = (card: RuleCard) => (card.who === 'anyone' ? null : `is for ${card.who}, not anyone`);

/** What each preset's caption says about its cards, phrase by phrase. */
const CLAIMS: Record<PresetName, readonly Claim[]> = {
  ask_first: [
    asks('asks you before it quotes', ['native.quote']),
    asks('books', ['native.book']),
    asks('shares a document', ['native.release_document']),
    asks('takes a payment', MONEY_TARGETS),
    runs('still finds open times', ['native.find_slots'], forAnyone),
    // Leads and callbacks: saving a lead and asking the owner to call back both keep who to get back to.
    runs('saves leads', ['native.capture_lead'], forAnyone, ['native.request_callback']),
    runs('confirms who people are', ['native.start_verification'], forAnyone),
  ],
  auto: [
    runs('quotes at list price', ['native.quote'], (card) =>
      forAnyone(card) ?? ((card.max_discount_bp ?? 0) === 0 ? null : `allows a ${card.max_discount_bp} bp discount`),
    ),
    runs('books weekdays in your hours', ['native.book'], (card) => {
      const days = card.hours?.days ?? [];
      if (days.length === 0) return 'books at any hour';
      return days.every((day) => WEEKDAYS.has(day)) ? null : `books on ${days.join(', ')}`;
    }),
    runs('sends verified customers their own documents', ['native.release_document'], (card) =>
      card.who === 'record_owner' ? null : `is for ${card.who}, not the record's owner`,
    ),
    asks('Payments ask you first', MONEY_TARGETS),
  ],
};

/** Everything the captions say that the presets' cards don't do; empty when they agree. */
function captionProblems(cards: PresetCards): string[] {
  const problems: string[] = [];
  for (const preset of ['ask_first', 'auto'] as const) {
    for (const claim of CLAIMS[preset]) {
      if (!PRESET_CAPTIONS[preset].includes(claim.words)) problems.push(`${preset}: the caption doesn't say "${claim.words}"`);
      const wrong = claim.problem(cards[preset]);
      if (wrong !== null) problems.push(`${preset}, "${claim.words}": ${wrong}`);
    }
  }
  // Ask me first runs on its own only what its caption says it still does; Automatic only that and
  // what its own caption adds.
  const said = (preset: PresetName) =>
    CLAIMS[preset].filter((claim) => claim.runsOnItsOwn).flatMap((claim) => [...claim.targets, ...(claim.covers ?? [])]);
  const allowed: Record<PresetName, ReadonlySet<string>> = {
    ask_first: new Set(said('ask_first')),
    auto: new Set([...said('ask_first'), ...said('auto')]),
  };
  for (const preset of ['ask_first', 'auto'] as const) {
    for (const card of cards[preset]) {
      if (card.mode === 'auto' && !allowed[preset].has(card.applies_to) && !SETUP_TOOLS.has(card.applies_to)) {
        problems.push(`${preset}: ${card.card_id} runs ${card.applies_to} on its own, which the caption doesn't say`);
      }
    }
  }
  return problems;
}

/** A hand-built pair of presets that does what the captions say, for the checker's own test. */
function handBuilt(): PresetCards {
  let n = 0;
  const card = (applies_to: string, mode: RuleCard['mode'], who: RuleCard['who'], extra: Partial<RuleCard> = {}): RuleCard => ({
    card_id: `hand-${(n += 1)}`,
    applies_to,
    mode,
    who,
    reason: 'Hand-built for the caption check.',
    ...extra,
  });
  const askFirst = [
    card('native.find_slots', 'auto', 'anyone'),
    card('native.capture_lead', 'auto', 'anyone'),
    card('native.start_verification', 'auto', 'anyone'),
  ];
  return {
    ask_first: askFirst,
    auto: [
      ...askFirst,
      card('native.quote', 'auto', 'anyone', { max_discount_bp: 0 }),
      card('native.book', 'auto', 'anyone', { hours: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00:00', end: '17:00:00' } }),
      card('native.release_document', 'auto', 'record_owner'),
      card('effect:charge', 'ask', 'anyone'),
    ],
  };
}

/** One preset's cards with `change` applied to the card for `appliesTo`, or with `add` appended. */
function changed(cards: PresetCards, preset: PresetName, edit: { appliesTo?: string; change?: Partial<RuleCard> | null; add?: RuleCard }): PresetCards {
  const list = cards[preset].flatMap((card) => {
    if (card.applies_to !== edit.appliesTo) return [card];
    return edit.change === null ? [] : [{ ...card, ...edit.change }];
  });
  return { ...cards, [preset]: edit.add ? [...list, edit.add] : list };
}

describe('outcome words', () => {
  test('preset_captions_match_the_presets', ({ skip }) => {
    skip(!existsSync(PRESETS_EXPORT), 'waits for the generated presets export, web/src/api/presets.gen.json');
    // Every claim each caption makes holds for the presets' own cards, and Ask me first runs on its
    // own only what its caption says it still does.
    const cards = parsePresetCards(JSON.parse(readFileSync(PRESETS_EXPORT, 'utf8')));
    expect(captionProblems(cards)).toEqual([]);
  });

  test('a_changed_preset_card_fails_the_captions', () => {
    const good = handBuilt();
    // The checker passes presets that do what the captions say, read the way the export is read.
    expect(captionProblems(parsePresetCards(JSON.parse(JSON.stringify(good))))).toEqual([]);
    // Changing one card alone fails it.
    const anyone = (applies_to: string): RuleCard => ({ card_id: 'hand-added', applies_to, mode: 'auto', who: 'anyone', reason: 'Added.' });
    const broken: [string, PresetCards][] = [
      ['quotes with a discount', changed(good, 'auto', { appliesTo: 'native.quote', change: { max_discount_bp: 1000 } })],
      ['quotes no longer automatic', changed(good, 'auto', { appliesTo: 'native.quote', change: { mode: 'ask' } })],
      ['no quote card', changed(good, 'auto', { appliesTo: 'native.quote', change: null })],
      ['bookings at any hour', changed(good, 'auto', { appliesTo: 'native.book', change: { hours: null } })],
      ['bookings on Saturdays', changed(good, 'auto', { appliesTo: 'native.book', change: { hours: { days: ['mon', 'sat'], start: '09:00:00', end: '17:00:00' } } })],
      ['documents for anyone', changed(good, 'auto', { appliesTo: 'native.release_document', change: { who: 'anyone' } })],
      ['payments automatic', changed(good, 'auto', { appliesTo: 'effect:charge', change: { mode: 'auto' } })],
      ['payment links automatic', changed(good, 'auto', { add: anyone('native.payment_link') })],
      ['Automatic adds a tool its caption leaves out', changed(good, 'auto', { add: anyone('payments.list_charges') })],
      ['Ask me first quotes on its own', changed(good, 'ask_first', { add: anyone('native.quote') })],
      ['Ask me first refunds on its own', changed(good, 'ask_first', { add: anyone('payments.create_refund') })],
      ['Ask me first stops finding open times', changed(good, 'ask_first', { appliesTo: 'native.find_slots', change: null })],
    ];
    for (const [what, cards] of broken) expect({ what, problems: captionProblems(cards).length > 0 }).toEqual({ what, problems: true });
    // An export of the wrong shape is refused, never read as no cards.
    expect(() => parsePresetCards({ ask_first: [] })).toThrow();
    expect(() => parsePresetCards({ ask_first: [{ applies_to: 'native.quote' }], auto: [] })).toThrow();
  });

  test('preset_captions_are_the_owner_words', () => {
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
