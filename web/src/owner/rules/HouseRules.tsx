import { useId, type ReactNode } from 'react';

import { MONEY_EFFECTS, type RuleCard } from '../../api/contracts.ts';
import type { PeopleOut, PolicyVersionOut, RulesView, ToolRow } from '../../api/views.ts';
import {
  Card,
  ConnectorIcon,
  ConnectorName,
  DetailsSlot,
  Icon,
  LandedGlow,
  OUTCOME_TONE,
  RuleSentence,
  StatusDot,
  StatusLabel,
  ToolTitleList,
  UpdatedPill,
  type ConnectorView,
  type SentencePart,
  type StatusTone,
} from '../../ds/index.ts';
import { listWords } from '../../lib/format.ts';
import { connectorPageHref } from '../connectors/pages.ts';
import { BUSINESS_WORDS, businessOwnerLine, businessRulesDescription } from '../connectors/businessWords.ts';
import { businessTools, isBusinessToolName, isCatalogTool, TOOL_NAMES, toolDisplayName, toolState } from '../connectors/catalog.ts';
import { RouterLink } from '../OwnerLayout.tsx';
import { JOBS_LINE } from './copy.ts';
import { RuleDetails, ToolDetails } from './details.tsx';
import { governingRules, hubSections } from './hub.ts';
import { ALWAYS_ON_SENTENCES, ruleQualifiers, ruleSentence, type AlwaysOnSentence, type SentenceWords } from './ruleSentence.ts';

import './HouseRules.css';

/**
 * Where the owner's confirmed changes have landed on Rules since they opened it, each by its
 * landing's id: the cards a change changed, by id; the tools it turned on, every rule on them; the
 * tools its review listed, whose default ask lands once no rule of theirs is left; a removed rule's
 * default, "Anything not listed here"; and the payment limit.
 */
export interface LandedRules {
  cards: ReadonlyMap<string, number>;
  tools: ReadonlyMap<string, number>;
  reviewed: ReadonlyMap<string, number>;
  fallback: number | null;
  limit: number | null;
}

export const NOTHING_LANDED: LandedRules = { cards: new Map(), tools: new Map(), reviewed: new Map(), fallback: null, limit: null };

/** The latest of the landings given, or none. */
function latest(...landings: (number | null | undefined)[]): number | undefined {
  return landings.reduce<number | undefined>((at, landing) => (landing == null ? at : Math.max(at ?? 0, landing)), undefined);
}

/** What a rule row shows at its end: a status dot in its tone, or, for an always-on rule, its lock and "Always on". */
export type RuleStatus = StatusTone | 'always-on';

/** What a rule row's Details reads: the active version, the row's cards (none for a sentence from no card), or the payment limit. */
export interface RuleRowDetails {
  version: PolicyVersionOut;
  cards: readonly RuleCard[];
  moneyCap?: boolean;
}

/**
 * One rule's row wherever Rules lists one, so a restyle is one change (REV-RULES-D, A): its
 * sentence in primary text, its value at 520; the line under it, who it is for and its qualifiers,
 * never the tools; for a shared rule "Shared rule. Also applies to:" and the other tools; then
 * `below` (the payment limit's field). At its end: "Updated" once a change lands on it, its own
 * control (the payment limit's "Change"), its status dot, then Details, or Details' empty place for
 * a row without it, so every dot sits in one column. An always-on rule ends with its lock and
 * "Always on" instead, flush right where Details ends, with no dot and no Details.
 */
