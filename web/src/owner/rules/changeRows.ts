/**
 * The rows a rules review shows (`ChangeReview`), from a draft alone: the design system's
 * `reviewChanges` pairs the cards, the one algorithm every review's rows follow, and this gives
 * each side its words. It decides no outcome the draft doesn't enforce.
 */
import type { Effect, RuleCard } from '../../api/contracts.ts';
import type { AnyToolName, PeopleOut, ToolRow } from '../../api/views.ts';
import {
  reviewChanges,
  ruleDiff,
  rulesForTool,
  type ChangeRowView,
  type ChangeSide,
  type ConnectorView,
  type ReviewChange,
  type RulesTool,
  type RuleTarget,
  type ToolTitles,
} from '../../ds/index.ts';
import { formatCents } from '../../lib/format.ts';
import { CONNECTORS, TOOL_NAMES, businessTools, connectorByKey, connectorOf, isCatalogTool, type BusinessTools } from '../connectors/catalog.ts';
import type { RuleDraft } from './drafts.ts';
import { toolOutcome } from './outcome.ts';
import { ruleWords, targetWords } from './ruleWords.ts';
import { ruleMeta, ruleSentence, type SentenceWords } from './ruleSentence.ts';

/** What applies where no rule the owner set covers a request: the compiler's default ask. */
export const DEFAULT_SIDE = {
  mode: 'ask',
  reason: 'Not covered by a rule you set, so I ask you.',
  words: [{ field: 'who', text: 'Anyone' }],
} as const satisfies ChangeSide;

/** The tools a rules review knows the effects of, by name. */
type ToolEffects = readonly Pick<ToolRow, 'tool' | 'effects' | 'source' | 'business'>[];

/** The connector a tool card's tool belongs to; none for a tool the catalog doesn't know. */
function connectorFor(card: RuleCard): ConnectorView | undefined {
  return isCatalogTool(card.applies_to) ? connectorOf(card.applies_to)?.view : undefined;
}

/**
 * A card on one side of a row: its shared sentence and tools · who meta, plus the legacy outcome,
 * limit, reason, words and `appliesTo` for consumers that still use the field review.
 * `appliesTo` names what it applies to, only when the row's target moves (a card retargeted, one that goes to a rule
 * for a whole effect group, or a shared rule that covers other tools than it did), so the widened
 * or narrowed target shows. Otherwise the row's title names the target and the sides don't repeat
 * it (N-Conn-18).
 */
function cardSide(card: RuleCard, words: SentenceWords, appliesTo: RuleTarget | undefined): ChangeSide {
  const amount = card.mode === 'auto' && card.max_amount_cents != null ? formatCents(card.max_amount_cents) : undefined;
  return {
    ...(appliesTo === undefined ? {} : { appliesTo }),
    mode: card.mode,
    ...(amount === undefined ? {} : { limit: amount }),
    reason: card.reason,
    words: ruleWords(card, words.people),
    sentence: { parts: ruleSentence(card, words), meta: ruleMeta(card, words) },
  };
}

/** The default ask, which is for the row's own tool, so it names no target. */
function defaultSide(tool: string, words: SentenceWords): ChangeSide {
  const card: RuleCard = { card_id: 'default-ask', applies_to: tool, mode: 'ask', who: 'anyone', reason: DEFAULT_SIDE.reason };
  return { ...DEFAULT_SIDE, words: [...DEFAULT_SIDE.words], sentence: { parts: ruleSentence(card, words), meta: ruleMeta(card, words) } };
}

/** A card shared by every tool with that effect (`effect:charge`), which a tool's own card outranks. */
const isEffectCard = (card: Pick<RuleCard, 'applies_to'>) => card.applies_to.startsWith('effect:');

/**
 * What a card applies to as a review shows it (`targetWords`): a tool by its title, which the
 * review shows as user text, or a group's words ("Every tool that charges money"), the app's own.
 */
function targetOf(appliesTo: string, business: BusinessTools): RuleTarget {
  return isEffectCard({ applies_to: appliesTo }) ? targetWords(appliesTo, business) : { titles: [targetWords(appliesTo, business)] };
}

/** Every tool in the order the Connectors page lists them, then the setup interview's own. */
const TOOL_ORDER: readonly string[] = [...new Set<string>([...CONNECTORS.flatMap((connector) => connector.tools), ...Object.keys(TOOL_NAMES)])];

