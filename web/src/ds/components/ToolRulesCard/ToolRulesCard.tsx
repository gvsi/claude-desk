import type { ComponentType, ReactNode } from 'react';

import { Icon } from '../../icons/index.tsx';
import { Button } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';
import { RuleRow, type RuleRowProps } from '../RuleRow/RuleRow.tsx';

import './ToolRulesCard.css';

/** What a screen's router link gets from the rules and connector pieces: the props of an `<a>`. */
export interface RulesLinkProps {
  href: string;
  className: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  children: ReactNode;
}

function PlainLink({ children, ...props }: RulesLinkProps) {
  return <a {...props}>{children}</a>;
}

export interface ToolRulesCardProps {
  /** The card's name: the tool's name on a connector's page, or "Your rules for refund" on its own page. */
  label: string;
  /**
   * On a connector's page, the tool's name and line as one link to the tool's page. Without an
   * `href` (the page isn't built yet) they're plain text, with no chevron and no tab stop.
   */
  tool?: { name: string; description: string; href?: string };
  /** A row per rule that governs the tool (`rulesForTool`), most specific first. */
  rules: readonly RuleRowProps[];
  /**
   * "Anything else here: ask me." as the last row: true unless the screen passes false, as it does
   * when a never card for anyone covers the tool and nothing is left to ask about.
   */
  fallback?: boolean;
  /** Adds a ghost "Add a rule" to the fallback row. */
  onAddRule?: () => void;
  /** The app's router link; a plain `<a>` by default. */
  linkComponent?: ComponentType<RulesLinkProps>;
}

function ToolText({ name, description }: { name: string; description: string }) {
  return (
    <span className="cd-tool-rules__tool-text">
      <span className="cd-tool-rules__tool-name cd-type-section">{name}</span>{' '}
      <span className="cd-tool-rules__tool-description cd-type-meta">{description}</span>
    </span>
  );
}

/**
 * A tool and every rule that governs it: on a connector's page, the tool's name and line as a link
 * to its page, then a `RuleRow` per rule, then what happens to anything else.
 */
export function ToolRulesCard({ label, tool, rules, fallback = true, onAddRule, linkComponent: Link = PlainLink }: ToolRulesCardProps) {
  return (
    <Card as="section" label={label} padding={16}>
      {tool ? (
        tool.href === undefined ? (
          <div className="cd-tool-rules__tool">
            <ToolText name={tool.name} description={tool.description} />
          </div>
        ) : (
          <Link href={tool.href} className="cd-tool-rules__tool">
            <ToolText name={tool.name} description={tool.description} />
            <Icon name="chevron-right" size={16} className="cd-tool-rules__chevron" />
          </Link>
        )
      ) : null}
      {rules.length > 0 ? (
        <ul role="list" className="cd-tool-rules__rules">
          {rules.map((rule) => (
            <li key={rule.rule.card_id} className="cd-tool-rules__rule">
              <RuleRow {...rule} />
            </li>
          ))}
        </ul>
      ) : null}
      {fallback ? (
        <div className="cd-tool-rules__fallback">
          <p className="cd-tool-rules__fallback-line cd-type-meta">Anything else here: ask me.</p>
          {onAddRule ? (
            <Button variant="ghost" onClick={() => onAddRule()}>
              Add a rule
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