export function ToolRule({ parts, line, status, shared, repeated, card, landed, actions, below, details, data }: {
  parts: readonly SentencePart[]; line?: string; status: RuleStatus; shared?: readonly string[]; repeated?: boolean;
  card?: RuleCard; landed?: number; actions?: ReactNode; below?: ReactNode; details?: RuleRowDetails;
  data?: Record<`data-${string}`, string | true>;
}) {
  const textId = useId();
  const row = (toggle: ReactNode) => (
    <div className="cd-house-rules__rule-row">
      <div className="cd-house-rules__rule-text" id={textId}>
        <RuleSentence parts={repeated ? [...parts, { text: ' · Shared rule, as above' }] : parts} />
        {line === undefined || line === '' ? null : <p className="cd-house-rules__rule-line cd-type-meta">{line}</p>}
        {shared === undefined || shared.length === 0 || repeated ? null : (
          <p className="cd-house-rules__shared cd-type-meta">Shared rule. Also applies to:<br /><ToolTitleList titles={shared} /></p>
        )}
        {below}
      </div>
      <span className="cd-house-rules__rule-actions">
        {landed === undefined ? null : <UpdatedPill key={`updated-${landed}`} />}
        {actions}
        {status === 'always-on' ? (
          <span className="cd-house-rules__always-on cd-type-meta">
            <Icon name="lock" size={14} />
            Always on
          </span>
        ) : (
          <>
            <StatusDot tone={status} />
            {toggle ?? <DetailsSlot />}
          </>
        )}
      </span>
    </div>
  );
  return (
    <li
      className={`cd-house-rules__rule${repeated ? ' cd-house-rules__rule--reference cd-type-meta' : ''}`}
      data-rule-id={card?.card_id}
      data-landed={landed}
      {...data}
    >
      {/* The fill it lights up in, behind its words: drawn again for each change that lands on it. */}
      {landed === undefined ? null : <LandedGlow key={`glow-${landed}`} />}
      {details === undefined || status === 'always-on' ? row(null) : (
        <RuleDetails version={details.version} cards={details.cards} moneyCap={details.moneyCap ?? false} describedBy={textId}>
          {(toggle) => row(toggle)}
        </RuleDetails>
      )}
    </li>
  );
}

/** An always-on rule as a row: its sentence, its line, and its lock. */
export function AlwaysOnRule({ parts, line }: { parts: readonly SentencePart[]; line?: string }) {
  return <ToolRule parts={parts} status="always-on" {...(line === undefined ? {} : { line })} />;
}

/** The always-on rules that sit with their tools, by tool: codes with Confirm it's them, private data with what shares it. */
const ALWAYS_ON_BY_TOOL: Readonly<Record<string, AlwaysOnSentence['key']>> = {
  'native.start_verification': 'codes',
  'native.release_document': 'private_data',
  'payments.list_charges': 'private_data',
};

const alwaysOn = (key: AlwaysOnSentence['key']) => ALWAYS_ON_SENTENCES.find((rule) => rule.key === key);

/** "Claude never moves money without your rule or a signed limit", over the money band's tools. */
export function NeverMovesMoney({ titles }: { titles: readonly string[] }) {
  const rule = alwaysOn('money');
  return rule === undefined ? null : <AlwaysOnRule parts={rule.parts} line={listWords(titles)} />;
}

/**
 * Why a tool's rules don't run now, by its title, or null while it's on: its definition changed and
 * waits for the owner's review, or it's off. Its rules' dots take this tone, not their outcome's,
 * so none says it runs while the tool can't.
 */
function toolStatus(row: ToolRow): { tone: StatusTone; words: string } | null {
  const state = toolState(row);
  if (state === 'on') return null;
  return state === 'changed' ? { tone: 'held', words: 'Needs your review' } : { tone: 'info', words: 'Turned off' };
}

/**
 * A tool: its title, an h3, and why it can't run when it can't; its line; then its Details
 * (REV-RULES-D), whose panel opens between the tool and its rules. Its effects show only there.
 */
function ToolHeader({ row, title, href, description, connector, status }: {
  row: ToolRow; title: string; href: string | undefined; description: string; connector: ConnectorView | null;
  status: { tone: StatusTone; words: string } | null;
}) {
  const titleId = useId();
  return (
    <ToolDetails row={row} connector={connector} describedBy={titleId}>
      {(toggle) => (
        <div className="cd-house-rules__tool-header">
          <div className="cd-house-rules__tool-text">
            <div className="cd-house-rules__tool-title">
              <h3 className="cd-house-rules__tool-heading cd-type-section">
                {href === undefined ? <span id={titleId} className="cd-house-rules__tool-name cd-user-name" data-copy="user">{title}</span>
                  : <RouterLink className="cd-house-rules__tool-name cd-user-name" data-copy="user" href={href}><span id={titleId}>{title}</span></RouterLink>}
              </h3>
              {status === null ? null : (
                <span className="cd-house-rules__tool-status cd-type-meta"><StatusLabel tone={status.tone}>{status.words}</StatusLabel></span>
              )}
            </div>
            {description === '' ? null : <p className="cd-house-rules__tool-description cd-type-meta">{description}</p>}
          </div>
          {toggle}
        </div>
      )}
    </ToolDetails>
  );
}

