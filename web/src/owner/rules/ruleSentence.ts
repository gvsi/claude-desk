/**
 * Each rule as one sentence led by Claude, in the REV-RULES-C boards' words, with its key values set
 * off: "Claude can send payment links up to **$300**". `ruleSentence` builds it from the card's
 * own fields and a phrase per tool (`TOOL_PHRASES`); `ruleMeta` gives the line under it, the tools
 * it covers and who; `holdLine`, `holdSentence`, `discountHoldSentence` and `moneyCapSentence` word
 * what asks the owner first beyond an automatic rule; `ALWAYS_ON_SENTENCES` are the always-on rules.
 * `RuleSentence` in the design system draws them. They read the rules and decide nothing: the
 * kernel decides every request.
 */
import { MONEY_EFFECTS, type RuleCard } from '../../api/contracts.ts';
import type { PeopleOut, ToolRow } from '../../api/views.ts';
import type { RuleMeta, SentencePart } from '../../ds/index.ts';
import { formatCents, hoursParts, listWords } from '../../lib/format.ts';
import { TOOL_NAMES, isBusinessToolName, toolDisplayName, type BusinessTools } from '../connectors/catalog.ts';
import { coveredTools } from './changeRows.ts';
import { percent, targetWords, whoWords, type AgentNames } from './ruleWords.ts';

export type { RuleMeta, SentencePart };

/** What a sentence needs besides the card: the Desk's business tools by name, and who its people and agents are. */
export interface SentenceWords {
  business: BusinessTools;
  people?: PeopleOut | null;
  agents?: AgentNames;
  /**
   * The Desk's tools, in the order the screen lists them, so a rule on an effect group names the
   * tools it covers ("Payment link and Charge within a signed limit"). Without them it names its
   * group in the app's words ("Every tool that charges money").
   */
  tools?: readonly Pick<ToolRow, 'tool' | 'effects'>[];
  /**
   * The rules an effect group's rule is read among: the active version's cards, or one side of a
   * draft. An automatic rule on a group covers a tool with several effects only together with an
   * automatic rule for each of the others (`coveredTools`), so the line names only the tools it
   * governs. Without them, the row's own cards are read alone.
   */
  cards?: readonly RuleCard[];
}

/** A phrase: plain words, or runs with key values set off. */
type Phrase = string | readonly SentencePart[];

/**
 * A tool's words inside a rule's sentence:
 * - `can`: what Claude does, after "Claude can " ("send payment links"); after "Claude never " its
 *   first word takes an s ("sends payment links");
 * - `before`: what Claude asks about, after "Claude asks you before " ("any refund");
 * - `after`: words that follow the rule's limit ("Claude can take agent payments up to $20 from a signed limit");
 * - `over`: its requests, plural, past an automatic rule's limit ("payment links over $300").
 */
export interface ToolPhrase {
  can: Phrase;
  before: Phrase;
  after?: string;
  over?: string;
}

const key = (text: string): SentencePart => ({ text, key: true });

/**
 * Each built-in tool's and effect group's phrase, in the REV-RULES-C boards' words where a board
 * draws the tool, and in their pattern where none does.
 */
export const TOOL_PHRASES: Readonly<Record<string, ToolPhrase>> = {
  'native.quote': { can: 'send quotes from your price list', before: [key('any quote')], over: 'quotes' },
  'native.find_slots': { can: 'show your open times', before: 'showing your open times' },
  'native.book': { can: 'book visits', before: [key('any booking')], over: 'bookings' },
  'native.capture_lead': { can: 'take leads', before: 'saving a lead' },
  'native.request_callback': { can: 'take callbacks', before: 'asking you to call someone back' },
  'native.start_verification': { can: 'send codes to the contact on record', before: 'sending a code' },
  'native.release_document': { can: "share customers' own documents", before: 'sharing a document' },
  'native.payment_link': { can: 'send payment links', before: [key('any payment link')], over: 'payment links' },
  'native.charge_mandate': { can: 'take agent payments', before: [key('any agent payment')], after: ' from a signed limit', over: 'agent payments' },
  'payments.list_charges': { can: [{ text: 'show customers ' }, key('their own charges')], before: "showing a customer's charges" },
  'payments.create_refund': { can: 'send refunds', before: [key('any refund')], over: 'refunds' },
  'native.fetch_website': { can: 'read your website', before: 'reading your website' },
  'native.read_memory': { can: 'read the notes you brought in', before: 'reading your notes' },
  'native.web_search': { can: 'search the web', before: 'searching the web' },
  'effect:charge': { can: 'take payments', before: [key('any payment')], over: 'payments' },
  'effect:pay_out': { can: 'send money out', before: 'sending money out', over: 'payments out' },
  'effect:private_data': { can: 'share private data', before: 'sharing private data' },
  'effect:send_message': { can: 'send messages', before: 'sending a message' },
  'effect:change': { can: 'make changes', before: 'making a change' },
  'effect:read': { can: 'look things up', before: 'looking anything up' },
};