/** Where a tool's rows go: by connector, by tool within one, then any tool the catalog doesn't know. */
function toolPlace(tool: string): number {
  const at = TOOL_ORDER.indexOf(tool);
  return at === -1 ? TOOL_ORDER.length : at;
}

/** A row's card as the review lists it: its title, its connector, and its place among the rows. */
interface RowLabel {
  title: RuleTarget;
  connector?: ConnectorView;
  place: number;
}

/** After every tool's rows: a shared rule whose tools span connectors, or that covers none of this Desk's. */
const LAST_PLACE = TOOL_ORDER.length + 1;

/**
 * The tools of `catalog`, in its order, that the shared rule `card` covers among the shared rules
 * of `cards`. The design system's `rulesForTool` over those shared rules alone lists exactly the
 * shared rules that cover a tool (master "Coverage and overlap"): every tool with the rule's
 * effect, and for an automatic rule on a tool with several effects, only jointly with an automatic
 * rule for each of the others. A tool's own rules don't take a shared rule's tools away from it.
 * A review passes one side of its draft and the Desk's whole catalog in review order; Rules, the
 * active rules and the Desk's tools on its connectors, in the connectors' order.
 */
export function coveredTools(card: RuleCard, cards: readonly RuleCard[], catalog: readonly RulesTool[]): AnyToolName[] {
  const shared = cards.filter(isEffectCard);
  return catalog.filter((tool) => rulesForTool(tool, shared).some((rule) => rule.card_id === card.card_id)).map((tool) => tool.tool);
}

/**
 * How a card's row reads and where it goes (N-Conn-18). A tool's card: the tool's name and its
 * connector, at the tool's place. A shared rule (`effect:charge`): the tools it covers in this
 * Desk's catalog, joined ("Payment link and Charge within a signed limit"); with their connector
 * when they share one, right after the rows of the first tool it covers, as the board draws it;
 * else no connector, last. Covering none of this Desk's tools, it keeps its group's words
 * ("Every tool that charges money"), last.
 */
function rowLabel(card: RuleCard, side: readonly RuleCard[], catalog: readonly RulesTool[], business: BusinessTools): RowLabel {
  if (!isEffectCard(card)) {
    const connector = connectorFor(card);
    return { title: targetOf(card.applies_to, business), ...(connector === undefined ? {} : { connector }), place: toolPlace(card.applies_to) };
  }
  return coveredLabel(coveredTools(card, side, catalog), business) ?? { title: targetOf(card.applies_to, business), place: LAST_PLACE };
}

/**
 * How a shared rule's row reads by the tools it covers, `covered`, in review order: their names
 * joined; with their connector when they share one, right after the rows of the first of them;
 * else no connector, last. None when it covers no tool.
 */
function coveredLabel(covered: readonly AnyToolName[], business: BusinessTools): RowLabel | undefined {
  const [first] = covered;
  if (first === undefined) return undefined;
  const title = coveredWords(covered, business);
  const connectors = new Set(covered.map((tool) => (isCatalogTool(tool) ? connectorOf(tool)?.key : null) ?? null));
  const [only] = connectors;
  const connector = connectors.size === 1 && only != null ? connectorByKey(only)?.view : undefined;
  return connector === undefined ? { title, place: LAST_PLACE } : { title, connector, place: toolPlace(first) + 0.5 };
}

/** The titles of the tools a shared rule covers, which the review joins ("Share a document, See charges and Refund"). */
function coveredWords(covered: readonly AnyToolName[], business: BusinessTools): ToolTitles {
  return { titles: covered.map((tool) => targetWords(tool, business)) };
}

/** What a side covers: its tools' titles, or its group's words when it covers none of this Desk's. */
function sideCoverage(card: RuleCard, covered: readonly AnyToolName[], business: BusinessTools): RuleTarget {
  return covered.length > 0 ? coveredWords(covered, business) : targetOf(card.applies_to, business);
}

/** A row that moves in the tools it covers: its label, and what each side covers. */
interface CoverageMove {
  label: RowLabel;
  before: RuleTarget;
  after: RuleTarget;
}

