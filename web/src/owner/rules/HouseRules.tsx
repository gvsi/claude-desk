import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';

import { ownerErrorCopy } from '../../api/http.ts';
import type { PeopleOut, RulesView } from '../../api/views.ts';
import { pollMs } from '../../app/poll.ts';
import {
  AlwaysOnList,
  Breadcrumb,
  Button,
  ConnectorName,
  LoadingLine,
  Notice,
  PageHeader,
  ToolRulesCard,
} from '../../ds/index.ts';
import { inApp, useDocumentTitle } from '../../lib/useDocumentTitle.ts';
import { connectorPageHref } from '../connectors/pages.ts';
import { followInAppLinks } from '../inAppLinks.ts';
import { RouterLink, useOwnerDesk } from '../OwnerLayout.tsx';
import { deskPath } from '../useDesks.ts';
import { useReadFailure } from '../useReadFailure.ts';
import { BusinessJobs } from './BusinessJobs.tsx';
import { REVIEWER_LINE } from './copy.ts';
import { defaultRow } from './defaultRow.ts';
import { hubSections, toolFallback, toolRuleRows, type HubSection } from './hub.ts';
import { peopleQuery, rulesQuery } from './RuleDraftReview.tsx';
import { RULES_TITLE } from './RulesPage.tsx';

import './HouseRules.css';

const TITLE = 'All rules';

/**
 * One connector's tools, each with every rule that governs it, read-only; each tool's name and line
 * link to its page once the Connectors pages are built (`connectorPageHref`).
 */
function ConnectorRules({ deskId, section, view, people }: { deskId: string; section: HubSection; view: RulesView; people: PeopleOut | null }) {
  return (
    <section className="cd-house-rules__connector" aria-label={section.connector.name}>
      <ConnectorName connector={section.connector} size="section" level={2} hideBuiltIn />
      {section.tools.map((tool) => {
        const row = view.tools.find((r) => r.tool === tool.key);
        if (row === undefined) return null;
        const rules = toolRuleRows(row, view.active, people, view.tools);
        return (
          <ToolRulesCard
            key={tool.key}
            label={tool.name}
            tool={{ name: tool.name, description: tool.description, href: connectorPageHref(deskId, tool.href) }}
            rules={rules.length > 0 ? rules : [defaultRow(tool.key)]}
            fallback={rules.length > 0 && toolFallback(row, view.active)}
            linkComponent={RouterLink}
          />
        );
      })}
    </section>
  );
}

/**
 * `rules/all`: every rule on the Desk, by connector and tool, each in its words with its outcome
 * ("Automatic", "Ask me first", "Never"), read-only; a tool no rule covers says it asks. Then the
 * always-on rules. Changing a rule is asking Claude, on Rules or a tool's page.
 */
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
        <BusinessJobs view={view} people={people.data ?? null} />
        {hubSections(view, people.data ?? null).map((section) => (
          <ConnectorRules key={section.connector.id} deskId={deskId} section={section} view={view} people={people.data ?? null} />
        ))}
      </>
    );
  }

  return (
    <div className="cd-house-rules" onClick={followInAppLinks(navigate)}>
      <div className="cd-house-rules__header">
        <Breadcrumb items={[{ label: RULES_TITLE, href: `${deskPath(deskId)}/rules` }, { label: TITLE }]} linkComponent={RouterLink} />
        <PageHeader title={TITLE} subtitle="Every rule on this Desk, by connector and tool. To change one, ask Claude on Rules." note={REVIEWER_LINE} />
      </div>
      {body}
      <AlwaysOnList />
    </div>
  );
}