/**
 * Phrases for the rows the C1 board joins: one rule over several tools that read as one. A
 * business tool joins by its block (`desk:urgent`, a Desk's urgent callback), since its name is
 * the Desk's own.
 */
export const JOINED_PHRASES: readonly { targets: readonly string[]; phrase: ToolPhrase }[] = [
  { targets: ['native.find_slots', 'native.book'], phrase: { can: 'book visits', before: [key('any booking')], over: 'bookings' } },
  { targets: ['native.capture_lead', 'native.request_callback'], phrase: { can: 'take leads and callbacks', before: 'saving a lead or a callback' } },
  {
    targets: ['native.capture_lead', 'native.request_callback', 'desk:urgent'],
    phrase: { can: 'take leads and callbacks, urgent ones too', before: 'saving a lead or a callback' },
  },
  {
    targets: ['native.release_document', 'payments.list_charges'],
    phrase: { can: "share customers' own documents and charges", before: 'sharing a document or a charge' },
  },
];

/** A phrase as runs. */
function runs(phrase: Phrase): SentencePart[] {
  return typeof phrase === 'string' ? [{ text: phrase }] : phrase.map((part) => ({ ...part }));
}

/** A title after "use", its first letter lowercased unless the title starts with an acronym ("SMS reminder"). */
function lowerFirst(title: string): string {
  const [first = '', second = ''] = title;
  if (second !== '' && second === second.toUpperCase() && second !== second.toLowerCase()) return title;
  return `${first.toLowerCase()}${title.slice(first.length)}`;
}

/**
 * A target's phrase: the table's; a listed business tool's own title, set off as user text, "use
 * {title}"; else the app's words for it ("use a connected tool"), never its raw name.
 */
function targetPhrase(target: string, business: BusinessTools): ToolPhrase {
  const phrase = Object.hasOwn(TOOL_PHRASES, target) ? TOOL_PHRASES[target] : undefined;
  if (phrase !== undefined) return phrase;
  const title = isBusinessToolName(target) ? toolDisplayName(target, business) : null;
  if (title !== null && title.trim() !== '') {
    const named: SentencePart = { text: lowerFirst(title.trim()), user: true };
    return { can: [{ text: 'use ' }, named], before: [{ text: 'using ' }, named] };
  }
  const words = lowerFirst(targetWords(target, business));
  return { can: `use ${words}`, before: `using ${words}` };
}

/** The key a target joins a row by: a business tool by its block, any other by its name. */
function joinKey(target: string, business: BusinessTools): string {
  const def = isBusinessToolName(target) ? business.get(target) : undefined;
  return def === undefined ? target : `desk:${def.config.block}`;
}

/** Runs joined as a list: "a, b and c" (or "or"). */
function joinRuns(phrases: readonly SentencePart[][], last: 'and' | 'or'): SentencePart[] {
  return phrases.flatMap((phrase, index) => {
    if (index === 0) return phrase;
    return [{ text: index === phrases.length - 1 ? ` ${last} ` : ', ' }, ...phrase];
  });
}

/** A row's phrase, with its actions after "Claude never " each in the third person. */
interface RowPhrase extends ToolPhrase {
  never: SentencePart[];
}

/** One phrase as a row's, its action after "Claude never " in the third person. */
function onePhrase(phrase: ToolPhrase): RowPhrase {
  return { ...phrase, never: thirdPerson(runs(phrase.can)) };
}

/**
 * The phrase for a row's targets: one target's, a joined row's from `JOINED_PHRASES`, else each
 * target's joined, each keeping its own trailing words and, after "Claude never ", its own verb in
 * the third person ("sends quotes from your price list and books visits").
 */
