import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import type { RuleCard } from '../../../api/contracts.ts';
import { OUTCOME_TONE, OUTCOME_WORDS, PRESET_ITEMS, outcomePhrase, type RulesPreset } from './outcomeWords.ts';

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
const DAYS: ReadonlySet<string> = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
/** A JSON time, as the kernel's `RuleCard` writes `HoursWindow.start` and `end`: "09:00:00". */
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What is wrong with one card against the `RuleCard` contract, in the fields the check reads, or null. */
function cardProblem(card: unknown): string | null {
  if (!isRecord(card)) return 'not an object';
  for (const field of ['card_id', 'applies_to', 'reason']) {
    if (typeof card[field] !== 'string') return `no ${field}`;
  }
  if (typeof card.mode !== 'string' || !MODES.has(card.mode)) return `mode ${String(card.mode)}`;
  if (typeof card.who !== 'string' || !WHO.has(card.who)) return `who ${String(card.who)}`;
  // Optional, and never null: a whole number from 0 to 10,000 basis points.
  if ('max_discount_bp' in card) {
    const bp = card.max_discount_bp;
    if (typeof bp !== 'number' || !Number.isInteger(bp) || bp < 0 || bp > 10_000) return `max_discount_bp ${String(bp)}`;
  }
  // Optional, or null for any time; otherwise at least one day, a start and an end.
  if ('hours' in card && card.hours !== null) {
    const window = card.hours;
    if (!isRecord(window)) return 'hours not an object';
    const days = window.days;
    if (!Array.isArray(days) || days.length === 0 || !days.every((day) => typeof day === 'string' && DAYS.has(day))) return 'hours days';
    if (typeof window.start !== 'string' || !TIME.test(window.start)) return 'hours start';
    if (typeof window.end !== 'string' || !TIME.test(window.end)) return 'hours end';
  }
  return null;
}

/** The export, read and checked against the contract: both presets, each a list of rule cards. Anything else throws. */
function parsePresetCards(value: unknown): PresetCards {
  if (!isRecord(value)) throw new Error('The presets export is not an object');
  const read = (name: PresetName): RuleCard[] => {
    const list = value[name];
    if (!Array.isArray(list)) throw new Error(`The presets export has no "${name}" list`);
    return list.map((card: unknown, i) => {
      const problem = cardProblem(card);
      if (problem !== null) throw new Error(`Card ${i} of "${name}" is not a rule card: ${problem}`);
      return card as RuleCard;
    });
  };
  return { ask_first: read('ask_first'), auto: read('auto') };
}

/** True when `read` throws. */
function refuses(read: () => unknown): boolean {
  try {
    read();
    return false;
  } catch {
    return true;
  }
}

/**
 * Owner-session setup tools: Claude reads the owner's own website and notes. Visitors can't reach
 * them and the Rules page doesn't list them (the web app's `capabilities`), so "every tool" on the
 * Rules page doesn't include them.
 */
const SETUP_TOOLS: ReadonlySet<string> = new Set(['native.fetch_website', 'native.read_memory']);

/** Every target that takes or sends money: the money effects and the tools that have them. */
const MONEY_TARGETS: readonly string[] = ['effect:charge', 'effect:pay_out', 'native.payment_link', 'native.charge_mandate', 'payments.create_refund'];

/** Working hours, as the preset's booking card keeps them (plan 01a: weekday bookings from 09:00 to 17:00). */
const WORKING_HOURS = { days: new Set(['mon', 'tue', 'wed', 'thu', 'fri']), start: '09:00:00', end: '17:00:00' };

