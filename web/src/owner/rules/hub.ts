/**
 * The Rules page's model, which the connector and tool pages reuse: the Desk's tools grouped by
 * connector, each with the outcome its rules give it (`hubSections`); the rules that govern one
 * tool (`governingRules`, `toolRuleRows`); the card an outcome menu drafts (`withOutcome`); the
 * payment limit's field (`parseLimit`); and the held request Ask Claude's suggestions ask about
 * (`holdQuestion`). It reads the rules and decides nothing: the kernel decides every request.
 */
import { MONEY_EFFECTS, type PolicyVersion, type RuleCard, type ToolName } from '../../api/contracts.ts';
import type { AnyToolName, NeedsYouItem, PeopleOut, RulesView, ToolRow } from '../../api/views.ts';
import {
  describeEffects,
  ruleWordsLine,
  rulesForTool,
  type ConnectorView,
  type RuleMode,
  type RuleRowProps,
  type ToolSummaryView,
} from '../../ds/index.ts';
import { aboveMoneyCapCopy, formatCents } from '../../lib/format.ts';
import { CONNECTORS, TOOL_NAMES, businessTools, connectorOn, isCatalogTool, toolDisplayName, toolNoun, toolState, type BusinessTools, type ConnectorKey } from '../connectors/catalog.ts';
import { heldOldestFirst } from '../useDesks.ts';
import { coveredTools, reviewedTools } from './changeRows.ts';
import type { RuleDraft } from './drafts.ts';
import { toolOutcome } from './outcome.ts';
import { ABOVE_CEILING, PAYMENT_MAX_CENTS, ruleWords, targetWords } from './ruleWords.ts';

/** The rules a tool is read against: the active version's cards. */
type ActiveCards = Pick<PolicyVersion, 'cards'>;

/** A connector's section on Rules: its look, its page, its tools and whether the payment limit leads it. */
export interface HubSection {
  connector: ConnectorView;
  /** Its page, under the Desk: `connectors/{key}`. */
  href: string;
  tools: ToolSummaryView[];
  /** The payment limit's line sits atop it: Payments and Stripe. */
  moneyLimit: boolean;
}

/** The groups that move money, so the payment limit holds over every rule in them. */
const MONEY_CONNECTORS: ReadonlySet<ConnectorKey> = new Set<ConnectorKey>(['payments', 'stripe']);

/**
 * The rules that govern a tool under the master plan's "Coverage and overlap": person- or
 * agent-scoped cards first, then the tool's own, then shared ones that decide something on it; a
 * `never` card always shows; default cards are left out. Not every card that covers it.
 */
export function governingRules(row: Pick<ToolRow, 'tool' | 'effects'>, active: ActiveCards): RuleCard[] {
  return rulesForTool({ tool: row.tool, effects: row.effects }, active.cards);
}

/** A shared rule: one on an effect group (`effect:charge`), which every tool with that effect shares. */
export const isShared = (card: Pick<RuleCard, 'applies_to'>) => card.applies_to.startsWith('effect:');

/**
 * Built-in tools whose own line already says what they change, so the hub adds only whether it can
 * be undone, or nothing, as the signed presets board words them: "Puts a visit on your calendar.
 * Can be undone."; "Sends a code to the contact on record."
 */
const LINE_SAYS_THE_EFFECT: Partial<Record<ToolName, 'undo' | 'nothing'>> = {
  'native.book': 'undo',
  'native.capture_lead': 'undo',
  'native.request_callback': 'undo',
  'native.start_verification': 'nothing',
};

/**
 * A tool's line on the hub: what it does, then its effects (`describeEffects`), from its row, so a
 * connected tool's changed definition shows what it does now. A built-in tool whose line already
 * says what it changes adds only whether it can be undone, or nothing, as the board words it.
 */
export function toolLine(row: Pick<ToolRow, 'tool' | 'effects' | 'reversible' | 'source' | 'business'>): string {
  if (!isCatalogTool(row.tool)) {
    const business = businessTools([row]);
    const description = business.get(row.tool)?.description ?? targetWords(row.tool, business);
    return `${description} ${describeEffects(row.effects, row.reversible)}`;
  }
  const { line } = TOOL_NAMES[row.tool];
  const said = row.reversible ? 'Can be undone.' : "Can't be undone.";
  switch (LINE_SAYS_THE_EFFECT[row.tool]) {
    case 'nothing':
      return line;
    case 'undo':
      return `${line} ${said}`;
    default:
      return `${line} ${describeEffects(row.effects, row.reversible)}`;
  }
}

/** Every tool the connectors list, in their order: the tools Rules shows, never the setup interview's own. */
const CONNECTOR_TOOLS: readonly ToolName[] = CONNECTORS.flatMap((connector) => connector.tools);

/** The tool rows whose names a shared rule can list: connector tools first, then known business tools. */
type NamedToolRow = Pick<ToolRow, 'tool' | 'effects' | 'source' | 'business'>;