/** A card on Rules: its key, its name, and the Desk's tools it brings. */
export interface ToolGroup {
  key: string;
  name: string;
  tools: readonly ToolRow[];
}

/** The titles of a card's tools that move money, as its money band names them. */
export function moneyTitles(group: ToolGroup, view: Pick<RulesView, 'tools'>): string[] {
  const business = businessTools(view.tools);
  return group.tools
    .filter((row) => row.effects.some((effect) => MONEY_EFFECTS.has(effect)))
    .map((row) => toolDisplayName(row.tool, business) ?? 'A connected tool');
}

/** One rule under a tool, as Rules draws it. */
export interface ToolRuleEntry {
  card: RuleCard;
  parts: SentencePart[];
  line: string;
  status: StatusTone;
  /** The other tools a shared rule covers; `repeated` once it was expanded under an earlier tool. */
  shared?: string[];
  repeated?: boolean;
}

/** One tool on Rules: its row, title and line, why it can't run when it can't, its rules, and the always-on rule that sits with it. */
export interface ToolEntry {
  row: ToolRow;
  title: string;
  description: string;
  status: { tone: StatusTone; words: string } | null;
  /** Whether a card of the owner's covers it; without one it asks by default, from no card. */
  covered: boolean;
  rules: ToolRuleEntry[];
  always?: AlwaysOnSentence;
}

/** One card on Rules: the Desk's own jobs (no connector) or a connector, with its line, whether a money band leads it, and its tools. */
export interface ToolGroupEntry extends ToolGroup {
  connector: ConnectorView | null;
  line: string;
  money: boolean;
  entries: ToolEntry[];
}

/**
 * Rules' tools, tool by tool, as words: the Desk's own jobs, then one card per connector that is on
 * (`hubSections`), each tool with the rules that cover it (`governingRules`) in its sentences and
 * cell lines, in one order, so each shared rule is expanded exactly once across connectors. The
 * page and its loading shapes both draw from it.
 */
export function toolGroups(view: RulesView, people: PeopleOut | null): ToolGroupEntry[] {
  const business = businessTools(view.tools);
  const words: SentenceWords = { business, people, tools: view.tools };
  const jobs = view.tools.filter((row) => row.source === 'business' && isBusinessToolName(row.tool)
    && Array.isArray(row.effects) && row.effects.every((effect) => ['read', 'private_data', 'change', 'charge', 'pay_out', 'send_message'].includes(effect))
    && ['on', 'changed'].includes(toolState(row)));
  const groups = [
    ...(jobs.length === 0 ? [] : [{ key: 'jobs', name: BUSINESS_WORDS.jobs, connector: null, line: JOBS_LINE, money: false, tools: jobs }]),
    ...hubSections(view, people).map((section) => ({
      key: section.connector.id, name: section.connector.name, connector: section.connector,
      line: section.connector.description, money: section.moneyLimit,
      tools: section.tools.flatMap((tool) => view.tools.filter((row) => row.tool === tool.key).slice(0, 1)),
    })),
  ];
  const tools = groups.flatMap((group) => group.tools);
  const cards = new Map(tools.map((row) => [row.tool, governingRules(row, view.active)]));
  const sharedCoverage = new Map<string, ToolRow[]>();
  for (const row of tools) {
    for (const card of cards.get(row.tool) ?? []) {
      if (!card.applies_to.startsWith('effect:') && !row.cards?.some((cover) => cover.card_id === card.card_id && cover.shared)) continue;
      sharedCoverage.set(card.card_id, [...(sharedCoverage.get(card.card_id) ?? []), row]);
    }
  }
  const otherTitles = (rows: readonly ToolRow[], row: ToolRow) => rows.filter((other) => other.tool !== row.tool)
    .map((other) => toolDisplayName(other.tool, business) ?? 'A connected tool');

  return groups.map((group) => ({
    ...group,
    entries: group.tools.map((row): ToolEntry => {
      const status = toolStatus(row);
      const covering = cards.get(row.tool) ?? [];
      // No card covers the tool, so it asks by default: a sentence drawn from no card.
      const displayed: RuleCard[] = covering.length === 0 ? [{
        card_id: `default:${row.tool}`, applies_to: row.tool, mode: 'ask', who: 'anyone',
        person_id: null, agent_key_id: null, max_amount_cents: null, max_discount_bp: 0,
        hours: null, review: false, is_default: true, reason: '',
      }] : covering;
      const always = ALWAYS_ON_BY_TOOL[row.tool];
      const alwaysRule = always === undefined ? undefined : alwaysOn(always);
      return {
        row,
        title: toolDisplayName(row.tool, business) ?? 'A connected tool',
        description: row.source === 'business'
          ? businessRulesDescription(row.business) ?? businessOwnerLine(row.business?.config) ?? ''
          : isCatalogTool(row.tool) ? TOOL_NAMES[row.tool].line : '',
        status,
        covered: covering.length > 0,
        rules: displayed.map((card): ToolRuleEntry => {
          const shared = sharedCoverage.get(card.card_id);
          return {
            card,
            parts: ruleSentence(card, words),
            line: ruleQualifiers(card, words),
            status: status?.tone ?? OUTCOME_TONE[card.mode],
            ...(shared === undefined ? {} : { shared: otherTitles(shared, row), repeated: shared[0] !== row }),
          };
        }),
        ...(alwaysRule === undefined ? {} : { always: alwaysRule }),
      };
    }),
  }));
}

