import { useId, type ComponentType } from 'react';

import type { RuleCard } from '../../../api/contracts.ts';
import { Card } from '../Card/Card.tsx';
import { OutcomeMenu } from '../OutcomeMenu/OutcomeMenu.tsx';
import { ruleWordsLine, type RuleWord } from '../RuleRow/RuleRow.tsx';
import { SectionHeader } from '../SectionHeader/SectionHeader.tsx';
import type { RulesLinkProps } from '../ToolRulesCard/ToolRulesCard.tsx';

import './PersonRules.css';

/** One rule just for this person, in the screen's words. */
export interface PersonRuleView {
  key: string;
  /** The tool it's on: "Book a visit". */
  title: string;
  rule: Pick<RuleCard, 'card_id' | 'mode' | 'reason'>;
  /** What the card enforces (Plan 04's `ruleWords`), joined by " · ". */
  words: readonly RuleWord[];
  /** The screen's formatted amount for an auto card with `max_amount_cents` ("$300"). */
  limit?: string;
}

export interface PersonRulesProps {
  /**
   * The person's name, as their page shows it. It is theirs: shown marked as user text inside the
   * component's words, isolated (`<bdi data-copy="user">`) so a direction mark in it can't reorder
   * the words around it.
   */
  name: string;
  /** The Desk's rules for this person alone, `person_id` theirs. */
  rules: readonly PersonRuleView[];
  /** The Rules page, where the rules are changed. */
  rulesHref: string;
  /** The app's router link; a plain `<a>` by default. */
  linkComponent?: ComponentType<RulesLinkProps>;
}

function PlainLink({ children, ...props }: RulesLinkProps) {
  return <a {...props}>{children}</a>;
}

/**
 * The rules just for one person, on their page: "Rules for {name}", with "Change them on Rules" at
 * the right, over a card with a row per rule, read only: what it's on over its reason, then what
 * it enforces and its outcome at the right. With none, one quiet line says so. Under 480 px of its
 * own width, what a rule enforces and its outcome go under its reason.
 */
export function PersonRules({ name, rules, rulesHref, linkComponent: Link = PlainLink }: PersonRulesProps) {
  const headingId = useId();
  return (
    <section className="cd-person-rules" aria-labelledby={headingId}>
      <SectionHeader
        id={headingId}
        title={
          <>
            Rules for <bdi data-copy="user">{name}</bdi>
          </>
        }
        caption={
          <Link href={rulesHref} className="cd-person-rules__change">
            Change them on Rules
          </Link>
        }
      />
      {rules.length > 0 ? (
        <Card padding={0}>
          <ul role="list" className="cd-person-rules__rows">
            {rules.map((row) => {
              const line = ruleWordsLine(row.words);
              return (
                <li key={row.key} className="cd-person-rules__row">
                  <span className="cd-person-rules__text">
                    <span className="cd-person-rules__title cd-type-control">{row.title}</span>{' '}
                    <span className="cd-person-rules__reason cd-type-meta">{row.rule.reason}</span>
                  </span>{' '}
                  {line !== '' ? <span className="cd-person-rules__words cd-type-meta">{line}</span> : null}{' '}
                  <OutcomeMenu label={row.rule.reason} value={row.rule.mode} limit={row.limit} />
                </li>
              );
            })}
          </ul>
        </Card>
      ) : (
        <p className="cd-person-rules__none cd-type-body">
          No rules just for <bdi data-copy="user">{name}</bdi>.
        </p>
      )}
    </section>
  );
}