function rowPhrase(targets: readonly string[], business: BusinessTools): RowPhrase {
  const [only] = targets;
  if (only !== undefined && targets.length === 1) return onePhrase(targetPhrase(only, business));
  const keys = new Set(targets.map((target) => joinKey(target, business)));
  const joined = JOINED_PHRASES.find((row) => row.targets.length === keys.size && row.targets.every((target) => keys.has(target)));
  if (joined !== undefined) return onePhrase(joined.phrase);
  const phrases = targets.map((target) => targetPhrase(target, business));
  const withAfter = (parts: SentencePart[], phrase: ToolPhrase) => (phrase.after === undefined ? parts : [...parts, { text: phrase.after }]);
  return {
    can: joinRuns(phrases.map((phrase) => withAfter(runs(phrase.can), phrase)), 'and'),
    before: joinRuns(phrases.map((phrase) => withAfter(runs(phrase.before), phrase)), 'or'),
    never: joinRuns(phrases.map((phrase) => withAfter(thirdPerson(runs(phrase.can)), phrase)), 'and'),
  };
}

/** Runs with their first word in the third person, after "Claude never ": "send" → "sends", "search" → "searches". */
function thirdPerson(parts: SentencePart[]): SentencePart[] {
  const [first, ...rest] = parts;
  if (first === undefined) return parts;
  const match = /^(\S+)(.*)$/s.exec(first.text);
  if (match === null) return parts;
  const [, verb = '', tail = ''] = match;
  const conjugated = /(s|sh|ch|x|z)$/.test(verb) ? `${verb}es` : /[^aeiou]y$/.test(verb) ? `${verb.slice(0, -1)}ies` : `${verb}s`;
  return [{ ...first, text: `${conjugated}${tail}` }, ...rest];
}

/** Two windows with the same days, in the same order, and the same start and end; or neither. */
function sameHours(a: RuleCard['hours'], b: RuleCard['hours']): boolean {
  if (a == null || b == null) return a == null && b == null;
  return a.start === b.start && a.end === b.end && a.days.length === b.days.length && a.days.every((day, i) => day === b.days[i]);
}

/** Who a card is for, as its fields and its words say it ("Anyone" and "Signed agents" differ). */
function audience(card: RuleCard): string {
  const named = whoWords(card, null, undefined).map((word) => word.text);
  return JSON.stringify([card.who, card.person_id ?? null, card.agent_key_id ?? null, named]);
}

/**
 * Whether these cards read as one rule, one sentence over all their tools: the same outcome, the
 * same audience, the same amount and discount limits and the same hours. A row that joins cards
 * that differ in any of these would drop one card's limit or audience, so `ruleSentence` and
 * `ruleMeta` refuse it; a screen groups its cards with this first.
 */
export function canJoin(cards: readonly RuleCard[]): boolean {
  const [first, ...rest] = cards;
  if (first === undefined) return false;
  return rest.every(
    (card) =>
      card.mode === first.mode &&
      audience(card) === audience(first) &&
      (card.max_amount_cents ?? null) === (first.max_amount_cents ?? null) &&
      (card.max_discount_bp ?? 0) === (first.max_discount_bp ?? 0) &&
      sameHours(card.hours, first.hours),
  );
}

/** The cards of one row, at least one, that read as one rule (`canJoin`); any other set is refused, never joined. */
function asCards(card: RuleCard | readonly RuleCard[]): [RuleCard, ...RuleCard[]] {
  const cards: readonly RuleCard[] = Array.isArray(card) ? card : [card as RuleCard];
  const [first, ...rest] = cards;
  if (first === undefined) throw new Error('a rule sentence needs a card');
  if (!canJoin(cards)) {
    throw new Error("cards that differ in outcome, audience, limits or hours can't read as one rule: give each its own sentence");
  }
  return [first, ...rest];
}

/** Each target once, in card order. */
function targetsOf(cards: readonly RuleCard[]): string[] {
  return [...new Set(cards.map((card) => card.applies_to))];
}

/**
 * Hours in the sentence: " on **weekdays, 8:00 am to 6:00 pm**", " on **Saturdays, 9:00 am to 1:00
 * pm**", " **every day, all day**". Weekdays, weekends and every day are lowercased; a day keeps its capital.
 */
function hoursRuns(hours: NonNullable<RuleCard['hours']>): SentencePart[] {
  const { days, times } = hoursParts(hours);
  const lowered = /^(Weekdays|Weekends|Every day)\b/.test(days) ? `${days.charAt(0).toLowerCase()}${days.slice(1)}` : days;
  const when = `${lowered}, ${times}`;
  return lowered.startsWith('every day') ? [{ text: ' ' }, key(when)] : [{ text: ' on ' }, key(when)];
}

