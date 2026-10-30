import { useId, type ComponentType } from 'react';

import { SectionHeader } from '../SectionHeader/SectionHeader.tsx';
import { StatusLabel, type StatusTone } from '../StatusDot/StatusDot.tsx';
import type { RulesLinkProps } from '../ToolRulesCard/ToolRulesCard.tsx';

import './RecentRequests.css';

/** One request under a tool's rules, in the screen's words. */
export interface RecentRequestView {
  key: string;
  /** When it came in, formatted by the screen: "Today, 9:41 am", "Oct 26". */
  when: string;
  /** What was asked: the decision's `reason_plain`. */
  what: string;
  /** What decided it: the rule ("Held by your rule: …") or what happened ("Refunded to the original payment."). */
  why: string;
  /** The outcome's dot. */
  tone: StatusTone;
  /** The outcome in words: "Automatic", "Waiting for your answer", "Stopped", "You allowed it". */
  outcome: string;
  /** Its Safety record. */
  href?: string;
}

export interface RecentRequestsProps {
  rows: readonly RecentRequestView[];
  /** The app's router link; a plain `<a>` by default. */
  linkComponent?: ComponentType<RulesLinkProps>;
}

function PlainLink({ children, ...props }: RulesLinkProps) {
  return <a {...props}>{children}</a>;
}

/**
 * The requests that came in under a tool's rules, newest first: when, what was asked, what decided
 * it, and the outcome in words with its dot. A row with a record opens it.
 */
export function RecentRequests({ rows, linkComponent: Link = PlainLink }: RecentRequestsProps) {
  const ids = useId();
  const headingId = `${ids}-heading`;
  return (
    <section className="cd-recent-requests" aria-labelledby={headingId}>
      <SectionHeader id={headingId} title="Recent requests under these rules" />
      {rows.length === 0 ? (
        <p className="cd-recent-requests__empty cd-type-body">No requests under these rules yet.</p>
      ) : (
        <ul role="list" className="cd-recent-requests__rows">
          {rows.map((row, index) => {
            const whenId = `${ids}-${index}-when`;
            const whyId = `${ids}-${index}-why`;
            const outcomeId = `${ids}-${index}-outcome`;
            return (
              <li key={row.key} className="cd-recent-requests__row">
                <span id={whenId} className="cd-recent-requests__when cd-type-meta">
                  {row.when}
                </span>
                {row.href !== undefined ? (
                  // The request's words are its link, and the link's overlay covers the row.
                  <Link
                    href={row.href}
                    className="cd-recent-requests__what cd-recent-requests__link cd-type-body"
                    aria-describedby={`${whenId} ${whyId} ${outcomeId}`}
                  >
                    {row.what}
                  </Link>
                ) : (
                  <span className="cd-recent-requests__what cd-type-body">{row.what}</span>
                )}
                <span id={whyId} className="cd-recent-requests__why cd-type-caption">
                  {row.why}
                </span>
                <span id={outcomeId} className="cd-recent-requests__outcome cd-type-meta">
                  <StatusLabel tone={row.tone}>{row.outcome}</StatusLabel>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
