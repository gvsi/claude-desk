import { useId, type ComponentType, type ReactNode } from 'react';

import type { ToolStatus } from '../../../api/contracts.ts';
import { Icon } from '../../icons/index.tsx';
import { Card } from '../Card/Card.tsx';
import { ConnectorIcon } from '../ConnectorIcon/ConnectorIcon.tsx';
import { ConnectorName, type ConnectorView } from '../ConnectorName/ConnectorName.tsx';
import { OUTCOME_TONE, outcomePhrase, type RuleMode } from '../OutcomeMenu/outcomeWords.ts';
import { StatusLabel, type StatusTone } from '../StatusDot/StatusDot.tsx';
import type { RulesLinkProps } from '../ToolRulesCard/ToolRulesCard.tsx';
import { CrossFade } from './CrossFade.tsx';
import { LandedGlow, UpdatedPill } from './Landing.tsx';

import './ConnectorSection.css';

/** One tool on the Rules hub, in the screen's words. */
export interface ToolSummaryView {
  /** The tool's key on the screen: its `ToolName`. */
  key: string;
  /** Its name: "Payment link". */
  name: string;
  /** What it does and its effects: "Prices a job from your price list. Changes something. Can be undone." */
  description: string;
  /** Its rule words: "Anyone · No discounts", "2 rules · 1 shared", "Always on". */
  summary: string;
  /**
   * The tool's outcome: the most that runs on its own for some visitor under the owner's rules, so
   * the row never reads safer than what runs ("Ask me first" when no rule of the owner's covers
   * it). The screen works it out.
   */
  mode: RuleMode;
  /** That outcome's formatted amount limit, for "Automatic" with one ("$300"). */
  limit?: string;
  /** Its profile's status: a tool that needs review or is off says so in place of its outcome. */
  status: ToolStatus;
  /** Its page. Without one (the page isn't built yet), the row draws the same words with nothing to open. */
  href?: string;
  /**
   * The owner's confirmed change changed this tool's rules since they opened the page: the row
   * carries "Updated" after its name, its words cross-fade to the new ones, and it lights up in the
   * selected fill, holds, then lets go. The screen keeps it until the owner leaves the page. Each
   * new value (the next change that changed it) lights the row up again. The row carries it as
   * `data-landed`, so a screen can find where a landing's rows are.
   */
  landed?: number;
}

export interface ConnectorSectionProps {
  connector: ConnectorView;
  /** The connector's page. Without one, the header draws the same words with nothing to open. */
  href?: string;
  tools: readonly ToolSummaryView[];
  /** A note beside the name right after the connector was added: "Added just now". */
  addedNote?: string;
  /**
   * A line between the header and the tool rows, in a row of its own: on Payments and Stripe, the
   * payment limit that holds over every rule below it.
   */
  aboveTools?: ReactNode;
  /** The app's router link; a plain `<a>` by default. */
  linkComponent?: ComponentType<RulesLinkProps>;
}

function PlainLink({ children, ...props }: RulesLinkProps) {
  return <a {...props}>{children}</a>;
}

/** A tool's outcome in words and its dot: its rule's outcome while it is on, or why it isn't. */
function toolOutcome(tool: ToolSummaryView): { tone: StatusTone; words: string } {
  if (tool.status === 'enabled') return { tone: OUTCOME_TONE[tool.mode], words: outcomePhrase(tool.mode, tool.limit) };
  if (tool.status === 'disabled') return { tone: 'info', words: 'Off' };
  // A changed definition, or a status this build doesn't know: the owner needs to look.
  return { tone: 'held', words: 'Needs your review' };
}

/**
 * One connector on the Rules hub: a header that links to the connector's page, then a link row per
 * tool with its rule words and its outcome. Under 640 px of its own width the descriptions and the
 * count go, and each tool's words sit under its name, with its outcome on its own line under them.
 * A header or a tool without an `href` draws the same words in the same type, with no link, no tab
 * stop and no chevron, for a screen whose connector and tool pages aren't built yet.
 */
export function ConnectorSection({ connector, href, tools, addedNote, aboveTools, linkComponent: Link = PlainLink }: ConnectorSectionProps) {
  const ids = useId();
  const count = tools.length === 1 ? '1 tool' : `${tools.length} tools`;
  const heading = (
    <>
      <ConnectorIcon icon={connector.icon} size="section" />
      <span className="cd-connector-section__identity">
        <ConnectorName connector={connector} size="section" hideBuiltIn />{' '}
        <span className="cd-connector-section__description cd-type-meta">{connector.description}</span>
      </span>
      {addedNote ? (
        <>
          {' '}
          <span className="cd-connector-section__added cd-type-caption">{addedNote}</span>
        </>
      ) : null}{' '}
      <span className="cd-connector-section__count cd-type-meta">{count}</span>
    </>
  );
  return (
    <Card as="section" label={connector.name} padding={0}>
      <div className="cd-connector-section">
        {href === undefined ? (
          <div className="cd-connector-section__header">{heading}</div>
        ) : (
          <Link href={href} className="cd-connector-section__header">
            {heading}
            <Icon name="chevron-right" size={16} className="cd-connector-section__chevron" />
          </Link>
        )}
        {aboveTools ? <div className="cd-connector-section__above">{aboveTools}</div> : null}
        {tools.length > 0 ? (
          <ul role="list" className="cd-connector-section__tools">
            {tools.map((tool, index) => {
              const outcome = toolOutcome(tool);
              const descriptionId = `${ids}-tool-${index}`;
              const linked = tool.href !== undefined;
              const landed = tool.landed !== undefined;
              return (
                // The tool's name is its link, and the link's overlay covers the row, so the whole row
                // opens the tool while the link's own text stays its name's first words.
                <li
                  key={tool.key}
                  className={`cd-connector-section__tool${linked ? '' : ' cd-connector-section__tool--plain'}`}
                  {...(landed ? { 'data-landed': tool.landed } : {})}
                >
                  {/* The fill it lights up in, behind its words: drawn again for each change that lands on it. */}
                  {landed ? <LandedGlow key={`glow-${tool.landed}`} /> : null}
                  <span className="cd-connector-section__tool-head">
                    {tool.href === undefined ? (
                      <span className="cd-connector-section__tool-name cd-type-body" data-copy="user">
                        {tool.name}
                      </span>
                    ) : (
                      <Link
                        href={tool.href}
                        className="cd-connector-section__tool-name cd-connector-section__tool-link cd-type-body"
                        aria-label={`${tool.name}${landed ? ', updated' : ''}: ${tool.summary}, ${outcome.words}. Open`}
                        aria-describedby={descriptionId}
                      >
                        {/* The tool's own title, so it is user text; the link's name above stays the app's words around it. */}
                        <span data-copy="user">{tool.name}</span>
                      </Link>
                    )}
                    {landed ? <UpdatedPill /> : null}
                  </span>
                  <span id={descriptionId} className="cd-connector-section__tool-description cd-type-meta">
                    {tool.description}
                  </span>
                  <span className="cd-connector-section__tool-summary cd-type-meta">
                    <CrossFade text={tool.summary} fade={landed} />
                  </span>
                  <span className="cd-connector-section__tool-outcome cd-type-meta">
                    <StatusLabel tone={outcome.tone}>{outcome.words}</StatusLabel>
                  </span>
                  {linked ? <Icon name="chevron-right" size={16} className="cd-connector-section__chevron" /> : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}
