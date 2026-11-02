import type { ComponentType, ReactNode } from 'react';

import { Icon } from '../../icons/index.tsx';
import { Button } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';
import { LandedGlow, UpdatedPill } from '../ConnectorSection/Landing.tsx';
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
  /**
   * The owner's confirmed change changed this tool's rules since they opened the page (a business's
   * own job on Rules): "Updated" by the tool's name, the rules' words cross-fade to the new ones,
   * and the card lights up in the selected fill, holds, then lets go. A card that offers "Add a
   * rule" takes no fill, since a Button can't sit on the selected ground. The screen keeps it until
   * the owner leaves the page; each new value lights the card up again. The card carries it as
   * `data-landed`, so a screen can find where a landing's rows are.
   */
  landed?: number;
}

function ToolText({ name, description, updated }: { name: string; description: string; updated: boolean }) {
  return (
    <span className="cd-tool-rules__tool-text">
      <span className="cd-tool-rules__tool-head">
        {/* The tool's own title (a business's job from setup), so it is user text, not the app's words. */}
        <span className="cd-tool-rules__tool-name cd-type-section cd-user-name" data-copy="user">
          {name}
        </span>
        {updated ? <UpdatedPill /> : null}
      </span>
      {description ? <> <span className="cd-tool-rules__tool-description cd-type-meta">{description}</span></> : null}
    </span>
  );
}

/**
 * A tool and every rule that governs it: on a connector's page, the tool's name and line as a link
 * to its page, then a `RuleRow` per rule, then what happens to anything else.
 */
export function ToolRulesCard({ label, tool, rules, fallback = true, onAddRule, linkComponent: Link = PlainLink, landed }: ToolRulesCardProps) {
  const updated = landed !== undefined;
  return (
    <Card as="section" label={label} padding={16}>
      <div className="cd-tool-rules" {...(updated ? { 'data-landed': landed } : {})}>
        {tool ? (
          tool.href === undefined ? (
            <div className="cd-tool-rules__tool">
              <ToolText name={tool.name} description={tool.description} updated={updated} />
            </div>
          ) : (
            <Link href={tool.href} className="cd-tool-rules__tool">
              <ToolText name={tool.name} description={tool.description} updated={updated} />
              <Icon name="chevron-right" size={16} className="cd-tool-rules__chevron" />
            </Link>
          )
        ) : null}
        {rules.length > 0 ? (
          <ul role="list" className="cd-tool-rules__rules">
            {rules.map((rule) => (
              <li key={rule.rule.card_id} className="cd-tool-rules__rule">
                <RuleRow {...rule} fade={updated} />
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
        {/* The fill the card lights up in, behind its words, last so no first-child rule counts it:
            drawn again for each change that lands on it. */}
        {updated && onAddRule === undefined ? <LandedGlow key={`glow-${landed}`} /> : null}
      </div>
    </Card>
  );
}
