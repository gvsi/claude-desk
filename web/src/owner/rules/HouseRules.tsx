import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { useNavigate } from 'react-router';

import { MONEY_EFFECTS, type RuleCard } from '../../api/contracts.ts';
import { ownerErrorCopy } from '../../api/http.ts';
import type { PeopleOut, PolicyVersionOut, RulesView, ToolRow } from '../../api/views.ts';
import { pollMs } from '../../app/poll.ts';
import {
  AdvancedDetails,
  Breadcrumb,
  Button,
  Card,
  ConnectorIcon,
  ConnectorName,
  LoadingLine,
  Notice,
  PageHeader,
  OUTCOME_TONE,
  RuleSentence,
  StatusDot,
  ToolTitleList,
  type ConnectorView,
  type RuleMode,
  type SentencePart,
} from '../../ds/index.ts';
import { inApp, useDocumentTitle } from '../../lib/useDocumentTitle.ts';
import { connectorPageHref } from '../connectors/pages.ts';
import { BUSINESS_WORDS, businessOwnerLine, businessRulesDescription } from '../connectors/businessWords.ts';
import { businessTools, isBusinessToolName, isCatalogTool, TOOL_NAMES, toolDisplayName, toolState } from '../connectors/catalog.ts';
import { followInAppLinks } from '../inAppLinks.ts';
import { RouterLink, useOwnerDesk } from '../OwnerLayout.tsx';
import { deskPath } from '../useDesks.ts';
import { useReadFailure } from '../useReadFailure.ts';
import { copyText, ruleDetails, toolDetails, type Details } from './details.tsx';
import { governingRules, hubSections } from './hub.ts';
import { holdLine, moneyCapToolSentence, ruleMeta, ruleSentence, type SentenceWords } from './ruleSentence.ts';
import { peopleQuery, rulesQuery } from './RuleDraftReview.tsx';
import { RULES_TITLE } from './RulesPage.tsx';

import './HouseRules.css';

const TITLE = 'Your tools';
const INTRO = 'Each connector brings tools; each tool lists the rules that cover it. A rule shared with other tools says so once, then reads "the same rule as above".';

/** A sentence row: its words, then its status dot and its Details (REV-RULES-D), whose panel opens under the row. */
function ToolRule({ parts, mode, shared, repeated, card, audience, details }: {
  parts: readonly SentencePart[]; mode: RuleMode; shared?: readonly string[]; repeated?: boolean;
  card?: RuleCard; audience?: string; details: Details;
}) {
  const textId = useId();
  return (
    <li className={`cd-house-rules__rule${repeated ? ' cd-house-rules__rule--reference cd-type-meta' : ''}`} data-rule-id={card?.card_id}>
      <AdvancedDetails {...details} onCopy={copyText} describedBy={textId}>
        {(toggle) => (
          <div className="cd-house-rules__rule-row">
            <div className="cd-house-rules__rule-text" id={textId}>
              <RuleSentence
                parts={repeated ? [...parts, { text: ' · Shared rule, as above' }] : parts}
              />
              {audience === undefined ? null : (
                <p className="cd-rule-sentence__meta cd-type-meta">{audience}</p>
              )}
              {shared === undefined || shared.length === 0 || repeated ? null : (
                <p className="cd-house-rules__shared cd-type-meta">Shared rule. Also applies to:<br /><ToolTitleList titles={shared} /></p>
              )}
            </div>
            <span className="cd-house-rules__rule-actions"><StatusDot tone={OUTCOME_TONE[mode]} />{toggle}</span>
          </div>
        )}
      </AdvancedDetails>
    </li>
  );
}

/**
 * A tool: its title and its line, then its Details (REV-RULES-D), whose panel opens between the
 * tool and its rules. Its effects show only there, in the panel's Effects row.
 */
function ToolHeader({ row, title, href, description, connector }: {
  row: ToolRow; title: string; href: string | undefined; description: string; connector: ConnectorView | null;
}) {
  const titleId = useId();
  return (
    <AdvancedDetails {...toolDetails(row, connector)} onCopy={copyText} describedBy={titleId}>
      {(toggle) => (
        <div className="cd-house-rules__tool-header">
          <div className="cd-house-rules__tool-text">
            <div className="cd-house-rules__tool-title cd-type-body">
              {href === undefined ? <span id={titleId} className="cd-house-rules__tool-name cd-user-name" data-copy="user">{title}</span>
                : <RouterLink className="cd-house-rules__tool-name cd-user-name" data-copy="user" href={href}><span id={titleId}>{title}</span></RouterLink>}
            </div>
            {description === '' ? null : <p className="cd-house-rules__tool-description cd-type-meta">{description}</p>}
          </div>
          {toggle}
        </div>
      )}
    </AdvancedDetails>
  );
}