/** Shared coverage keeps connector order, then the order of the Desk's own business tools. */
function sharedTools(tools: readonly NamedToolRow[], business: BusinessTools): NamedToolRow[] {
  const order: readonly string[] = CONNECTOR_TOOLS;
  const connected = tools.filter((row) => isCatalogTool(row.tool) && order.includes(row.tool));
  connected.sort((a, b) => order.indexOf(a.tool) - order.indexOf(b.tool));
  return [...connected, ...tools.filter((row) => business.has(row.tool))];
}

/**
 * A shared rule's line under each tool it governs (`RuleRow`'s `shared`): the app's words for its
 * group, "Applies to every tool that charges money", and the titles of the tools it covers on this
 * Desk (`coveredTools`, among the Desk's connector and business tools), "Payment link" and "Charge
 * within a signed limit", which the row shows as user text after a colon; none when it covers none.
 */
function sharedWords(card: RuleCard, cards: readonly RuleCard[], tools: readonly NamedToolRow[]): NonNullable<RuleRowProps['shared']> {
  const business = businessTools(tools);
  const group = targetWords(card.applies_to, business);
  const lower = `${group.charAt(0).toLowerCase()}${group.slice(1)}`;
  const titles = coveredTools(card, cards, sharedTools(tools, business)).map((tool) => targetWords(tool, business));
  return { lead: `Applies to ${lower}`, titles };
}

/**
 * A row per rule that governs `row` (`governingRules`), most specific first, for the connector and
 * tool pages and the house rules: its words (`ruleWords`), its limit for an automatic rule with an
 * amount, and for a shared rule the line that names its group and the tools it covers among
 * `tools` (the Desk's tool rows, required so no caller drops those names). Read-only: a page that
 * offers an outcome menu adds `onChangeOutcome`. What happens to anything else is `toolFallback`'s.
 */
export function toolRuleRows(
  row: Pick<ToolRow, 'tool' | 'effects'>,
  active: ActiveCards,
  people: PeopleOut | null | undefined,
  tools: readonly NamedToolRow[],
): RuleRowProps[] {
  return governingRules(row, active).map((card): RuleRowProps => {
    const limit = card.mode === 'auto' && card.max_amount_cents != null ? formatCents(card.max_amount_cents) : undefined;
    return {
      rule: card,
      words: ruleWords(card, people),
      ...(limit === undefined ? {} : { limit }),
      ...(isShared(card) ? { shared: sharedWords(card, active.cards, tools) } : {}),
    };
  });
}

/**
 * Whether the tool's rules end on the fallback, "anything else asks you": always, unless a `never`
 * rule for anyone governs it, which leaves nothing to ask about.
 */
export function toolFallback(row: Pick<ToolRow, 'tool' | 'effects'>, active: ActiveCards): boolean {
  return !governingRules(row, active).some((card) => card.mode === 'never' && card.who === 'anyone');
}

/** The rule moves money, so an automatic one takes a limit: it is on a tool that charges or pays out, or on every tool that does. */
function movesMoney(card: RuleCard, row: Pick<ToolRow, 'effects'>): boolean {
  if (isShared(card)) return MONEY_EFFECTS.has(card.applies_to.slice('effect:'.length));
  return row.effects.some((effect) => MONEY_EFFECTS.has(effect));
}

/**
 * The card an outcome menu drafts for `card` under `row`'s tool, valid under the `RuleCard`
 * contract, or why none can be:
 * - to "Ask me first" or "Never": the card without what only an automatic rule has (no amount
 *   limit, hours or reviewer check, and no discount);
 * - to "Allow": the card as it is, except that a rule that moves money and has no limit of its
 *   own takes the Desk's payment limit `capCents`, which the review shows before anything applies.
 *   With no limit set (0), nothing is drafted: `aboveMoneyCapCopy(0)` says to set one first.
 */
export function withOutcome(card: RuleCard, mode: RuleMode, row: Pick<ToolRow, 'effects'>, capCents: number): RuleCard | { error: string } {
  if (mode !== 'auto') return { ...card, mode, max_amount_cents: null, hours: null, max_discount_bp: 0, review: false };
  if (card.max_amount_cents != null || !movesMoney(card, row)) return { ...card, mode };
  if (capCents <= 0) return { error: aboveMoneyCapCopy(0) };
  return { ...card, mode, max_amount_cents: capCents };
}

/** A tool's row status as the hub shows it: changed asks for review, anything not on is off. */
function summaryStatus(row: Pick<ToolRow, 'status' | 'pending_sha256'>): ToolSummaryView['status'] {
  const state = toolState(row);
  if (state === 'on') return 'enabled';
  if (state === 'changed') return 'needs_review';
  return 'disabled';
}

/** Verification is always on: it can't be turned off, and its rule reads so. */
const ALWAYS_ON_TOOL: ToolName = 'native.start_verification';

/**
 * A tool's rule words on the hub: "Always on" for Confirm it's them; one rule's own words
 * ("Anyone · No discounts"); "{n} rules", then " · {k} shared" when some are shared; "No rule yet".
 */
