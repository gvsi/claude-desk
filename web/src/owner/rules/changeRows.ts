/**
 * The rows a rules review shows (`ChangeReview`), from a draft alone: the design system's
 * `reviewChanges` pairs the cards, the one algorithm every review's rows follow, and this gives
 * each side its words. It decides no outcome the draft doesn't enforce.
 */
import type { Effect, RuleCard, ToolName } from '../../api/contracts.ts';
import type { PeopleOut, ToolRow } from '../../api/views.ts';
import { reviewChanges, ruleDiff, rulesForTool, type ChangeRowView, type ChangeSide, type RulesTool } from '../../ds/index.ts';
import { formatCents } from '../../lib/format.ts';
import { CONNECTORS, TOOL_NAMES, connectorOf } from '../connectors/catalog.ts';
import type { RuleDraft } from './drafts.ts';
import { ruleWords, targetWords } from './ruleWords.ts';

/** What applies where no rule the owner set covers a request: the compiler's default ask. */
export const DEFAULT_SIDE = {
  mode: 'ask',
  reason: 'Not covered by a rule you set, so I ask you.',
  words: [{ field: 'who', text: 'Anyone' }],
} as const satisfies ChangeSide;

/** The tools a rules review knows the effects of, by name. */
type ToolEffects = readonly Pick<ToolRow, 'tool' | 'effects'>[];

/** The connector a card's tool belongs to; none for an effect card or a tool the catalog doesn't know. */
function connectorFor(card: RuleCard) {
  return card.applies_to.startsWith('effect:') ? undefined : (connectorOf(card.applies_to as ToolName)?.view ?? undefined);
}

/**
 * A card on one side of a row: its outcome and limit, its reason and its words, and, when the row's
 * target moves (a card retargeted, or one that goes to a rule for a whole effect group), what it
 * applies to, so the widened or narrowed target shows. Otherwise the row's title names the target
 * and the sides don't repeat it (N-Conn-18).
 */
function cardSide(card: RuleCard, people: PeopleOut | null | undefined, moved: boolean): ChangeSide {
  const amount = card.mode === 'auto' && card.max_amount_cents != null ? formatCents(card.max_amount_cents) : undefined;
  return {
    ...(moved ? { appliesTo: targetWords(card.applies_to) } : {}),
    mode: card.mode,
    ...(amount === undefined ? {} : { limit: amount }),
    reason: card.reason,
    words: ruleWords(card, people),
  };
}

/** The default ask, which is for the row's own tool, so it names no target. */
function defaultSide(): ChangeSide {
  return { ...DEFAULT_SIDE, words: [...DEFAULT_SIDE.words] };
}

/** A card shared by every tool with that effect (`effect:charge`), which a tool's own card outranks. */
const isEffectCard = (card: RuleCard) => card.applies_to.startsWith('effect:');

/**
 * The rule that decides a tool for anyone, at any time, by the master plan's precedence. Of the
 * rules that govern it (`rulesForTool`) for anyone at all hours: a never rule always wins; else, at
 * the most specific level present (the tool's own rules before shared ones), an ask rule makes it
 * ask, else an automatic one decides, a shared one only where every effect of the tool has one for
 * anyone. None when no rule decides for anyone: the default ask does.
 */
function governingForAnyone(tool: RulesTool, cards: readonly RuleCard[]): RuleCard | undefined {
  const forAnyone = rulesForTool(tool, cards).filter((card) => card.who === 'anyone' && card.hours == null);
  const never = forAnyone.find((card) => card.mode === 'never');
  if (never !== undefined) return never;
  const [first] = forAnyone;
  if (first === undefined) return undefined;
  const level = forAnyone.filter((card) => isEffectCard(card) === isEffectCard(first));
  const ask = level.find((card) => card.mode === 'ask');
  if (ask !== undefined) return ask;
  const auto = level.filter((card) => card.mode === 'auto');
  if (!isEffectCard(first)) return auto[0];
  return tool.effects.every((effect) => auto.some((card) => card.applies_to === `effect:${effect}`)) ? auto[0] : undefined;
}

/** Every tool in the order the Connectors page lists them, then the setup interview's own. */
const TOOL_ORDER: readonly string[] = [...new Set<string>([...CONNECTORS.flatMap((connector) => connector.tools), ...Object.keys(TOOL_NAMES)])];

/** Where a tool's rows go: by connector, by tool within one, then any tool the catalog doesn't know. */
function toolPlace(tool: string): number {
  const at = TOOL_ORDER.indexOf(tool);
  return at === -1 ? TOOL_ORDER.length : at;
}