/**
 * A row whose two sides are shared rules that cover different tools of this Desk's `catalog`, each
 * among its own side of `draft`. Coverage follows a rule's outcome and the shared rules beside it,
 * so a rule changed in place can cover other tools: made "Never" from automatic, a rule on private
 * data covers every tool that touches it, not only those it covered jointly. Such a row reads by
 * every tool either side covers, in review order, and each side names its own. None when either
 * side isn't a shared rule, or both cover the same tools.
 */
function coverageMove(before: RuleCard, after: RuleCard, draft: RuleDraft, catalog: readonly RulesTool[], business: BusinessTools): CoverageMove | undefined {
  if (!isEffectCard(before) || !isEffectCard(after)) return undefined;
  const was = coveredTools(before, draft.before, catalog);
  const now = coveredTools(after, draft.after, catalog);
  if (was.length === now.length && was.every((tool, index) => now[index] === tool)) return undefined;
  const label = coveredLabel(catalog.map((tool) => tool.tool).filter((tool) => was.includes(tool) || now.includes(tool)), business);
  if (label === undefined) return undefined;
  return { label, before: sideCoverage(before, was, business), after: sideCoverage(after, now, business) };
}

/** `items` by `place`, a stable sort, so items at one place keep their order. */
function byPlace<T>(items: readonly T[], place: (item: T) => number): T[] {
  return [...items].sort((a, b) => place(a) - place(b));
}

/** A review's cards paired (`reviewChanges`), with the Desk's catalog in review order that its rows read by. */
interface Pairing {
  business: BusinessTools;
  catalog: RulesTool[];
  changes: ReviewChange[];
}

/**
 * Pairs the draft's cards as every review does (`reviewChanges` over its before and after), with
 * `tools`, this Desk's catalog, and the draft's own `turnedOn` rows giving each tool's effects. The
 * draft's cards go as the draft has them, so neither which card governs a dropped one
 * (`rulesForTool`'s order) nor the pairing depends on the review's order.
 */
function pairCards(draft: RuleDraft, tools: ToolEffects): Pairing {
  const business = businessTools([...tools, ...draft.turnedOn]);
  const effects = new Map<AnyToolName, readonly Effect[]>();
  for (const row of [...tools, ...draft.turnedOn]) effects.set(row.tool, row.effects);
  const effectsOf = (tool: AnyToolName): readonly Effect[] => effects.get(tool) ?? [];
  const catalog = byPlace(
    [...effects].map(([tool, toolEffects]): RulesTool => ({ tool, effects: toolEffects })),
    (tool) => toolPlace(tool.tool),
  );
  return { business, catalog, changes: reviewChanges(draft.before, draft.after, effectsOf) };
}

/**
 * The tools a review's rows are about, from the same pairing its rows come from (`pairCards`), so
 * Rules lands a confirmed change on exactly the rows its review listed: for each row, the tool each
 * side's rule is for, or for a shared rule the tools it covers on its side of the draft (its
 * title's tools, and the target a side names when the rule moves); then each tool the draft turns
 * on. A card the draft replaces with one that differs only in its id has no row, so its tool is
 * not among them. In the order of `tools`, then the turned-on tools; only tools among them.
 */
export function reviewedTools(draft: RuleDraft, tools: ToolEffects): AnyToolName[] {
  const { catalog, changes } = pairCards(draft, tools);
  const named = new Set<AnyToolName>(draft.turnedOn.map((row) => row.tool));
  const sideTools = (card: RuleCard | null, side: readonly RuleCard[]): AnyToolName[] => {
    if (card === null) return [];
    return isEffectCard(card) ? coveredTools(card, side, catalog) : [card.applies_to as AnyToolName];
  };
  for (const { before, after } of changes) {
    for (const tool of [...sideTools(before, draft.before), ...sideTools(after, draft.after)]) named.add(tool);
  }
  return [...new Set([...tools, ...draft.turnedOn].map((row) => row.tool))].filter((tool) => named.has(tool));
}

/**
 * The review's rows: a row per card change (`reviewChanges` over the draft's before and after), each
 * side in shared sentence wording (a removed rule has Before alone), then a `turned_on` row per
 * tool the draft turns on, at the outcome Rules shows
 * for the draft's rules (`toolOutcome`: the most that runs on its own for some visitor), in the
 * words of the rule that gives it, else the default ask. Every card's row goes by connector and by
 * tool within one, in one stable pass, so an added rule follows the changed rows of its own tool: a
 * shared rule is placed by `rowLabel`, or, when it covers other tools after than before, by every
 * tool either side covers (`coverageMove`).
 * `tools` is this Desk's catalog: each tool's effects, which say which shared rules cover and
 * govern it; the draft's own `turnedOn` rows count too.
 */
