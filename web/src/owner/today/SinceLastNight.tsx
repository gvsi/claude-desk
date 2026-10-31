import { useId, type ReactNode, type Ref } from 'react';

import { ownerErrorCopy } from '../../api/http.ts';
import type { BriefingItem, Today } from '../../api/views.ts';
import { Button, Card, EmptyState, Notice, SectionHeader, TextLink } from '../../ds/index.ts';
import { formatClock } from '../../lib/format.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { useToday } from '../useDesks.ts';
import { BriefingRow, isShown } from './BriefingRow.tsx';

/** The full briefing's page under the Desk. */
export function briefingPath(deskId: string): string {
  return `/app/${encodeURIComponent(deskId)}/today/briefing`;
}

/** Safety's every-entry view, where each replayed entry says so. */
export function entriesPath(deskId: string): string {
  return `/app/${encodeURIComponent(deskId)}/safety?view=entries`;
}

/**
 * A quiet caption link beside a figure that counts replayed rows: "Includes recorded history", to
 * the record, where each replayed entry says "Recorded history, replayed into your copy".
 */
export function RecordedHistoryLink({ deskId }: { deskId: string }) {
  return (
    <a className="cd-today-caption-link cd-type-caption" href={entriesPath(deskId)}>
      Includes recorded history
    </a>
  );
}

export interface BriefingRowsProps {
  items: readonly BriefingItem[];
  /** The list's name, when the heading above it doesn't name it. */
  label?: string;
}

/** Briefing rows in the order given, divided by hairlines. */
export function BriefingRows({ items, label }: BriefingRowsProps) {
  return (
    <ul className="cd-briefing" aria-label={label}>
      {items.filter(isShown).map((item) => (
        <li key={`${item.kind}:${item.ref_id}`} className="cd-briefing__item">
          <BriefingRow item={item} />
        </li>
      ))}
    </ul>
  );
}

/** The night with nothing new, from when the briefing starts. */
export function QuietNight({ since, action }: { since: string; action?: ReactNode }) {
  const { business } = useOwnerDesk();
  return <EmptyState title="A quiet night" body={`Nothing new since ${formatClock(since, business.timezone)} yesterday.`} action={action} />;
}

/** The short form's rows: the newest blocked attempt, the newest booking, the newest lead or answer, each when there is one. */
function shortForm(briefing: Today['briefing']): BriefingItem[] {
  const { blocked, booking, lead_or_answer: leadOrAnswer } = briefing.newest;
  return [blocked, booking, leadOrAnswer].filter((item): item is BriefingItem => item !== null);
}

export interface SinceLastNightProps {
  /** The section, which takes focus when dismissing Needs you's last request takes Needs you away and no chat is live. */
  sectionRef?: Ref<HTMLElement>;
}

/**
 * Today's "Since last night", always shown: one row of each kind, and "See all {n}" when the night
 * has more than those rows, or a quiet night. Read with Today and polled with it.
 */
export function SinceLastNight({ sectionRef }: SinceLastNightProps) {
  const { desk } = useOwnerDesk();
  const deskId = desk.desk_id;
  const today = useToday(deskId, { retryOnMount: false });
  const titleId = useId();
  const briefing = today.data?.briefing;
  const replayed = today.data?.recorded_history?.briefing === true;
  const rows = briefing ? shortForm(briefing).filter(isShown) : [];

  let body;
  if (briefing === undefined) {
    body = today.isError ? (
      <Notice
        tone="error"
        action={
          <Button variant="secondary" onClick={() => void today.refetch()}>
            Try again
          </Button>
        }
      >
        {ownerErrorCopy(today.error)}
      </Notice>
    ) : (
      <p className="cd-today__loading cd-type-meta" role="status">
        Reading what happened since last night
      </p>
    );
  } else if (briefing.total === 0) {
    body = <QuietNight since={briefing.since} />;
  } else {
    body = (
      <>
        {rows.length > 0 ? <BriefingRows items={rows} /> : null}
        {briefing.total > rows.length ? (
          <div className="cd-since__all cd-type-meta">
            <TextLink href={briefingPath(deskId)}>See all {briefing.total}</TextLink>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <section ref={sectionRef} className="cd-today__section" aria-labelledby={titleId} tabIndex={-1}>
      <SectionHeader id={titleId} title="Since last night" caption={replayed ? <RecordedHistoryLink deskId={deskId} /> : undefined} />
      <Card>{body}</Card>
    </section>
  );
}
