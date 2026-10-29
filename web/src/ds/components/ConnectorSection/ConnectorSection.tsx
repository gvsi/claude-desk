import { useId, type ComponentType } from 'react';

import type { ToolStatus } from '../../../api/contracts.ts';
import { Icon } from '../../icons/index.tsx';
import { Card } from '../Card/Card.tsx';
import { ConnectorIcon } from '../ConnectorIcon/ConnectorIcon.tsx';
import { ConnectorName, type ConnectorView } from '../ConnectorName/ConnectorName.tsx';
import { OUTCOME_TONE, OUTCOME_WORDS, type RuleMode } from '../OutcomeMenu/outcomeWords.ts';
import { StatusLabel, type StatusTone } from '../StatusDot/StatusDot.tsx';
import type { RulesLinkProps } from '../ToolRulesCard/ToolRulesCard.tsx';

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
  /** The outcome of the rule that governs it for anyone. */
  mode: RuleMode;
  /** Its profile's status: a tool that needs review or is off says so in place of its outcome. */
  status: ToolStatus;
  /** Its page. */
  href: string;
}

export interface ConnectorSectionProps {
  connector: ConnectorView;
  /** The connector's page. */
  href: string;
  tools: readonly ToolSummaryView[];
  /** A note beside the name right after the connector was added: "Added just now". */
  addedNote?: string;
  /** The app's router link; a plain `<a>` by default. */
  linkComponent?: ComponentType<RulesLinkProps>;
}

function PlainLink({ children, ...props }: RulesLinkProps) {
  return <a {...props}>{children}</a>;
}

/** A tool's outcome in words and its dot: its rule's outcome while it is on, or why it isn't. */
function toolOutcome(tool: ToolSummaryView): { tone: StatusTone; words: string } {
  if (tool.status === 'enabled') return { tone: OUTCOME_TONE[tool.mode], words: OUTCOME_WORDS[tool.mode] };
  if (tool.status === 'disabled') return { tone: 'info', words: 'Off' };
  // A changed definition, or a status this build doesn't know: the owner needs to look.
  return { tone: 'held', words: 'Needs your review' };
}

/**
 * One connector on the Rules hub: a header that links to the connector's page, then a link row per
 * tool with its rule words and its outcome. Under 640 px of its own width the descriptions and the
 * count go, and each tool's words sit under its name.
 */
export function ConnectorSection({ connector, href, tools, addedNote, linkComponent: Link = PlainLink }: ConnectorSectionProps) {
  const ids = useId();
  const count = tools.length === 1 ? '1 tool' : `${tools.length} tools`;
  return (
    <Card as="section" label={connector.name} padding={0}>
      <div className="cd-connector-section">
        <Link href={href} className="cd-connector-section__header">
          <ConnectorIcon icon={connector.icon} size="section" />
          <span className="cd-connector-section__identity">
            <ConnectorName connector={connector} size="section" />{' '}
            <span className="cd-connector-section__description cd-type-meta">{connector.description}</span>
          </span>
          {addedNote ? (
            <>
              {' '}
              <span className="cd-connector-section__added cd-type-caption">{addedNote}</span>
            </>
          ) : null}{' '}
          <span className="cd-connector-section__count cd-type-meta">{count}</span>
          <Icon name="chevron-right" size={16} className="cd-connector-section__chevron" />
        </Link>
        {tools.length > 0 ? (
          <ul className="cd-connector-section__tools">
            {tools.map((tool, index) => {
              const outcome = toolOutcome(tool);
              const descriptionId = `${ids}-tool-${index}`;
              return (
                // The tool's name is its link, and the link's overlay covers the row, so the whole row
                // opens the tool while the link's own text stays its name's first words.
                <li key={tool.key} className="cd-connector-section__tool">
                  <Link
                    href={tool.href}
                    className="cd-connector-section__tool-link cd-type-body"
                    aria-label={`${tool.name}: ${tool.summary}, ${outcome.words}. Open`}
                    aria-describedby={descriptionId}
                  >
                    {tool.name}
                  </Link>
                  <span id={descriptionId} className="cd-connector-section__tool-description cd-type-meta">
                    {tool.description}
                  </span>
                  <span className="cd-connector-section__tool-summary cd-type-meta">{tool.summary}</span>
                  <span className="cd-connector-section__tool-outcome cd-type-meta">
                    <StatusLabel tone={outcome.tone}>{outcome.words}</StatusLabel>
                  </span>
                  <Icon name="chevron-right" size={16} className="cd-connector-section__chevron" />
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}
