import type { PeopleOut, RulesView } from '../../api/views.ts';
import { ToolRulesCard } from '../../ds/index.ts';
import { BUSINESS_WORDS, businessRulesDescription } from '../connectors/businessWords.ts';
import { businessTools, toolState } from '../connectors/catalog.ts';
import { defaultRow } from './defaultRow.ts';
import { toolFallback, toolRuleRows } from './hub.ts';

import './BusinessJobs.css';

/** The Desk's own jobs, with the same read-only rule rows and fallback as All rules. */
export function BusinessJobs({ view, people }: { view: RulesView; people: PeopleOut | null }) {
  const business = businessTools(view.tools);
  const jobs = view.tools.flatMap((row) => {
    if (row.source !== 'business' || !Array.isArray(row.effects)
      || !row.effects.every((effect) => ['read', 'private_data', 'change', 'charge', 'pay_out', 'send_message'].includes(effect))) return [];
    const def = business.get(row.tool);
    const state = toolState(row);
    if (def === undefined || (state !== 'on' && state !== 'changed')) return [];
    const description = businessRulesDescription(def);
    return description === null ? [] : [{ row, def, description }];
  });
  if (jobs.length === 0) return null;

  return (
    <section className="cd-business-jobs" aria-label={BUSINESS_WORDS.jobs}>
      <h2 className="cd-business-jobs__title cd-type-section">{BUSINESS_WORDS.jobs}</h2>
      {jobs.map(({ row, def, description }) => {
        const rules = toolRuleRows(row, view.active, people, view.tools);
        return (
          <ToolRulesCard
            key={row.tool}
            label={def.title}
            tool={{ name: def.title, description }}
            rules={rules.length > 0 ? rules : [defaultRow(row.tool)]}
            fallback={rules.length > 0 && toolFallback(row, view.active)}
          />
        );
      })}
    </section>
  );
}