function summaryOf(tool: AnyToolName, rules: readonly RuleCard[], people: PeopleOut | null | undefined): string {
  if (tool === ALWAYS_ON_TOOL) return 'Always on';
  const [only] = rules;
  if (only === undefined) return 'No rule yet';
  if (rules.length === 1) return ruleWordsLine(ruleWords(only, people));
  const shared = rules.filter(isShared).length;
  return shared > 0 ? `${rules.length} rules · ${shared} shared` : `${rules.length} rules`;
}

/** A tool on the hub: its words, its rules' words, its outcome (`toolOutcome`: the most that runs on its own for some visitor) and its page. */
function toolSummary(row: ToolRow, key: ConnectorKey, active: ActiveCards, people: PeopleOut | null | undefined): ToolSummaryView {
  const rules = governingRules(row, active);
  const { mode, limitCents } = toolOutcome(row, active.cards);
  const limit = mode === 'auto' && limitCents !== null ? formatCents(limitCents) : undefined;
  return {
    key: row.tool,
    name: toolDisplayName(row.tool, businessTools([row])) ?? 'A connected tool',
    description: toolLine(row),
    summary: summaryOf(row.tool, rules, people),
    mode,
    ...(limit === undefined ? {} : { limit }),
    status: summaryStatus(row),
    href: `connectors/${key}/${encodeURIComponent(row.tool)}`,
  };
}

/**
 * The Rules page's sections: one per connector that is on (`connectorOn`), in the catalog's order,
 * never Google Calendar or the setup interview's own tools. Each lists the tools of that connector
 * the Desk has, with their outcome, and names the connector's page under Connectors, which the
 * screens link to once it's built (`connectorPageHref`); the
 * payment limit leads Payments and Stripe. A connector turned off leaves the list and comes back
 * through the picker.
 */
export function hubSections(view: RulesView, people: PeopleOut | null | undefined): HubSection[] {
  return CONNECTORS.flatMap((connector): HubSection[] => {
    if (connector.tools.length === 0 || !connectorOn(connector, view.tools)) return [];
    const rows = connector.tools.flatMap((tool) => view.tools.filter((row) => row.tool === tool).slice(0, 1));
    return [
      {
        connector: connector.view,
        href: `connectors/${connector.key}`,
        tools: rows.map((row) => toolSummary(row, connector.key, view.active, people)),
        moneyLimit: MONEY_CONNECTORS.has(connector.key),
      },
    ];
  });
}

/** The rows on Rules a confirmed change changed: its tools' rows, and the payment limit's line. */
export interface ChangedRows {
  /** The tools whose rules the change changed, or which it turned on, in the order of `tools`. */
  tools: AnyToolName[];
  /** It changed the payment limit, whose line leads Payments and Stripe. */
  moneyLimit: boolean;
}

/**
 * The rows on Rules that a confirmed `draft` changed, read from the draft's own cards, never from
 * the words on the page: the tools its review's rows are about (`reviewedTools`, from the same
 * pairing the review lists its rows by), so the rows that land are exactly the ones the review
 * listed, each tool it turns on, and the payment limit when the draft changes it. A rule the draft
 * replaces with one that differs only in its id changes no row.
 */
export function rowsChangedBy(draft: RuleDraft, tools: readonly Pick<ToolRow, 'tool' | 'effects' | 'source' | 'business'>[]): ChangedRows {
  return { tools: reviewedTools(draft, tools), moneyLimit: draft.moneyCap !== null };
}

/** The payment limit's field, when it holds anything but whole dollars. */
const WHOLE_DOLLARS = 'Enter whole dollars, from 0 to 10,000.';

/**
 * The payment limit as the owner typed it: whole dollars only, from 0 to 10,000 (the per-payment
 * limit, `PAYMENT_MAX_CENTS`, is also the ceiling no limit goes above), in cents; else what to fix.
 */
export function parseLimit(text: string): { cents: number } | { error: string } {
  const typed = text.trim();
  if (!/^\d+$/.test(typed)) return { error: WHOLE_DOLLARS };
  // Leading zeros say nothing; more digits than the ceiling has are above it, however many.
  const digits = typed.replace(/^0+(?=\d)/, '');
  const cents = digits.length > 9 ? Number.POSITIVE_INFINITY : Number(digits) * 100;
  return cents > PAYMENT_MAX_CENTS ? { error: ABOVE_CEILING } : { cents };
}

/**
 * Ask Claude's suggestion about the Desk's latest hold, in the owner's words: "Why was this refund
 * held?", for the newest request in Needs you's `items` whose tool has a plain noun (`toolNoun`).
 * A hold whose tool has none is left out; with no hold left, there is no question (null).
 */
export function holdQuestion(items: readonly NeedsYouItem[]): string | null {
  for (const item of heldOldestFirst(items).reverse()) {
    const noun = item.decision.action ? toolNoun(item.decision.action.tool) : null;
    if (noun !== null) return `Why was this ${noun} held?`;
  }
  return null;
}
