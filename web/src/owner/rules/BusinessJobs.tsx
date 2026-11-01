import type { PeopleOut, RulesView } from '../../api/views.ts';
import { ToolRulesCard } from '../../ds/index.ts';
import { BUSINESS_WORDS, businessOwnerLine, businessRulesDescription } from '../connectors/businessWords.ts';
import { businessTools, isBusinessToolName, toolDisplayName, toolState } from '../connectors/catalog.ts';
import { defaultRow } from './defaultRow.ts';
import { toolFallback, toolRuleRows } from './hub.ts';

import './BusinessJobs.css';

/**
 * The Desk's own jobs, with the same read-only rule rows and fallback as All rules. On Rules,
 * `landed` gives each job a confirmed change landed on since the owner opened the page.
 */
export function BusinessJobs({ view, people, landed }: { view: RulesView; people: PeopleOut | null; landed?: ReadonlyMap<string, number> }) {
  const business = businessTools(view.tools);
  const jobs = view.tools.flatMap((row) => {
    if (row.source !== 'business' || !isBusinessToolName(row.tool) || !Array.isArray(row.effects)
      || !row.effects.every((effect) => ['read', 'private_data', 'change', 'charge', 'pay_out', 'send_message'].includes(effect))) return [];
    const state = toolState(row);
    if (state !== 'on' && state !== 'changed') return [];
    const name = toolDisplayName(row.tool, business) ?? 'A connected tool';
    const description = businessRulesDescription(row.business) ?? businessOwnerLine(row.business?.config) ?? '';
    return [{ row, name, description }];
  });
  if (jobs.length === 0) return null;

  return (
    <section className="cd-business-jobs" aria-label={BUSINESS_WORDS.jobs}>
      <h2 className="cd-business-jobs__title cd-type-section">{BUSINESS_WORDS.jobs}</h2>
      {jobs.map(({ row, name, description }) => {
        const rules = toolRuleRows(row, view.active, people, view.tools);
        const at = landed?.get(row.tool);
        return (
          <ToolRulesCard
            key={row.tool}
            label={name}
            tool={{ name, description }}
            rules={rules.length > 0 ? rules : [defaultRow(row.tool)]}
            fallback={rules.length > 0 && toolFallback(row, view.active)}
            {...(at === undefined ? {} : { landed: at })}
          />
        );
      })}
    </section>
  );
}
