/**
 * A tool's one outcome on the owner's screens: the most that runs on its own for some visitor, so
 * an outcome never reads safer than what runs. Rules (`hubSections`), the change review's rows for
 * the tools a change turns on (`changeRows`) and setup's starting outcomes (`ToolsStep`) all read
 * it, so the three agree. It reads the rules and decides nothing: the kernel decides every request.
 *
 * It follows the kernel's rule compiler (`backend/desk/kernel_service/compiler.py`; the master
 * plan's "Coverage and overlap") for each of three visitors, with the rules for them:
 * - a stranger: rules for anyone;
 * - a verified customer: rules for anyone and for verified customers;
 * - a record's owner: those and rules for record owners, only on a tool whose records have an
 *   owner (`hasRecordOwner`). Elsewhere a rule for record owners is for no one, since the kernel
 *   matches it only when the resource's owner is the visitor (`_who`, line 360).
 * Rules for one person or one agent are left out: they never say what happens for anyone else.
 *
 * For one visitor at one moment:
 * - a never rule on the tool or on one of its effects refuses: it is a forbid (lines 541-542);
 * - else an automatic permit runs, unless an ask rule at the same or a higher rank, or another
 *   permit at a higher rank, covers the tool for that visitor (`_exclusions`, lines 498-501). A
 *   tool's own rule ranks above a shared one (`specificity`, `backend/desk/always_on.py` lines 32-39).
 *   The reviewer's check, when a rule has one, counts as passed;
 * - a permit is one automatic rule on the tool, one on the tool's only effect, or, on a tool with
 *   several effects, one automatic shared rule for each effect together (`_autos`, lines 440-461,
 *   and `_combinations`, lines 218-228), and it runs only while every one of its rules' hours holds
 *   (`_limits`, line 480);
 * - else it asks (an ask rule, a permit's hold twin, or the default ask).
 *
 * The always-on baseline (`kernel/cedar/baseline.cedar`) forbids in every decision, whatever the
 * rules say; its line numbers follow. Two of its rules change what runs for one of the three
 * visitors, and are read here:
 * - `private_data_record_owner` (lines 18-24): private data goes only to a verified visitor whose
 *   record it is (`principal.verified && context.record_owner_match`, which
 *   `backend/desk/kernel_service/decide.py` sets at line 129). So a tool with the `private_data` effect refuses a stranger and a verified customer
 *   who isn't the owner, and runs, if at all, only for the record's owner;
 * - `money_has_amount` (lines 58-68): money always moves an amount above zero, and a permit on a
 *   money tool requires the amount to be within its bound (`_limits` in `compiler.py`, lines 475-477), so a permit
 *   up to $0 on a tool that charges or pays out never runs.
 * The others change nothing these three visitors can run:
 * - `same_copy` (lines 10-16): every session acts on its own copy's records;
 * - `recipient_owner_or_verified_contact` (lines 26-36), with verification codes going only to the
 *   contact on record: an adapter sets a recipient only to `owner` or `verified_contact`
 *   (`backend/desk/kernel_service/adapters/base.py`, line 67), and no rule can change Confirm it's them
 *   (`changes_always_on`, `backend/desk/always_on.py` lines 49-69);
 * - `no_agent_pay_out` and `agent_charge_within_mandate` (lines 38-56): they bind agents only, and
 *   an agent is held to the rules for anyone that a stranger is, so it never runs more than one;
 *   the signed limit only narrows what an agent runs within them;
 * - `auto_money_cap` (lines 70-83): every automatic money rule in a version is within its payment
 *   limit (`validate_cards`, `compiler.py` lines 334-336; `lower_to_cap`, `backend/desk/money_cap.py`
 *   lines 29-52), so the payment limit never stops a permit its own limit lets run.
 * Nor does the kernel's money check (step 5, `kernel/core/src/policy.rs` lines 316-339): every
 * permit read here comes from an owner's rule on the tool or on one of its effects.
 *
 * Limits, as `_limits` bounds a permit (lines 474-477): a permit runs up to the tightest amount
 * limit among its rules, so a tool covered by shared rules on its several effects runs up to the
 * tightest of them; the permits that run add up, since any one of them allows a request, so a
 * visitor's limit is the largest of theirs; and the outcome takes the largest across visitors and
 * times. A rule with no amount limit runs with none. The limit shown is the rules' own: the
 * payment limit, which every permit on a money tool also holds to, has its own line.
 *
 * Hours are read exactly. Only an automatic rule has hours (the `RuleCard` contract: hours, limits
 * and the reviewer's check are automatic rules' only), and no exclusion depends on them, so the
 * week is cut at every edge of every rule's hours and each stretch between two edges is read on
 * its own, as the kernel reads a request's local day and minute.
 *
 * The outcome is the most permissive over visitors and stretches of the week: automatic, then ask
 * me first, then never, an automatic one at its largest limit. When every visitor is refused, it
 * names the never rule that refuses the one the baseline doesn't.
 */