export function changeRows(draft: RuleDraft, people: PeopleOut | null | undefined, tools: ToolEffects = []): ChangeRowView[] {
  const { business, catalog, changes } = pairCards(draft, tools);
  const sentenceTools = catalog.map((tool) => ({ ...tool, effects: [...tool.effects] }));
  // Shared auto rules cover a tool with several effects only jointly. Give the foundation each
  // side's actual coverage, so its meta names exactly those tools, once.
  const wordsFor = (card: RuleCard, side: readonly RuleCard[]): SentenceWords => {
    const covered = isEffectCard(card) ? new Set(coveredTools(card, side, catalog)) : null;
    return { business, people, tools: covered === null ? sentenceTools : sentenceTools.filter((tool) => covered.has(tool.tool)) };
  };
  // Each side's labels, read once: a shared rule's coverage depends on the other shared rules beside it.
  const labelsOf = (side: readonly RuleCard[]) => new Map(side.map((card) => [card, rowLabel(card, side, catalog, business)]));
  const beforeLabels = labelsOf(draft.before);
  const afterLabels = labelsOf(draft.after);
  const labelOf = (card: RuleCard, labels: ReadonlyMap<RuleCard, RowLabel>) => labels.get(card) ?? rowLabel(card, [card], catalog, business);

  // Only the rows the pairing returns are sorted.
  const placed = changes.map((change) => {
    const { before, after } = change;
    const card = before ?? after;
    if (card === null) throw new Error('a review change with no card');
    // A row reads by its card's side, the after side for an added rule; a shared rule that covers
    // other tools after reads by every tool either side covers.
    const move = before !== null && after !== null ? coverageMove(before, after, draft, catalog, business) : undefined;
    const { title, connector, place } = move?.label ?? labelOf(card, before === null ? afterLabels : beforeLabels);
    const retargeted = before !== null && after !== null && after.applies_to !== before.applies_to;
    const target = (side: RuleCard, covered: RuleTarget | undefined) => covered ?? (retargeted ? targetOf(side.applies_to, business) : undefined);
    // A rule on a group of tools on every side it has (dropped, changed, added, or replaced by
    // another group's rule) is a shared rule, and its row says so: "Payments · Shared rule". A rule
    // that moves between one tool and a group leaves it unset, since its sides' `appliesTo` show
    // the move. A row that moves, in its target or in the tools it covers, shows the move in
    // `appliesTo`, the after side's target tagged as changed.
    const shared = (before === null || isEffectCard(before)) && (after === null || isEffectCard(after));
    const row: ChangeRowView = {
      key: card.card_id,
      change: after === null ? 'removed' : change.change,
      title,
      ...(connector === undefined ? {} : { connector }),
      ...(shared ? { shared: true } : {}),
      before: before === null ? null : cardSide(before, wordsFor(before, draft.before), target(before, move?.before)),
      after: after === null ? null : cardSide(after, wordsFor(after, draft.after), target(after, move?.after)),
      changed: move === undefined || change.fields.includes('applies_to') ? change.fields : ['applies_to', ...change.fields],
    };
    return { row, place };
  });
  // One stable pass by place: rows at one place keep the pairing's order, so an added rule follows
  // the changed rows of its own tool, and changes to one tool read together.
  const rows: ChangeRowView[] = byPlace(placed, ({ place }) => place).map(({ row }) => row);

  for (const row of [...draft.turnedOn].sort((a, b) => toolPlace(a.tool) - toolPlace(b.tool))) {
    const title = targetOf(row.tool, business);
    const connector = isCatalogTool(row.tool) ? connectorOf(row.tool)?.view : undefined;
    const { rule } = toolOutcome({ tool: row.tool, effects: row.effects }, draft.after);
    rows.push({
      key: `turned-on:${row.tool}`,
      change: 'turned_on',
      title,
      ...(connector === undefined ? {} : { connector }),
      before: null,
      // The governing rule may be shared, but this row activates only this tool.
      after: rule === undefined ? defaultSide(row.tool, { business, people, tools: [row] }) : cardSide(rule, { business, people, tools: [row] }, undefined),
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
