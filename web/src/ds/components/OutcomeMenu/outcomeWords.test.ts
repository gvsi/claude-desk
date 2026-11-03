import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import type { Effect, HoursWindow, RuleCard, ToolName } from '../../../api/contracts.ts';
import { RIVERA_HOURS, presetCards, weekdayWindows } from '../../../mocks/seed.ts';
import { groupsOverlap, rulesForTool } from '../ToolRulesCard/toolRules.ts';
import { OUTCOME_GROUP_WORDS, OUTCOME_TONE, OUTCOME_WORDS, PRESET_WORDS, outcomePhrase, type RulesPreset } from './outcomeWords.ts';

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

/**
 * Each tool's effects, as the master plan's tool table lists them (and as the fixtures' profiles
 * have them where a fixture has one). The design system has no profile for every tool, so the test
 * keeps this table; `satisfies` makes the compiler fail it when a tool is added or removed.
 */
const TOOL_EFFECTS = {
  'native.quote': ['change'],
  'native.find_slots': ['read'],
  'native.book': ['change'],
  'native.release_document': ['private_data', 'send_message'],
  'native.payment_link': ['charge'],
  'native.charge_mandate': ['charge'],
  'native.capture_lead': ['change'],
  'native.request_callback': ['change'],
  'native.start_verification': ['send_message'],
  'native.fetch_website': ['read'],
  'native.read_memory': ['read'],
  'native.web_search': ['read'],
  'payments.list_charges': ['private_data'],
  'payments.create_refund': ['pay_out', 'private_data'],
} as const satisfies Record<ToolName, readonly Effect[]>;

/** Every effect, kept whole by the compiler. */
const EFFECTS = { read: true, private_data: true, change: true, charge: true, pay_out: true, send_message: true } as const satisfies Record<Effect, true>;

/** What a card may apply to: a tool by its name, or an effect, `effect:<Effect>`. */
const TARGETS: ReadonlySet<string> = new Set([...Object.keys(TOOL_EFFECTS), ...Object.keys(EFFECTS).map((effect) => `effect:${effect}`)]);
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
  if (!TARGETS.has(card.applies_to as string)) return `applies_to ${String(card.applies_to)}`;
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
    // The end is after the start, or 00:00 for midnight at the end of the day (`HoursWindow`).
    if (seconds(window.end) <= seconds(window.start) && seconds(window.end) !== 0) return 'hours end before start';
  }
  // Who the card is for, which `rulesForTool` ranks by: a person's id exactly when it is for one
  // person, an agent's key exactly when it is for one agent.
  for (const field of ['person_id', 'agent_key_id']) {
    if (field in card && card[field] !== null && typeof card[field] !== 'string') return `${field} ${String(card[field])}`;
  }
  if ((card.who === 'person') !== (typeof card.person_id === 'string')) return 'person_id exactly when who is person';
  if ((card.who === 'agent') !== (typeof card.agent_key_id === 'string')) return 'agent_key_id exactly when who is agent';
  // A default, which `rulesForTool` passes over, is only ever the compiler's ask for anyone.
  if ('is_default' in card && typeof card.is_default !== 'boolean') return `is_default ${String(card.is_default)}`;
  if (card.is_default === true && (card.mode !== 'ask' || card.who !== 'anyone')) return 'a default that is not an ask for anyone';
  // Limits apply only to automatic cards: the discount and hours the check reads.
  const limited = ('max_discount_bp' in card && card.max_discount_bp !== 0) || ('hours' in card && card.hours !== null);
  if (card.mode !== 'auto' && limited) return 'limits on a card that is not automatic';
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