/**
 * `cards` in the order the review lists their rows (N-Conn-18): by the tool's place, then the
 * shared rules. The sort is stable, so the cards for one tool, and the shared rules, keep the
 * draft's order, and which card governs a dropped one (`rulesForTool`'s order) doesn't change.
 */
function inReviewOrder(cards: readonly RuleCard[]): RuleCard[] {
  const place = (card: RuleCard) => (isEffectCard(card) ? TOOL_ORDER.length + 1 : toolPlace(card.applies_to));
  return [...cards].sort((a, b) => place(a) - place(b));
}

/**
 * The review's rows: a row per card change (`reviewChanges` over the draft's before and after), each
 * side in words, then a `turned_on` row per tool the draft turns on, at the outcome the draft's
 * rules give it for anyone (`governingForAnyone`), else the default ask. Each group goes by
 * connector and by tool within one, shared rules last. `tools` gives each tool's effects, which say
 * which shared rules govern it; the draft's own `turnedOn` rows count too.
 */
export function changeRows(draft: RuleDraft, people: PeopleOut | null | undefined, tools: ToolEffects = []): ChangeRowView[] {
  const effects = new Map<string, readonly Effect[]>();
  for (const row of [...tools, ...draft.turnedOn]) effects.set(row.tool, row.effects);
  const effectsOf = (tool: ToolName): readonly Effect[] => effects.get(tool) ?? [];

  const changes = reviewChanges(inReviewOrder(draft.before), inReviewOrder(draft.after), effectsOf);
  const rows: ChangeRowView[] = changes.map((change): ChangeRowView => {
    const card = change.before ?? change.after;
    if (card === null) throw new Error('a review change with no card');
    const title = targetWords(card.applies_to);
    const connector = connectorFor(card);
    const moved = change.before !== null && change.after !== null && change.after.applies_to !== change.before.applies_to;
    return {
      key: card.card_id,
      change: change.change,
      title,
      ...(connector === undefined ? {} : { connector }),
      before: change.before === null ? null : cardSide(change.before, people, moved),
      after: change.after === null ? defaultSide() : cardSide(change.after, people, moved),
      changed: change.fields,
    };
  });

  for (const row of [...draft.turnedOn].sort((a, b) => toolPlace(a.tool) - toolPlace(b.tool))) {
    const title = targetWords(row.tool);
    const connector = connectorOf(row.tool)?.view;
    const governing = governingForAnyone({ tool: row.tool, effects: row.effects }, draft.after);
    rows.push({
      key: `turned-on:${row.tool}`,
      change: 'turned_on',
      title,
      ...(connector === undefined ? {} : { connector }),
      before: null,
      after: governing === undefined ? defaultSide() : cardSide(governing, people, false),
      changed: [],
    });
  }
  return rows;
}

/** The rule targets that decide whether Claude may make a payment link on its own. */
const LINK_TARGETS: ReadonlySet<string> = new Set(['native.payment_link', 'effect:charge']);

/** True when `now` differs from `was` only by a higher amount limit (no limit is higher than any). */
function onlyRaisesTheAmount(was: RuleCard, now: RuleCard): boolean {
  if ((was.max_discount_bp ?? 0) !== (now.max_discount_bp ?? 0)) return false;
  if (now.max_amount_cents == null) return true;
  return was.max_amount_cents != null && now.max_amount_cents > was.max_amount_cents;
}

/**
 * Whether the review says open payment links may be cancelled (master "Cancellation at
 * activation": the kernel cancels each open link Claude made on its own that the version being
 * activated no longer allows). Read from the draft's cards and cap, never from where it came from:
 * a lower limit; an automatic rule on payment links or on every tool that charges money that the
 * draft drops or changes in anything but its reason or a higher amount; or any card the draft adds
 * on either. A raise alone, or changes elsewhere, cancel nothing.
 */
export function cancelsLinksFor(draft: RuleDraft): boolean {
  if (draft.moneyCap !== null && draft.moneyCap.after < draft.moneyCap.before) return true;
  const owned = (cards: readonly RuleCard[]) => new Map(cards.filter((card) => card.is_default !== true).map((card) => [card.card_id, card]));
  const before = owned(draft.before);
  const after = owned(draft.after);
  for (const card of after.values()) if (LINK_TARGETS.has(card.applies_to) && !before.has(card.card_id)) return true;
  for (const was of before.values()) {
    if (was.mode !== 'auto' || !LINK_TARGETS.has(was.applies_to)) continue;
    const now = after.get(was.card_id);
    if (now === undefined) return true;
    const fields = (ruleDiff([was], [now])[0]?.fields ?? []).filter((field) => field !== 'reason');
    if (fields.length === 0) continue;
    if (fields.length === 1 && fields[0] === 'limits' && onlyRaisesTheAmount(was, now)) continue;
    return true;
  }
  return false;
}