import { MONEY_EFFECTS, type RuleCard } from '../../api/contracts.ts';
import type { RuleMode, RulesTool } from '../../ds/index.ts';
import { hasRecordOwner } from '../connectors/catalog.ts';

/** A tool's outcome: its mode, an automatic one's limit, and the rule that gives it. */
export interface ToolOutcome {
  mode: RuleMode;
  /** For "auto", the most it takes on its own in one request, in cents; null when no rule limits it, and for any other mode. */
  limitCents: number | null;
  /**
   * The rule that gives the outcome, for its words: the never rule; the ask rule that holds it; or
   * the automatic rule whose limit is the outcome's. None for the default ask.
   */
  rule?: RuleCard;
}

/** The visitors a tool's outcome is read for, each with the groups of people the rules for them name. */
const VISITORS = [
  { who: new Set<RuleCard['who']>(['anyone']), ownersOnly: false },
  { who: new Set<RuleCard['who']>(['anyone', 'verified']), ownersOnly: false },
  { who: new Set<RuleCard['who']>(['anyone', 'verified', 'record_owner']), ownersOnly: true },
] as const;

/** A rule on an effect group (`effect:charge`), which every tool with that effect shares. */
const isShared = (card: RuleCard) => card.applies_to.startsWith('effect:');

/** The baseline's refusal: no rule of the owner's gives it, so it names none. */
const REFUSED: ToolOutcome = { mode: 'never', limitCents: null };

/** The kernel's rank of a rule for a group of people: a tool's own rule above a shared one. */
const rank = (card: RuleCard) => (isShared(card) ? 0 : 1);

/** An automatic permit: one rule, or shared rules for each of the tool's effects together, at one rank. */
interface Permit {
  rules: readonly RuleCard[];
  rank: number;
}

