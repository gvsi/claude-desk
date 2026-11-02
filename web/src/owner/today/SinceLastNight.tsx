import { useId, type ReactNode, type Ref } from 'react';

import type { BriefingItem, Today } from '../../api/views.ts';
import { Card, EmptyState, SectionHeader, TextLink } from '../../ds/index.ts';
import { formatClock } from '../../lib/format.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { ReadFailed } from '../ReadFailed.tsx';
import { useToday } from '../useDesks.ts';
import { useReadFailure } from '../useReadFailure.ts';
import { BriefingRow, isShown } from './BriefingRow.tsx';
import { sinceLastNightLine } from './sinceLastNightLine.ts';

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

/**
 * The short form's rows: the newest turned-down request, the newest booking, the newest lead or
 * answer, each when there is one. A key the API leaves out, as one from before a kind was renamed
 * would, makes no row rather than breaking the card.
 */
function shortForm(briefing: Today['briefing']): BriefingItem[] {
  const { turned_down: turnedDown, booking, lead_or_answer: leadOrAnswer } = briefing.newest;
  return [turnedDown, booking, leadOrAnswer].filter((item): item is BriefingItem => item != null);
}

export interface SinceLastNightProps {
  /** The section, which takes focus when dismissing Needs you's last request takes Needs you away and no chat is live. */
  sectionRef?: Ref<HTMLElement>;
}

/**
 * The night's one line in Claude's voice, from the briefing's counts, or null when it has nothing
 * to say. Until the API sends the answers there is no line, rather than one that says less.
 */
function nightLine(briefing: Today['briefing']): string | null {
  const { answers } = briefing;
  return answers === undefined ? null : sinceLastNightLine({ ...briefing, answers });
}

/**
 * Today's "Since last night", always shown: its one line, one row of each kind, and "See all {n}"
 * when the night has more than those rows, or a quiet night. Read with Today and polled with it.
 */
export function SinceLastNight({ sectionRef }: SinceLastNightProps) {
  const { desk } = useOwnerDesk();
  const deskId = desk.desk_id;
  const today = useToday(deskId, { retryOnMount: false });
  const failure = useReadFailure(today, { pausedRoute: 'today' });
  const titleId = useId();
  const briefing = today.data?.briefing;
  const replayed = today.data?.recorded_history?.briefing === true;
  const rows = briefing ? shortForm(briefing).filter(isShown) : [];

  let body;
  if (briefing === undefined) {
    body = failure !== null ? (
      <ReadFailed failure={failure} />
    ) : (
      <p className="cd-today__loading cd-type-meta" role="status">
        Reading what happened since last night
      </p>
    );
  } else if (briefing.total === 0) {
    body = <QuietNight since={briefing.since} />;
  } else {
    const line = nightLine(briefing);
    body = (
      <>
        {line !== null ? <p className="cd-since__line cd-type-summary">{line}</p> : null}
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
