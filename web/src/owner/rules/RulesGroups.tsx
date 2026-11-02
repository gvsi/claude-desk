import { useId } from 'react';

import { Card, LandedGlow, OUTCOME_TONE, RuleSentence, StatusDot, UpdatedPill } from '../../ds/index.ts';
import type { RulesGroup } from './hub.ts';

/** The board's single card. A row keeps its source cards for landing and the later Details action. */
export function RulesGroups({ groups, landed, landedCards, landedLimit }: {
  groups: readonly RulesGroup[];
  landed: ReadonlyMap<string, number>;
  landedLimit: number | null;
  landedCards: ReadonlyMap<string, number>;
}) {
  const id = useId();
  return (
    <div className="cd-rules__groups">
      <Card>
        {groups.map((group) => (
          <section key={group.mode} className="cd-rules__group" aria-labelledby={`${id}-${group.mode}`}>
            <h2 id={`${id}-${group.mode}`} className="cd-rules__group-title cd-type-section">
              <StatusDot tone={OUTCOME_TONE[group.mode]} />{group.title}
            </h2>
            <ul role="list" className="cd-rules__rows">
              {group.rows.map((row) => {
                const at = row.moneyLimit ? landedLimit : [
                  ...row.cards.map((card) => landedCards.get(card.card_id)),
                  ...row.toolKeys.map((tool) => landed.get(tool)),
                ].reduce<number | null>((latest, value) => {
                  return value === undefined ? latest : Math.max(latest ?? 0, value);
                }, null);
                return (
                  <li key={row.key} className="cd-rules__row" data-landed={at ?? undefined}
                    data-rule-cards={row.cards.map((card) => card.card_id).join(' ')} data-rule-key={row.key}
                    data-money-limit={row.moneyLimit || undefined}>
                    {at === null ? null : <LandedGlow key={at} />}
                    {row.sectionLabel === undefined ? null : <p className="cd-rules__baseline-label cd-type-meta">{row.sectionLabel}</p>}
                    <RuleSentence parts={row.parts} meta={row.meta} />
                    <div className="cd-rules__row-actions">
                      {at === null ? null : <UpdatedPill key={at} />}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </Card>
    </div>
  );
}