/** Whether any of the row's cards is for people who confirmed it's them. */
const forVerified = (cards: readonly RuleCard[]) => cards.some((card) => card.who === 'verified' || card.who === 'record_owner');

/**
 * A rule's sentence, from its card, or from the cards of one row that read as one rule
 * (`canJoin`: the same outcome, audience, limits and hours), as C1 joins leads and callbacks.
 * Cards that differ are refused with an error, never joined:
 * - led by its mode: `auto` "Claude can ", `ask` "Claude asks you before ", `never` "Claude never ";
 * - then its tool's phrase (`TOOL_PHRASES`, `JOINED_PHRASES`; a business tool "use {title}");
 * - then its conditions, each value set off: " up to **$300**"; on an automatic quote ", at **list
 *   price**" or " with up to **10%** off"; " on **weekdays, 8:00 am to 6:00 pm**"; and on an
 *   automatic rule for verified people or the record's owner, ", once they've confirmed it's them".
 */
export function ruleSentence(card: RuleCard | readonly RuleCard[], words: SentenceWords): SentencePart[] {
  const cards = asCards(card);
  const [first] = cards;
  const targets = targetsOf(cards);
  const phrase = rowPhrase(targets, words.business);
  const parts: SentencePart[] = [];
  if (first.mode === 'auto') parts.push({ text: 'Claude can ' }, ...runs(phrase.can));
  else if (first.mode === 'ask') parts.push({ text: 'Claude asks you before ' }, ...runs(phrase.before));
  else parts.push({ text: 'Claude never ' }, ...phrase.never);

  const amount = first.max_amount_cents;
  if (amount != null) parts.push({ text: ' up to ' }, key(formatCents(amount)));
  if (phrase.after !== undefined) parts.push({ text: phrase.after });
  if (first.mode === 'auto') {
    const discount = first.max_discount_bp ?? 0;
    if (discount > 0) parts.push({ text: ' with up to ' }, key(percent(discount)), { text: ' off' });
    else if (targets.includes('native.quote')) parts.push({ text: ', at ' }, key('list price'));
  }
  const hours = first.hours;
  if (hours != null) parts.push(...hoursRuns(hours));
  if (first.mode === 'auto' && forVerified(cards)) parts.push({ text: ", once they've confirmed it's them" });
  return merged(parts);
}

/** Adjacent plain runs as one, so a sentence's plain words read as one run of text. */
function merged(parts: readonly SentencePart[]): SentencePart[] {
  const out: SentencePart[] = [];
  for (const part of parts) {
    const last = out.at(-1);
    if (last !== undefined && last.key !== true && last.user !== true && part.key !== true && part.user !== true) last.text += part.text;
    else out.push({ ...part });
  }
  return out;
}

/**
 * The titles of the Desk's tools, in the screen's order, that an effect group's `card` governs
 * among `words.cards` (else among the row's own cards), as Rules reads coverage (`coveredTools`):
 * an automatic one covers a tool with several effects only with an automatic rule for each other.
 */
function toolsCovered(card: RuleCard, row: readonly RuleCard[], words: SentenceWords): string[] {
  const among = words.cards ?? row;
  const pool = among.some((other) => other.card_id === card.card_id) ? among : [...among, card];
  return coveredTools(card, pool, words.tools ?? [])
    .map((tool) => toolDisplayName(tool, words.business))
    .filter((title): title is string => title !== null && title.trim() !== '');
}

/** Who a card is for, in one line: "Anyone", "The record's owner, verified", "Dana Whitfield, verified". */
function whoLine(card: RuleCard, words: SentenceWords): string {
  return whoWords(card, words.people, words.agents)
    .map((word, index) => (index === 0 ? word.text : lowerFirst(word.text)))
    .join(', ');
}

/**
 * The line under a rule's sentence (`RuleMeta`): the tools it covers by their titles, "Find open
 * times and Book a visit", or for a rule on an effect group the Desk's tools with that effect
 * (`words.tools`), else the group in the app's words; then who it is for, as Rules has always said
 * it ("Anyone", "Signed agents", "The record's owner, verified"). Cards that can't read as one
 * rule (`canJoin`) are refused with an error.
 */
