/**
 * The rows a rules review shows (`ChangeReview`), from a draft alone: the design system's
 * `reviewChanges` pairs the cards, the one algorithm every review's rows follow, and this gives
 * each side its words. It decides no outcome the draft doesn't enforce.
 */
import type { Effect, RuleCard, ToolName } from '../../api/contracts.ts';
import type { PeopleOut, ToolRow } from '../../api/views.ts';
import { reviewChanges, ruleDiff, rulesForTool, type ChangeRowView, type ChangeSide } from '../../ds/index.ts';
import { formatCents } from '../../lib/format.ts';
import { connectorOf } from '../connectors/catalog.ts';
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

/** A card on one side of a row: what it applies to, its outcome and limit, its reason and its words. */
function cardSide(card: RuleCard, people: PeopleOut | null | undefined): ChangeSide {
  const amount = card.mode === 'auto' && card.max_amount_cents != null ? formatCents(card.max_amount_cents) : undefined;
  return {
    appliesTo: targetWords(card.applies_to),
    mode: card.mode,
    ...(amount === undefined ? {} : { limit: amount }),
    reason: card.reason,
    words: ruleWords(card, people),
  };
}

/** The default ask for what `appliesTo` names. */
function defaultSide(appliesTo: string): ChangeSide {
  return { ...DEFAULT_SIDE, appliesTo, words: [...DEFAULT_SIDE.words] };
}

/**
 * The review's rows: a row per card change (`reviewChanges` over the draft's before and after), each
 * side in words, then a `turned_on` row per tool the draft turns on, at the outcome of the rule that
 * governs it for anyone, else the default ask. `tools` gives each tool's effects, which say which
 * shared rules govern it; the draft's own `turnedOn` rows count too.
 */
export function changeRows(draft: RuleDraft, people: PeopleOut | null | undefined, tools: ToolEffects = []): ChangeRowView[] {
  const effects = new Map<string, readonly Effect[]>();
  for (const row of [...tools, ...draft.turnedOn]) effects.set(row.tool, row.effects);
  const effectsOf = (tool: ToolName): readonly Effect[] => effects.get(tool) ?? [];

  const rows: ChangeRowView[] = reviewChanges(draft.before, draft.after, effectsOf).map((change): ChangeRowView => {
    const card = change.before ?? change.after;
    if (card === null) throw new Error('a review change with no card');
    const title = targetWords(card.applies_to);
    const connector = connectorFor(card);
    return {
      key: card.card_id,
      change: change.change,
      title,
      ...(connector === undefined ? {} : { connector }),
      before: change.before === null ? null : cardSide(change.before, people),
      after: change.after === null ? defaultSide(title) : cardSide(change.after, people),
      changed: change.fields,
    };
  });

  for (const row of draft.turnedOn) {
    const title = targetWords(row.tool);
    const connector = connectorOf(row.tool)?.view;
    // The rule that decides for anyone, at any time: the most specific such card governing the tool.
    const governing = rulesForTool({ tool: row.tool, effects: row.effects }, draft.after).find(
      (card) => card.who === 'anyone' && card.hours == null,
    );
    rows.push({
      key: `turned-on:${row.tool}`,
      change: 'turned_on',
      title,
      ...(connector === undefined ? {} : { connector }),
      before: null,
      after: governing === undefined ? defaultSide(title) : cardSide(governing, people),
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