/** True when the presets, written out and read back as the export is, are refused or break a claim. */
function exportFails(cards: PresetCards): boolean {
  let read: PresetCards;
  try {
    read = parsePresetCards(JSON.parse(JSON.stringify(cards)));
  } catch {
    return true;
  }
  return descriptionProblems(read).length > 0;
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

/** The tools that take or send money. */
const MONEY_TOOLS: readonly ToolName[] = ['native.payment_link', 'native.charge_mandate', 'payments.create_refund'];

/** The presets' own booking hours (plan 01a: weekdays, 09:00 to 17:00), "your hours" for a Desk with no hours. */
const FALLBACK_HOURS: HoursWindow = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00:00', end: '17:00:00' };

/**
 * What "in your hours" means for a Desk with these opening hours: its weekday windows, as the
 * preset reads them (`weekdayWindows`, the API's `weekday_windows`), or the presets' own 9 to 5
 * when it has no hours at all. None for a Desk whose hours have no weekday.
 */
function yourWeekdayHours(hours: readonly HoursWindow[]): HoursWindow[] {
  return hours.length === 0 ? [FALLBACK_HOURS] : weekdayWindows(hours);
}

/** Seconds since midnight of a JSON time; an end at 00:00 is midnight, the end of the day. */
function seconds(time: string, end = false): number {
  const [h = '0', m = '0', s = '0'] = time.split(':');
  const total = Number(h) * 3600 + Number(m) * 60 + Number(s);
  return end && total === 0 ? 24 * 3600 : total;
}

/** Whether `window` lies inside `within`: all its days among `within`'s, from no earlier to no later. */
function inside(window: HoursWindow, within: HoursWindow): boolean {
  const [start, end] = [seconds(window.start), seconds(window.end, true)];
  return window.days.every((day) => within.days.includes(day)) && start < end && start >= seconds(within.start) && end <= seconds(within.end, true);
}

/**
 * The cards that govern a tool, as the master plan's "Coverage and overlap" ranks them
 * (`rulesForTool`): its own cards, and each effect card that covers it and that none of its own
 * cards outranks. A tool none governs asks by the compiler's default.
 */
function governing(cards: readonly RuleCard[], tool: ToolName): RuleCard[] {
  return rulesForTool({ tool, effects: TOOL_EFFECTS[tool] }, cards);
}

/** One thing a description says, and what's wrong with a preset's cards for it, or null. */
interface Claim {
  words: string;
  problem: (cards: readonly RuleCard[]) => string | null;
}

/**
 * Claude does the tool on its own for `audience`: an automatic card for them governs it, every
 * automatic card that governs it passes `each`, and no refusal for a group that shares anyone with
 * them governs it (groups nest and a never card always wins, so a narrower or a broader group's
 * refusal still refuses some of them).
 */
function onItsOwn(words: string, tool: ToolName, audience: RuleCard['who'], each: (card: RuleCard) => string | null): Claim {
  return {
    words,
    problem: (cards) => {
      const rules = governing(cards, tool);
      const refusal = rules.find((card) => card.mode === 'never' && groupsOverlap(card, { who: audience }));
      if (refusal) return `${refusal.card_id} refuses ${tool}`;
      const automatic = rules.filter((card) => card.mode === 'auto');
      if (!automatic.some((card) => card.who === audience)) return `no automatic card for ${audience} governs ${tool}`;
      for (const card of automatic) {
        const wrong = each(card);
        if (wrong !== null) return `${card.card_id}: ${wrong}`;
      }
      return null;
    },
  };
}

/** Claude asks before each tool: every card that governs it asks, so none runs it on its own or refuses it. */
function asksFirst(words: string, tools: readonly ToolName[]): Claim {
  return {
    words,
    problem: (cards) => {
      const wrong = tools.flatMap((tool) =>
        governing(cards, tool)
          .filter((card) => card.mode !== 'ask')
          .map((card) => `${card.card_id} is ${card.mode} for ${tool}`),
      );
      return wrong.length === 0 ? null : wrong.join('; ');
    },
  };
}

/**
 * "weekday bookings in your hours", for a Desk with these opening hours: an automatic card for anyone
 * governs bookings, and every automatic one's whole window lies inside one of the Desk's weekday
 * windows (`yourWeekdayHours`). A Desk whose hours have no weekday books nothing on its own.
 */
function bookingsInYourHours(hours: readonly HoursWindow[]): Claim {
  const words = 'weekday bookings in your hours';
  const windows = yourWeekdayHours(hours);
  if (windows.length === 0) {
    return {
      words,
      problem: (cards) => {
        const automatic = governing(cards, 'native.book').find((card) => card.mode === 'auto');
        return automatic === undefined ? null : `${automatic.card_id} books on its own, but the Desk has no weekday hours`;
      },
    };
  }
  return onItsOwn(words, 'native.book', 'anyone', (card) => {
    const window = card.hours;
    if (window === null || window === undefined) return 'books at any hour';
    if (windows.some((within) => inside(window, within))) return null;
    return `books ${window.days.join(', ')} ${window.start} to ${window.end}, outside the Desk's weekday hours`;
  });
}

/** What each preset's description claims about its cards, for a Desk with these opening hours, and nothing it doesn't. */
const claims = (hours: readonly HoursWindow[]): Record<PresetName, readonly Claim[]> => ({
  // It speaks only to these four; open times, leads, callbacks and identity checks are left to the preset.
  ask_first: [
    asksFirst('Quotes', ['native.quote']),
    asksFirst('bookings', ['native.book']),
    asksFirst('documents', ['native.release_document']),
    asksFirst('payments', MONEY_TOOLS),
  ],
  auto: [
    onItsOwn('Quotes at list price', 'native.quote', 'anyone', (card) =>
      (card.max_discount_bp ?? 0) === 0 ? null : `allows a ${card.max_discount_bp} bp discount`,
    ),
    bookingsInYourHours(hours),
    onItsOwn('documents to verified customers', 'native.release_document', 'record_owner', (card) =>
      card.who === 'record_owner' ? null : `is for ${card.who}, not the verified customer the document is for`,
    ),
    asksFirst('Payments ask you first.', MONEY_TOOLS),
  ],
});

/**
 * Everything the descriptions say that the presets' cards don't do, for a Desk with these opening
 * hours (none: the presets' own 9 to 5); empty when they agree.
 */
function descriptionProblems(cards: PresetCards, hours: readonly HoursWindow[] = []): string[] {
  const problems: string[] = [];
  for (const preset of ['ask_first', 'auto'] as const) {
    const description = PRESET_WORDS.find((item) => item.value === preset)?.description ?? '';
    for (const claim of claims(hours)[preset]) {
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
    // Quotes ask by an explicit card, the rest by default; open times, leads and identity checks run
    // on their own, which the description doesn't speak to.
    ask_first: [
      card('native.quote', 'ask', 'anyone'),
      card('native.find_slots', 'auto', 'anyone'),
      card('native.request_callback', 'auto', 'anyone'),
      card('native.start_verification', 'auto', 'anyone'),
    ],
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

/** A card the hand-built presets don't have, for anyone unless `who` says otherwise. */
function extra(applies_to: string, mode: RuleCard['mode'], who: RuleCard['who'] = 'anyone'): RuleCard {
  return { card_id: 'hand-extra', applies_to, mode, who, reason: 'Added.' };
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

  test('preset_descriptions_hold_in_the_desks_own_hours', () => {
    // A Desk's draft of each preset keeps its description's promises in that Desk's hours: Turner's,
    // a split week, all day every day, weekends only (no booking card) and none (the presets' 9 to 5).
    const window = (days: HoursWindow['days'], start: string, end: string): HoursWindow => ({ days, start, end });
    const drafted = (hours: readonly HoursWindow[]): PresetCards => ({ ask_first: presetCards('ask_first', hours), auto: presetCards('auto', hours) });
    const desks: [string, HoursWindow[]][] = [
      ["Turner's", RIVERA_HOURS],
      ['a split week', [window(['mon', 'tue', 'wed', 'thu'], '08:00:00', '18:00:00'), window(['fri'], '08:00:00', '16:00:00')]],
      ['all day every day', [window(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], '00:00:00', '00:00:00')]],
      ['weekends only', [window(['sat', 'sun'], '10:00:00', '16:00:00')]],
      ['no hours', []],
    ];
    for (const [what, hours] of desks) expect({ what, problems: descriptionProblems(drafted(hours), hours) }).toEqual({ what, problems: [] });
    expect(presetCards('auto', [window(['sat', 'sun'], '10:00:00', '16:00:00')]).some((card) => card.applies_to === 'native.book')).toBe(false);
    // Another Desk's hours break the promise: Turner's 8 to 6 for a 9 to 5 Desk, and the presets'
    // 9 to 5 for a Desk open only at weekends.
    expect(descriptionProblems(drafted(RIVERA_HOURS), [FALLBACK_HOURS])).not.toEqual([]);
    expect(descriptionProblems(drafted([]), [window(['sat'], '09:00:00', '13:00:00')])).not.toEqual([]);
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
      // "Quotes, bookings, documents and payments wait for your answer.": neither automatic nor refused
      ['Ask me first quotes on its own', changed(good, 'ask_first', { appliesTo: 'native.quote', change: { mode: 'auto' } })],
      ['Ask me first refuses quotes', changed(good, 'ask_first', { appliesTo: 'native.quote', change: { mode: 'never' } })],
      ['Ask me first books on its own', changed(good, 'ask_first', { add: extra('native.book', 'auto') })],
      ['Ask me first shares documents on its own', changed(good, 'ask_first', { add: extra('native.release_document', 'auto') })],
      ['Ask me first makes payment links on its own', changed(good, 'ask_first', { add: extra('native.payment_link', 'auto') })],
      ['Ask me first refuses payments', changed(good, 'ask_first', { add: extra('effect:charge', 'never') })],
      // A rule on an effect governs every tool with that effect that no card of its own outranks.
      ['Ask me first books on its own through a rule for changes', changed(good, 'ask_first', { add: extra('effect:change', 'auto') })],
      ['Ask me first refuses documents through a rule for messages', changed(good, 'ask_first', { add: extra('effect:send_message', 'never') })],
      ['Recommended refuses quotes through a rule for changes', changed(good, 'auto', { add: extra('effect:change', 'never') })],
      ['Recommended takes payments through a rule for charges', changed(good, 'auto', { appliesTo: 'effect:charge', change: null, add: extra('effect:charge', 'auto') })],
      // Groups nest (anyone, verified people, record owners) and a never card always wins, so a
      // refusal for any group that shares someone with the advertised audience contradicts it.
      ['Recommended refuses quotes to verified people', changed(good, 'auto', { add: extra('native.quote', 'never', 'verified') })],
      ['Recommended refuses documents to verified people', changed(good, 'auto', { add: extra('native.release_document', 'never', 'verified') })],
      ['Recommended refuses documents to verified people through a rule for messages', changed(good, 'auto', { add: extra('effect:send_message', 'never', 'verified') })],
      ['Recommended refuses bookings to record owners, a narrower group', changed(good, 'auto', { add: extra('native.book', 'never', 'record_owner') })],
      ['Recommended refuses documents to verified people, a broader group, through a rule for private data', changed(good, 'auto', { add: extra('effect:private_data', 'never', 'verified') })],
    ];
    for (const [what, cards] of broken) expect({ what, problems: descriptionProblems(cards).length > 0 }).toEqual({ what, problems: true });
    // And a card a tool's own card outranks, or one for a tool no description speaks of, changes nothing.
    const fine: [string, PresetCards][] = [
      ['Recommended asks about changes, under its own quote and booking cards', changed(good, 'auto', { add: extra('effect:change', 'ask') })],
      ['Recommended lets anyone see their own charges', changed(good, 'auto', { add: extra('payments.list_charges', 'auto') })],
      ['Ask me first saves leads on its own', changed(good, 'ask_first', { add: extra('native.capture_lead', 'auto') })],
    ];
    for (const [what, cards] of fine) expect({ what, problems: descriptionProblems(cards) }).toEqual({ what, problems: [] });
    // Read as the export is read, a card marked as the compiler's default can't hide what it does.
    const flagged = (applies_to: string, mode: RuleCard['mode']): RuleCard => ({ ...extra(applies_to, mode), is_default: true });
    const hiding: [string, PresetCards][] = [
      ['Ask me first books on its own under a default flag', changed(good, 'ask_first', { add: flagged('native.book', 'auto') })],
      ['Ask me first refuses documents under a default flag', changed(good, 'ask_first', { add: flagged('native.release_document', 'never') })],
    ];
    for (const [what, cards] of hiding) expect({ what, fails: exportFails(cards) }).toEqual({ what, fails: true });
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
      ['an unknown target', withCard({ applies_to: 'native.quot' })],
      ['an unknown effect', withCard({ applies_to: 'effect:refund' })],
      ['hours that end before they start', withCard({ applies_to: 'native.find_slots', hours: { days: ['mon'], start: '17:00:00', end: '09:00:00' } })],
      ['hours that end as they start', withCard({ applies_to: 'native.find_slots', hours: { days: ['mon'], start: '09:00:00', end: '09:00:00' } })],
      // A default card is the compiler's ask for anyone, and `rulesForTool` passes over it, so it must be one.
      ['an automatic booking marked as a default', withCard({ applies_to: 'native.book', mode: 'auto', is_default: true })],
      ['a document refusal marked as a default', withCard({ applies_to: 'native.release_document', mode: 'never', is_default: true })],
      ['a default card for a narrower group', withCard({ applies_to: 'native.book', mode: 'ask', who: 'record_owner', is_default: true })],
      ['a default flag that is not true or false', withCard({ is_default: 'yes' })],
      // Who a card is for decides which card outranks which.
      ['a card for one person without the person', withCard({ who: 'person' })],
      ['a person on a card for anyone', withCard({ person_id: 'per-dana' })],
      ['a person who is not named by text', withCard({ who: 'person', person_id: 7 })],
      ['a card for one agent without its key', withCard({ who: 'agent' })],
      ['an agent key on a card for anyone', withCard({ agent_key_id: 'demo-agent' })],
      // Limits apply only to automatic cards.
      ['a discount on a card that asks', withCard({ mode: 'ask', max_discount_bp: 1000 })],
      ['hours on a card that refuses', withCard({ applies_to: 'native.book', mode: 'never', hours: { days: ['mon'], start: '09:00:00', end: '17:00:00' } })],
    ];
    for (const [what, value] of malformed) expect({ what, refused: refuses(() => parsePresetCards(value)) }).toEqual({ what, refused: true });
    // Well-formed cards the contract allows are read: a window that ends at midnight, 00:00, the
    // compiler's default ask for anyone, and a card for one person or one agent.
    const allowed: [string, unknown][] = [
      ['hours until midnight', withCard({ applies_to: 'native.find_slots', hours: { days: ['fri'], start: '22:00:00', end: '00:00:00' } })],
      ['a default ask for anyone', withCard({ applies_to: 'native.book', mode: 'ask', is_default: true })],
      ['a card for one person', withCard({ who: 'person', person_id: 'per-dana' })],
      ['a card for one agent', withCard({ who: 'agent', agent_key_id: 'demo-agent', person_id: null })],
    ];
    for (const [what, value] of allowed) expect({ what, refused: refuses(() => parsePresetCards(value)) }).toEqual({ what, refused: false });
  });

  test('preset_descriptions_are_the_owner_words', () => {
    // The two presets are the only ones: there is no Custom mode to pick.
    // @ts-expect-error 'custom' is no preset
    const notAPreset: RulesPreset = 'custom';
    expect(PRESET_WORDS.map((item) => item.value)).not.toContain(notAPreset);
    // Each says what it sets, in the signed presets board's words.
    expect(PRESET_WORDS).toEqual([
      { value: 'ask_first', label: 'Ask me first', description: 'Quotes, bookings, documents and payments wait for your answer.' },
      {
        value: 'auto',
        label: 'Recommended rules',
        description: 'Quotes at list price, weekday bookings in your hours, documents to verified customers. Payments ask you first.',
      },
    ]);
  });

  test('outcome_phrase_is_the_outcome_word_alone', () => {
    // One word per outcome, wherever a rule's outcome shows: a limit lives in the rule's sentence.
    expect(outcomePhrase('auto')).toBe('Allow');
    expect(outcomePhrase('ask')).toBe('Ask me first');
    expect(outcomePhrase('never')).toBe('Never');

    expect(OUTCOME_WORDS).toEqual({ auto: 'Allow', ask: 'Ask me first', never: 'Never' });
    // The groups take the same three words.
    expect(OUTCOME_GROUP_WORDS).toEqual(OUTCOME_WORDS);
    expect(OUTCOME_TONE).toEqual({ auto: 'handled', ask: 'held', never: 'refused' });
  });
});