/** The days of the week as the kernel numbers them (`local_dow`, Monday 0). */
const DAYS: readonly string[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_MINUTES = 1440;
const WEEK_MINUTES = 7 * DAY_MINUTES;

/** A time of day ("18:00:00") as minutes after midnight; an end at 00:00 is midnight, the day's end. Null when it can't be read. */
function minuteOf(time: string, end: boolean): number | null {
  const match = /^(\d{2}):(\d{2})/.exec(time);
  if (!match) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return end && minute === 0 ? DAY_MINUTES : minute;
}

/**
 * A rule's hours as stretches of the week, in minutes from Monday 00:00, as the kernel reads them
 * (`_hours`, lines 382-391); null when the rule has none, or hours that can't be read, so that it
 * counts as running at any time.
 */
function weekStretches(card: RuleCard): [number, number][] | null {
  if (card.hours == null) return null;
  const start = minuteOf(card.hours.start, false);
  const end = minuteOf(card.hours.end, true);
  if (start === null || end === null || end <= start) return null;
  return card.hours.days.flatMap((day) => {
    const at = DAYS.indexOf(day);
    return at === -1 ? [] : [[at * DAY_MINUTES + start, at * DAY_MINUTES + end] as [number, number]];
  });
}

/** Whether `card` runs at `minute` of the week: it has no hours, or one of its stretches holds it. */
function runsAt(card: RuleCard, minute: number): boolean {
  const stretches = weekStretches(card);
  return stretches === null || stretches.some(([from, to]) => minute >= from && minute < to);
}

/** The first minute of each stretch of the week between two edges of the rules' hours. */
function weekMoments(cards: readonly RuleCard[]): number[] {
  const edges = new Set<number>([0]);
  for (const card of cards) for (const [from, to] of weekStretches(card) ?? []) edges.add(from).add(to % WEEK_MINUTES);
  return [...edges].sort((a, b) => a - b);
}

/** The tightest amount limit among a permit's rules; null when none of them has one. */
function permitLimit(permit: Permit): number | null {
  const limits = permit.rules.flatMap((card) => (card.max_amount_cents == null ? [] : [card.max_amount_cents]));
  return limits.length === 0 ? null : Math.min(...limits);
}

/** True when limit `a` lets more through than `b`: no limit lets the most. */
const wider = (a: number | null, b: number | null) => b !== null && (a === null || a > b);

/** The rule a permit's outcome reads by: the one whose limit is the permit's, else its first. */
function permitRule(permit: Permit): RuleCard {
  const limit = permitLimit(permit);
  return permit.rules.find((card) => card.max_amount_cents != null && card.max_amount_cents === limit) ?? (permit.rules[0] as RuleCard);
}

/** Every way to take one rule from each list, in order. */
function oneOfEach(lists: readonly (readonly RuleCard[])[]): RuleCard[][] {
  return lists.reduce<RuleCard[][]>((combos, list) => combos.flatMap((combo) => list.map((card) => [...combo, card])), [[]]);
}

/**
 * The tool's automatic permits among `rules` (`_autos`): each automatic rule on the tool; each
 * automatic shared rule on its effect when that is the tool's only effect; and on a tool with
 * several effects, each set of one automatic shared rule per effect.
 */
function permitsFor(tool: RulesTool, rules: readonly RuleCard[]): Permit[] {
  const autos = rules.filter((card) => card.mode === 'auto');
  const own = autos.filter((card) => card.applies_to === tool.tool).map((card): Permit => ({ rules: [card], rank: 1 }));
  // In the compiler's order (`sorted(effects)`), so a tie reads by the same rule.
  const effects = [...new Set(tool.effects)].sort();
  const perEffect = effects.map((effect) => autos.filter((card) => card.applies_to === `effect:${effect}`));
  const shared = effects.length === 0 ? [] : oneOfEach(perEffect).map((combo): Permit => ({ rules: combo, rank: 0 }));
  return [...own, ...shared];
}

/** How much each mode lets run on its own: never least, automatic most. */
const MODE_ORDER: Readonly<Record<RuleMode, number>> = { never: 0, ask: 1, auto: 2 };

/** Whether outcome `a` lets more run on its own than `b`: automatic over ask over never, then the wider limit. */
function morePermissive(a: ToolOutcome, b: ToolOutcome): boolean {
  if (a.mode !== b.mode) return MODE_ORDER[a.mode] > MODE_ORDER[b.mode];
  return a.mode === 'auto' && wider(a.limitCents, b.limitCents);
}

/**
 * Whether `reading` replaces `best` as the outcome: it lets more run on its own, or, both refusing,
 * it names the never rule that refuses where `best` is the baseline's refusal, which names none.
 */
function replaces(reading: ToolOutcome, best: ToolOutcome | undefined): boolean {
  if (best === undefined || morePermissive(reading, best)) return true;
  return reading.mode === 'never' && best.mode === 'never' && best.rule === undefined && reading.rule !== undefined;
}

/**
 * The tool's outcome under `cards` (a version's, or one side of a draft): the most that runs on its
 * own for some visitor, as this module's header sets out. Default cards are left out: the default
 * ask is what is left when nothing else decides.
 */
export function toolOutcome(tool: RulesTool, cards: readonly RuleCard[]): ToolOutcome {
  const covering = cards.filter(
    (card) => card.is_default !== true && (card.applies_to === tool.tool || tool.effects.some((effect) => card.applies_to === `effect:${effect}`)),
  );
  const moments = weekMoments(covering.filter((card) => card.mode === 'auto'));
  const owned = hasRecordOwner(tool.tool);
  // The baseline's `private_data_record_owner`: only the record's owner gets private data.
  const privateData = tool.effects.includes('private_data');
  // The baseline's `money_has_amount`: money moves only in an amount above zero.
  const money = tool.effects.some((effect) => MONEY_EFFECTS.has(effect));
  let best: ToolOutcome | undefined;
  for (const visitor of VISITORS) {
    if (visitor.ownersOnly && !owned) continue;
    if (privateData && !visitor.ownersOnly) {
      if (replaces(REFUSED, best)) best = REFUSED;
      continue;
    }
    const rules = covering.filter((card) => visitor.who.has(card.who));
    const byRank = [...rules].sort((a, b) => rank(b) - rank(a));
    const never = byRank.find((card) => card.mode === 'never');
    const asks = byRank.filter((card) => card.mode === 'ask');
    const permits = permitsFor(tool, rules);
    // A permit runs unless an ask rule at its rank or above, or another permit above it, excludes it (`_exclusions`).
    const running = permits.filter((permit) => !asks.some((ask) => rank(ask) >= permit.rank) && !permits.some((other) => other.rank > permit.rank));
    const asked: ToolOutcome = { mode: 'ask', limitCents: null, ...(asks[0] === undefined ? {} : { rule: asks[0] }) };
    for (const minute of moments) {
      let reading: ToolOutcome = never !== undefined ? { mode: 'never', limitCents: null, rule: never } : asked;
      if (never === undefined) {
        for (const permit of running) {
          if (!permit.rules.every((card) => runsAt(card, minute))) continue;
          const limit = permitLimit(permit);
          if (money && limit !== null && limit <= 0) continue;
          const runs: ToolOutcome = { mode: 'auto', limitCents: limit, rule: permitRule(permit) };
          if (morePermissive(runs, reading)) reading = runs;
        }
      }
      if (replaces(reading, best)) best = reading;
    }
  }
  return best ?? { mode: 'ask', limitCents: null };
}
