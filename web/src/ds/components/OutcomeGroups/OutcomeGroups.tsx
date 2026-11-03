import { useId, type ReactNode } from 'react';

import { Card } from '../Card/Card.tsx';
import { OUTCOME_GROUP_WORDS, OUTCOME_TONE, type RuleMode } from '../OutcomeMenu/outcomeWords.ts';
import { StatusDot } from '../StatusDot/StatusDot.tsx';

import './OutcomeGroups.css';

/** One rule in a group, in the screen's words. */
export interface OutcomeGroupRow {
  key: string;
  /** What Claude does: "Quotes from your price list, at list price", "Refunds". */
  text: string;
  /** Who it's for: "Anyone", "Verified customers", "Signed agents". */
  who: string;
}

export interface OutcomeGroupsProps {
  /** The rules by outcome. A group with none is left out. */
  rows: Readonly<Partial<Record<RuleMode, readonly OutcomeGroupRow[]>>>;
  /** The payment limit's line (`MoneyLimit` with `prominent` and no `onEdit`), in a card of its own above the groups. */
  moneyLimit?: ReactNode;
}

/** The groups in the order the setup board draws them. */
const MODES = ['auto', 'ask', 'never'] as const satisfies readonly RuleMode[];

/**
 * A Desk's rules grouped by what Claude does: "Allow", "Ask me first" and "Never", each
 * a card under its outcome's dot with a row per rule, what it does at the left and who it's for at
 * the right. The payment limit's line, when given, sits in a card of its own above them, since it
 * holds over every rule below it. The setup interview's rules step shows the draft this way.
 */
export function OutcomeGroups({ rows, moneyLimit }: OutcomeGroupsProps) {
  return (
    <div className="cd-outcome-groups">
      {moneyLimit ? <Card padding={16}>{moneyLimit}</Card> : null}
      {MODES.map((mode) => {
        const group = rows[mode] ?? [];
        return group.length > 0 ? <Group key={mode} mode={mode} rows={group} /> : null;
      })}
    </div>
  );
}

function Group({ mode, rows }: { mode: RuleMode; rows: readonly OutcomeGroupRow[] }) {
  const headingId = useId();
  return (
    <section className="cd-outcome-groups__group" aria-labelledby={headingId}>
      <Card padding={16}>
        <h2 id={headingId} className="cd-outcome-groups__title cd-type-control">
          <StatusDot tone={OUTCOME_TONE[mode]} />
          <span>{OUTCOME_GROUP_WORDS[mode]}</span>
        </h2>
        <ul role="list" className="cd-outcome-groups__rows">
          {rows.map((row) => (
            <li key={row.key} className="cd-outcome-groups__row">
              <span className="cd-outcome-groups__text cd-type-body">{row.text}</span>{' '}
              <span className="cd-outcome-groups__who cd-type-meta">{row.who}</span>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