/** Seconds since midnight of a JSON time. */
function seconds(time: string): number {
  const [h = '0', m = '0', s = '0'] = time.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/** One thing a description says, and what's wrong with a preset's cards for it, or null. */
interface Claim {
  words: string;
  problem: (cards: readonly RuleCard[]) => string | null;
}

/** Claude does the target on its own: there is an automatic card for it, and every one passes `each`. */
function onItsOwn(words: string, target: string, each: (card: RuleCard) => string | null): Claim {
  return {
    words,
    problem: (cards) => {
      const found = cards.filter((card) => card.applies_to === target && card.mode === 'auto');
      if (found.length === 0) return `no automatic card for ${target}`;
      for (const card of found) {
        const wrong = each(card);
        if (wrong !== null) return `${card.card_id}: ${wrong}`;
      }
      return null;
    },
  };
}

/**
 * Claude asks before the targets `covers` names: no card for one of them runs it on its own or
 * refuses it. A target with no card asks by the compiler's default.
 */
function asksFirst(words: string, covers: (target: string) => boolean): Claim {
  return {
    words,
    problem: (cards) => {
      const wrong = cards.filter((card) => covers(card.applies_to) && card.mode !== 'ask');
      return wrong.length === 0 ? null : wrong.map((card) => `${card.card_id} is ${card.mode} for ${card.applies_to}`).join('; ');
    },
  };
}

/** What each preset's description claims about its cards, and nothing it doesn't. */
const CLAIMS: Record<PresetName, readonly Claim[]> = {
  ask_first: [asksFirst('Every tool asks you first.', (target) => !SETUP_TOOLS.has(target))],
  auto: [
    onItsOwn('Quotes at list price', 'native.quote', (card) =>
      (card.max_discount_bp ?? 0) === 0 ? null : `allows a ${card.max_discount_bp} bp discount`,
    ),
    onItsOwn('weekday bookings in your hours', 'native.book', (card) => {
      const window = card.hours;
      if (window === null || window === undefined) return 'books at any hour';
      const outside = window.days.filter((day) => !WORKING_HOURS.days.has(day));
      if (outside.length > 0) return `books on ${outside.join(', ')}`;
      const [start, end] = [seconds(window.start), seconds(window.end)];
      if (start < seconds(WORKING_HOURS.start) || end > seconds(WORKING_HOURS.end) || start >= end) {
        return `books ${window.start} to ${window.end}, outside ${WORKING_HOURS.start} to ${WORKING_HOURS.end}`;
      }
      return null;
    }),
    onItsOwn('documents to verified customers', 'native.release_document', (card) =>
      card.who === 'record_owner' ? null : `is for ${card.who}, not the verified customer the document is for`,
    ),
    asksFirst('Payments ask you first.', (target) => MONEY_TARGETS.includes(target)),
  ],
};

/** Everything the descriptions say that the presets' cards don't do; empty when they agree. */
function descriptionProblems(cards: PresetCards): string[] {
  const problems: string[] = [];
  for (const preset of ['ask_first', 'auto'] as const) {
    const description = PRESET_ITEMS.find((item) => item.value === preset)?.description ?? '';
    for (const claim of CLAIMS[preset]) {
      if (!description.includes(claim.words)) problems.push(`${preset}: the description doesn't say "${claim.words}"`);
      const wrong = claim.problem(cards[preset]);
      if (wrong !== null) problems.push(`${preset}, "${claim.words}": ${wrong}`);
    }
  }
  return problems;
}

/** A hand-built pair of presets that does what the descriptions say, for the checker's own test. */
function handBuilt(): PresetCards {
  let n = 0;
  const card = (applies_to: string, mode: RuleCard['mode'], who: RuleCard['who'], extra: Partial<RuleCard> = {}): RuleCard => ({
    card_id: `hand-${(n += 1)}`,
    applies_to,
    mode,
    who,
    reason: 'Hand-built for the description check.',
    ...extra,
  });
  return {
    // Every tool asks: an explicit ask, and an owner-session setup tool, which no visitor reaches.
    ask_first: [card('native.quote', 'ask', 'anyone'), card('native.read_memory', 'auto', 'anyone')],
    auto: [
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

/** A card the hand-built presets don't have. */
function extra(applies_to: string, mode: RuleCard['mode']): RuleCard {
  return { card_id: 'hand-extra', applies_to, mode, who: 'anyone', reason: 'Added.' };
}

/** A change to a card's booking window: weekdays unless `days` says otherwise. */
function hours(start: string, end: string, days: NonNullable<RuleCard['hours']>['days'] = ['mon', 'tue', 'wed', 'thu', 'fri']): Partial<RuleCard> {
  return { hours: { days, start, end } };
}

describe('outcome words', () => {
  test('preset_descriptions_match_the_presets', ({ skip }) => {
    skip(!existsSync(PRESETS_EXPORT), 'waits for the generated presets export, web/src/api/presets.gen.json');
    // Every claim each description makes holds for the presets' own cards.
    const cards = parsePresetCards(JSON.parse(readFileSync(PRESETS_EXPORT, 'utf8')));
    expect(descriptionProblems(cards)).toEqual([]);
  });

  test('a_changed_preset_card_fails_the_descriptions', () => {
    const good = handBuilt();
    // The checker passes presets that do what the descriptions say, read the way the export is read.
    expect(descriptionProblems(parsePresetCards(JSON.parse(JSON.stringify(good))))).toEqual([]);
    // Changing one card alone fails it.
    const broken: [string, PresetCards][] = [
      // "Quotes at list price"
      ['quotes with a discount', changed(good, 'auto', { appliesTo: 'native.quote', change: { max_discount_bp: 1000 } })],
      ['quotes no longer automatic', changed(good, 'auto', { appliesTo: 'native.quote', change: { mode: 'ask' } })],
      ['no quote card', changed(good, 'auto', { appliesTo: 'native.quote', change: null })],
      // "weekday bookings in your hours"
      ['bookings at night', changed(good, 'auto', { appliesTo: 'native.book', change: hours('01:00:00', '02:00:00') })],
      ['bookings before and after working hours', changed(good, 'auto', { appliesTo: 'native.book', change: hours('08:00:00', '18:00:00') })],
      ['bookings ending before they start', changed(good, 'auto', { appliesTo: 'native.book', change: hours('17:00:00', '09:00:00') })],
      ['bookings at any hour', changed(good, 'auto', { appliesTo: 'native.book', change: { hours: null } })],
      ['bookings on Saturdays', changed(good, 'auto', { appliesTo: 'native.book', change: hours('09:00:00', '17:00:00', ['mon', 'sat']) })],
      ['no automatic bookings', changed(good, 'auto', { appliesTo: 'native.book', change: null })],
      // "documents to verified customers"
      ['documents for anyone', changed(good, 'auto', { appliesTo: 'native.release_document', change: { who: 'anyone' } })],
      ['documents for anyone verified', changed(good, 'auto', { appliesTo: 'native.release_document', change: { who: 'verified' } })],
      // "Payments ask you first": neither automatic nor refused
      ['payments automatic', changed(good, 'auto', { appliesTo: 'effect:charge', change: { mode: 'auto' } })],
      ['payments refused', changed(good, 'auto', { appliesTo: 'effect:charge', change: { mode: 'never' } })],
      ['payment links automatic', changed(good, 'auto', { add: extra('native.payment_link', 'auto') })],
      ['refunds refused', changed(good, 'auto', { add: extra('payments.create_refund', 'never') })],
      // "Every tool asks you first": neither automatic nor refused
      ['Ask me first quotes on its own', changed(good, 'ask_first', { appliesTo: 'native.quote', change: { mode: 'auto' } })],
      ['Ask me first refuses quotes', changed(good, 'ask_first', { appliesTo: 'native.quote', change: { mode: 'never' } })],
      ['Ask me first finds open times on its own', changed(good, 'ask_first', { add: extra('native.find_slots', 'auto') })],
      ['Ask me first requests callbacks on its own', changed(good, 'ask_first', { add: extra('native.request_callback', 'auto') })],
      ['Ask me first refuses payments', changed(good, 'ask_first', { add: extra('effect:charge', 'never') })],
    ];
    for (const [what, cards] of broken) expect({ what, problems: descriptionProblems(cards).length > 0 }).toEqual({ what, problems: true });
  });

  test('a_malformed_presets_export_is_refused', () => {
    // An export of the wrong shape is refused, never read as no cards or as the contract's defaults.
    const good = handBuilt();
    const withCard = (change: Record<string, unknown>) => ({ ...good, auto: [...good.auto, { ...good.auto[0], ...change }] });
    const without = (field: string) => {
      const card: Record<string, unknown> = { ...good.auto[0] };
      delete card[field];
      return { ...good, auto: [card] };
    };
    const malformed: [string, unknown][] = [
      ['no auto list', { ask_first: [] }],
      ['not an object', []],
      ['a card without its target', without('applies_to')],
      ['a card without its id', without('card_id')],
      ['a card without its reason', without('reason')],
      ['an unknown mode', withCard({ mode: 'maybe' })],
      ['an unknown audience', withCard({ who: 'everyone' })],
      ['a null discount', withCard({ max_discount_bp: null })],
      ['a discount that is not a whole number', withCard({ max_discount_bp: 0.5 })],
      ['a discount over 100%', withCard({ max_discount_bp: 10001 })],
      ['hours without a start or an end', withCard({ hours: { days: ['mon'] } })],
      ['hours with no days', withCard({ hours: { days: [], start: '09:00:00', end: '17:00:00' } })],
      ['hours on an unknown day', withCard({ hours: { days: ['monday'], start: '09:00:00', end: '17:00:00' } })],
      ['hours that are not a time', withCard({ hours: { days: ['mon'], start: '9am', end: '17:00:00' } })],
    ];
    for (const [what, value] of malformed) expect({ what, refused: refuses(() => parsePresetCards(value)) }).toEqual({ what, refused: true });
  });

  test('preset_descriptions_are_the_owner_words', () => {
    // The two presets are the only ones: there is no Custom mode to pick.
    // @ts-expect-error 'custom' is no preset
    const notAPreset: RulesPreset = 'custom';
    expect(PRESET_ITEMS.map((item) => item.value)).not.toContain(notAPreset);
    expect(PRESET_ITEMS).toEqual([
      { value: 'ask_first', title: 'Ask me first for everything', description: 'Every tool asks you first.' },
      {
        value: 'auto',
        title: 'Recommended rules',
        description: 'Quotes at list price, weekday bookings in your hours, documents to verified customers. Payments ask you first.',
      },
    ]);
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
  });
});