/** All displayed tools in one order, so each shared rule is expanded exactly once across connectors. */
function ToolConnectors({ deskId, view, people }: { deskId: string; view: RulesView; people: PeopleOut | null }) {
  const business = businessTools(view.tools);
  const words: SentenceWords = { business, people, tools: view.tools };
  const jobs = view.tools.filter((row) => row.source === 'business' && isBusinessToolName(row.tool)
    && Array.isArray(row.effects) && row.effects.every((effect) => ['read', 'private_data', 'change', 'charge', 'pay_out', 'send_message'].includes(effect))
    && ['on', 'changed'].includes(toolState(row)));
  const sections = hubSections(view, people);
  const groups = [
    ...(jobs.length === 0 ? [] : [{ key: 'jobs', name: BUSINESS_WORDS.jobs, connector: null, tools: jobs }]),
    ...sections.map((section) => ({
      key: section.connector.id, name: section.connector.name, connector: section.connector,
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
  const moneyTools = tools.filter((row) => row.effects.some((effect) => MONEY_EFFECTS.has(effect)));
  const otherTitles = (rows: readonly ToolRow[], row: ToolRow) => rows.filter((other) => other.tool !== row.tool)
    .map((other) => toolDisplayName(other.tool, business) ?? 'A connected tool');

  return groups.map((group) => (
    <Card key={group.key} as="section" label={group.name} padding={0}>
      <div className="cd-house-rules__connector">
        <div className="cd-house-rules__connector-header">
          {group.connector === null ? <h2 className="cd-type-section">{group.name}</h2> : (
            <>
              <ConnectorIcon icon={group.connector.icon} size="section" />
              <div className="cd-house-rules__identity">
                <ConnectorName connector={group.connector} size="section" level={2} />
                <p className="cd-type-meta">{group.connector.description}</p>
              </div>
            </>
          )}
        </div>
        {group.tools.map((row) => {
          const title = toolDisplayName(row.tool, business) ?? 'A connected tool';
          const description = row.source === 'business'
            ? businessRulesDescription(row.business) ?? businessOwnerLine(row.business?.config) ?? ''
            : isCatalogTool(row.tool) ? TOOL_NAMES[row.tool].line : '';
          const href = group.connector === null ? undefined : connectorPageHref(deskId, `connectors/${group.key}/${encodeURIComponent(row.tool)}`);
          const covering = cards.get(row.tool) ?? [];
          // No card covers the tool, so it asks by default: a sentence drawn from no card, whose details name none.
          const displayed: RuleCard[] = covering.length === 0 ? [{
            card_id: `default:${row.tool}`, applies_to: row.tool, mode: 'ask', who: 'anyone',
            person_id: null, agent_key_id: null, max_amount_cents: null, max_discount_bp: 0,
            hours: null, review: false, is_default: true, reason: '',
          }] : covering;
          return (
            <section className="cd-house-rules__tool" key={row.tool} aria-label={title} data-tool={row.tool}>
              <ToolHeader row={row} title={title} href={href} description={description} connector={group.connector} />
              <ul className="cd-house-rules__rules" role="list">
                {displayed.map((card) => {
                  const shared = sharedCoverage.get(card.card_id);
                  const hold = holdLine(card);
                  return (
                    <ToolRuleWithHold key={card.card_id} card={card} words={words} hold={hold} version={view.active} drawn={covering.length > 0}
                      shared={shared === undefined ? undefined : otherTitles(shared, row)} repeated={shared !== undefined && shared[0] !== row} />
                  );
                })}
                {!moneyTools.includes(row) ? null : <ToolRule parts={moneyCapToolSentence(view.active.auto_money_cap_cents ?? 0)} mode="ask"
                  shared={otherTitles(moneyTools, row)} repeated={moneyTools[0] !== row} details={ruleDetails(view.active, [], { moneyCap: true })} />}
              </ul>
            </section>
          );
        })}
      </div>
    </Card>
  ));
}

/**
 * A card's row, and its hold's under it when it has a limit; both rows' details are the card's. A
 * row `drawn` from no card (a tool's default ask) names no card in its details.
 */
function ToolRuleWithHold({ card, words, hold, shared, repeated, version, drawn }: {
  card: RuleCard; words: SentenceWords; hold: SentencePart[] | null; shared?: readonly string[]; repeated: boolean;
  version: PolicyVersionOut; drawn: boolean;
}) {
  const audience = card.who === 'anyone' ? undefined : ruleMeta(card, words).who;
  const details = ruleDetails(version, drawn ? [card] : []);
  return <>
    <ToolRule parts={ruleSentence(card, words)} mode={card.mode} card={card} audience={audience} shared={shared} repeated={repeated} details={details} />
    {hold === null ? null : <ToolRule parts={hold} mode="ask" audience={audience} details={details} />}
  </>;
}

/** `rules/all`: the connector and tool inventory, with the rules that govern each tool. */
export function HouseRules() {
  const { desk } = useOwnerDesk();
  useDocumentTitle(inApp(TITLE));
  const deskId = desk.desk_id;
  const navigate = useNavigate();
  const rules = useQuery({ ...rulesQuery(deskId), refetchInterval: pollMs('rules') });
  const people = useQuery(peopleQuery(deskId));
  const failure = useReadFailure(rules);

  let body;
  if (rules.data === undefined && rules.isError) {
    body = (
      <Notice
        tone="error"
        action={
          <Button variant="secondary" busy={failure?.retrying ?? false} onClick={() => void rules.refetch()}>
            Try again
          </Button>
        }
      >
        {ownerErrorCopy(rules.error)}
      </Notice>
    );
  } else if (rules.data === undefined) {
    body = <LoadingLine>Reading your rules</LoadingLine>;
  } else {
    const view = rules.data;
    body = (
      <>
        {failure === null ? null : (
          <Notice
            tone="error"
            action={
              <Button variant="secondary" busy={failure.retrying} onClick={failure.retry}>
                Try again
              </Button>
            }
          >
            {failure.line}
          </Notice>
        )}
        <ToolConnectors deskId={deskId} view={view} people={people.data ?? null} />
      </>
    );
  }

  return (
    <div className="cd-house-rules" onClick={followInAppLinks(navigate)}>
      <div className="cd-house-rules__header">
        <Breadcrumb items={[{ label: RULES_TITLE, href: `${deskPath(deskId)}/rules` }, { label: TITLE }]} linkComponent={RouterLink} />
        <PageHeader title={TITLE} subtitle="Your connectors, their tools, and the rules that cover each." />
        <p className="cd-house-rules__intro cd-type-meta">{INTRO}</p>
      </div>
      {body}
    </div>
  );
}