/**
 * Rules' tools, tool by tool (REV-RULES-D, A), as `toolGroups` words them: one card per group, each
 * tool under its title with its rules and the always-on rule that sits with it. Payments and Stripe
 * open with `moneyBand`'s rows, on the card's fill. A rule a confirmed change `landed` on says
 * "Updated": a changed card's, every rule on a tool the change turned on, and a tool's default ask
 * once a change its review listed leaves the tool no rule of its own.
 */
export function ToolConnectors({ deskId, view, people, landed = NOTHING_LANDED, moneyBand }: {
  deskId: string; view: RulesView; people: PeopleOut | null; landed?: LandedRules;
  moneyBand?: (group: ToolGroup) => ReactNode;
}) {
  return toolGroups(view, people).map((group) => (
    <Card key={group.key} as="section" label={group.name} padding={0}>
      <div className="cd-house-rules__connector">
        <div className="cd-house-rules__connector-header">
          {group.connector === null ? null : <ConnectorIcon icon={group.connector.icon} size="section" />}
          <div className="cd-house-rules__identity">
            {group.connector === null
              ? <span className="cd-house-rules__jobs-name cd-type-section">{group.name}</span>
              : <ConnectorName connector={group.connector} size="section" />}
            <p className="cd-house-rules__identity-line cd-type-meta">{group.line}</p>
          </div>
        </div>
        {group.money && moneyBand !== undefined ? (
          <div className="cd-house-rules__money" data-money-band={group.key}>
            <ul className="cd-house-rules__rules cd-house-rules__rules--band" role="list">{moneyBand(group)}</ul>
          </div>
        ) : null}
        {group.entries.map((entry) => {
          const { row } = entry;
          const href = group.connector === null ? undefined : connectorPageHref(deskId, `connectors/${group.key}/${encodeURIComponent(row.tool)}`);
          const toolLanded = entry.covered ? undefined : latest(landed.reviewed.get(row.tool), landed.tools.get(row.tool));
          return (
            <section className="cd-house-rules__tool" key={row.tool} aria-label={entry.title} data-tool={row.tool}>
              <ToolHeader row={row} title={entry.title} href={href} description={entry.description} connector={group.connector} status={entry.status} />
              <ul className="cd-house-rules__rules" role="list">
                {entry.rules.map((rule) => (
                  <ToolRule
                    key={rule.card.card_id}
                    parts={rule.parts}
                    line={rule.line}
                    status={rule.status}
                    card={rule.card}
                    landed={toolLanded ?? latest(landed.cards.get(rule.card.card_id), landed.tools.get(row.tool))}
                    details={{ version: view.active, cards: entry.covered ? [rule.card] : [] }}
                    {...(rule.shared === undefined ? {} : { shared: rule.shared, repeated: rule.repeated ?? false })}
                  />
                ))}
                {entry.always === undefined ? null : <AlwaysOnRule parts={entry.always.parts} />}
              </ul>
            </section>
          );
        })}
      </div>
    </Card>
  ));
}