export function ruleMeta(card: RuleCard | readonly RuleCard[], words: SentenceWords): RuleMeta {
  const cards = asCards(card);
  const named: { titles: string[]; words: string }[] = targetsOf(cards).map((target) => {
    const effectCard = target.startsWith('effect:') ? cards.find((c) => c.applies_to === target) : undefined;
    if (effectCard !== undefined) {
      return { titles: toolsCovered(effectCard, cards, words), words: targetWords(target, words.business) };
    }
    const title = toolDisplayName(target, words.business);
    return { titles: title === null ? [] : [title], words: targetWords(target, words.business) };
  });
  const who = whoLine(cards[0], words);
  if (named.every((target) => target.titles.length > 0)) return { tools: { titles: [...new Set(named.flatMap((target) => target.titles))] }, who };
  return { tools: listWords(named.map((target) => (target.titles.length > 0 ? listWords(target.titles) : target.words))), who };
}

/** An automatic card's amount limit: the one an amount past it asks the owner first about. */
const limitOf = (card: RuleCard): number | null => (card.mode === 'auto' && card.max_amount_cents != null ? card.max_amount_cents : null);

/** An automatic card's hold line under it, as C4 draws it: "Over **$300**, Claude asks you first". Null without a limit. */
export function holdLine(card: RuleCard): SentencePart[] | null {
  const limit = limitOf(card);
  if (limit === null) return null;
  return [{ text: 'Over ' }, key(formatCents(limit)), { text: ', Claude asks you first' }];
}

/** Who a card is for as a key: its group, or the one person or agent it names. */
const audienceKey = (card: RuleCard): string => JSON.stringify([card.who, card.person_id ?? null, card.agent_key_id ?? null]);

/** The automatic cards with an amount limit, grouped by whom they are for, in card order. */
function holdGroups(cards: readonly RuleCard[]): RuleCard[][] {
  const groups = new Map<string, RuleCard[]>();
  for (const card of cards) {
    if (limitOf(card) === null) continue;
    const group = groups.get(audienceKey(card));
    if (group === undefined) groups.set(audienceKey(card), [card]);
    else group.push(card);
  }
  return [...groups.values()];
}

/** One group's hold: "Claude asks you before payment links over **$300** or agent payments over **$20**". */
function holdParts(group: readonly RuleCard[]): SentencePart[] {
  const each = group.map((card): SentencePart[] => {
    const over = Object.hasOwn(TOOL_PHRASES, card.applies_to) ? TOOL_PHRASES[card.applies_to]?.over : undefined;
    return [{ text: `${over ?? 'payments'} over ` }, key(formatCents(limitOf(card) ?? 0))];
  });
  return merged([{ text: 'Claude asks you before ' }, ...joinRuns(each, 'or')]);
}

/**
 * One group's hold line: its tools, each named once, and whom its cards are for. Past an automatic
 * rule's limit the kernel's hold keeps that rule's audience, so a hold for anyone reads "Anyone" and
 * one person's reads their name.
 */
function holdGroupMeta(group: readonly RuleCard[], words: SentenceWords): RuleMeta {
  const [first] = group;
  const titles = [...new Set(group.map((card) => toolDisplayName(card.applies_to, words.business) ?? targetWords(card.applies_to, words.business)))];
  const named = group.every((card) => toolDisplayName(card.applies_to, words.business) !== null);
  // Read as a group, not as one tool's, so a hold for anyone isn't "Signed agents".
  const who = first === undefined ? 'Anyone' : whoLine({ ...first, applies_to: '' }, words);
  return { tools: named ? { titles } : listWords(titles), who };
}

/**
 * The Ask me first rows past the automatic rules' amount limits: one per group of people, its
 * limits joined as C1 joins them ("Claude asks you before payment links over **$300** or agent
 * payments over **$20**", Payment link and Charge within a signed limit · Anyone), and a person's
 * or agent's own limits in a row of their own. Empty when no card has a limit.
 */
export function holdRows(cards: readonly RuleCard[], words: SentenceWords): { parts: SentencePart[]; meta: RuleMeta }[] {
  return holdGroups(cards).map((group) => ({ parts: holdParts(group), meta: holdGroupMeta(group, words) }));
}

/** The one group of limits a single hold sentence can word; holds for different people are refused. */
function oneHoldGroup(cards: readonly RuleCard[]): RuleCard[] | null {
  const groups = holdGroups(cards);
  if (groups.length > 1) throw new Error("holds for different people can't read as one sentence: give each its own (holdRows)");
  return groups[0] ?? null;
}

/**
 * One Ask me first sentence for the automatic cards with an amount limit, when they are all for
 * the same people, each keeping its own amount: "Claude asks you before payment links over
 * **$300** or agent payments over **$20**". A tool the table has no requests for reads as
 * payments, since only a rule that moves money takes a limit. Null when none has a limit; limits
 * for different people are refused with an error (`holdRows` gives each its own row).
 */
export function holdSentence(cards: readonly RuleCard[]): SentencePart[] | null {
  const group = oneHoldGroup(cards);
  return group === null ? null : holdParts(group);
}

/**
 * The line under `holdSentence`: the limited cards' tools, each named once, and whom they are for.
 * Null when none has a limit; limits for different people are refused with an error (`holdRows`).
 */
export function holdMeta(cards: readonly RuleCard[], words: SentenceWords): RuleMeta | null {
  const group = oneHoldGroup(cards);
  return group === null ? null : holdGroupMeta(group, words);
}

/**
 * What asks the owner first past an automatic quote rule's discount, as C1 and B5 word it:
 * "Claude asks you before **any discount**" at list price, "Claude asks you before discounts over
 * **10%**" with one. Null for any other card.
 */
export function discountHoldSentence(card: RuleCard): SentencePart[] | null {
  if (card.mode !== 'auto' || card.applies_to !== 'native.quote') return null;
  const discount = card.max_discount_bp ?? 0;
  if (discount <= 0) return [{ text: 'Claude asks you before ' }, key('any discount')];
  return [{ text: 'Claude asks you before discounts over ' }, key(percent(discount))];
}

/**
 * The payment limit as a rule, over every rule that moves money: "Claude asks you before any
 * payment over **$500**, whatever the other rules say"; at 0, "Claude asks you before any payment".
 */
export function moneyCapSentence(cents: number): SentencePart[] {
  if (cents <= 0) return [{ text: 'Claude asks you before any payment' }];
  return [{ text: 'Claude asks you before any payment over ' }, key(formatCents(cents)), { text: ', whatever the other rules say' }];
}

/** C4's compact payment-limit sentence on Your tools; C1 keeps `moneyCapSentence`. */
export function moneyCapToolSentence(cents: number): SentencePart[] {
  if (cents <= 0) return [{ text: 'Any payment asks you first' }];
  return [{ text: 'Any payment over ' }, key(formatCents(cents)), { text: ' asks you first' }];
}

/**
 * The payment limit's line: the Desk's tools that move money (`words.tools`, in the screen's order),
 * else the app's words for them; for anyone.
 */
export function moneyCapMeta(words: SentenceWords): RuleMeta {
  const titles = (words.tools ?? [])
    .filter((row) => row.effects.some((effect) => MONEY_EFFECTS.has(effect)))
    .map((row) => toolDisplayName(row.tool, words.business))
    .filter((title): title is string => title !== null && title.trim() !== '');
  return { tools: titles.length > 0 ? { titles } : 'Every tool that moves money', who: 'Anyone' };
}

/** One always-on rule as a sentence: its key (`ai`, `private_data`, `codes`, `money`), its words and its line. */
export interface AlwaysOnSentence {
  key: 'ai' | 'private_data' | 'codes' | 'money';
  parts: readonly SentencePart[];
  meta: RuleMeta;
}

/** The catalog's titles for these tools, as the always-on rows name them. */
const titles = (...tools: (keyof typeof TOOL_NAMES)[]): { titles: string[] } => ({ titles: tools.map((tool) => TOOL_NAMES[tool].name) });

/** The always-on rules as C1's Never rows, each with the tools it covers and "Everyone". */
export const ALWAYS_ON_SENTENCES: readonly AlwaysOnSentence[] = [
  { key: 'ai', parts: [{ text: "Claude never says it's anything but an AI" }], meta: { tools: 'Every tool', who: 'Everyone' } },
  {
    key: 'private_data',
    parts: [{ text: 'Claude never shows private data to anyone but its verified owner' }],
    meta: { tools: titles('native.release_document', 'payments.list_charges'), who: 'Everyone' },
  },
  {
    key: 'codes',
    parts: [{ text: 'Claude never sends a code anywhere but the contact on record' }],
    meta: { tools: titles('native.start_verification'), who: 'Everyone' },
  },
  {
    key: 'money',
    parts: [{ text: 'Claude never moves money without your rule or a signed limit' }],
    meta: { tools: titles('native.payment_link', 'native.charge_mandate', 'payments.create_refund'), who: 'Everyone' },
  },
];
