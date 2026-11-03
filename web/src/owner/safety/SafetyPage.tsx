import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import type { LedgerPage } from '../../api/contracts.ts';
import { request } from '../../api/http.ts';
import { pollMs } from '../../app/poll.ts';
import { AttemptRow, Button, ChainStatus, Chip, EmptyState, PageHeader, SegmentedControl, SkeletonScreen, StatusLabel } from '../../ds/index.ts';
import { formatWhen } from '../../lib/format.ts';
import { inApp, useDocumentTitle } from '../../lib/useDocumentTitle.ts';
import { customerLink } from '../customerLink.ts';
import { followInAppLinks } from '../inAppLinks.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { ReadFailed } from '../ReadFailed.tsx';
import { heldOldestFirst, useNeedsYou, useToday } from '../useDesks.ts';
import { requestPath } from '../today/requestLink.ts';
import { useReadFailure, type ReadFailure } from '../useReadFailure.ts';
import { AttemptDetail } from './AttemptDetail.tsx';
import {
  CATEGORY_LABELS,
  NOT_SORTED,
  SAFETY_SUBTITLE,
  anythingStoppedIn,
  anythingTurnedDownIn,
  attemptTime,
  categoryLabel,
  heldForYou,
  originCopy,
  rowLabel,
  stoppedBy,
  triageOf,
  turnedDownHeadline,
} from './copy.ts';
import { attemptsQuery, ledgerQuery } from './queries.ts';
import { SIDE_BY_SIDE } from './focusTrace.ts';
import { RecordList } from './RecordList.tsx';

import { SafetySkeleton } from './SafetySkeleton.tsx';

import './Safety.css';

const TITLE = 'Safety';

type SafetyView = 'attempts' | 'entries';

const VIEWS = [
  { value: 'attempts', label: 'Stopped' },
  { value: 'entries', label: 'Every entry' },
] as const satisfies readonly { value: SafetyView; label: string }[];

/** The Desk's signed record with the checkpoint's check of its chain, polled. */
export function useLedger(deskId: string) {
  return useQuery({ ...ledgerQuery(deskId), refetchInterval: pollMs('safety') });
}

/** The health read also shapes the check line's development-key paragraph. */
function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: () => request('health') });
}

/** The Desk's stopped attempts, newest first as the API lists them, polled. */
function useAttempts(deskId: string) {
  return useQuery({ ...attemptsQuery(deskId), refetchInterval: pollMs('safety') });
}

/** An attempt's page under the Desk, which opens it beside the list. */
export function attemptPath(deskId: string, refId: string): string {
  return `/app/${encodeURIComponent(deskId)}/safety/${encodeURIComponent(refId)}`;
}

/**
 * One line for several failed reads: the first one's words, busy while any of them reads again, and
 * "Try again" reads each of them again. Null when none failed.
 */
function anyFailed(...failures: (ReadFailure | null)[]): ReadFailure | null {
  const failed = failures.filter((f): f is ReadFailure => f !== null);
  const [first] = failed;
  if (first === undefined) return null;
  return { line: first.line, retrying: failed.some((f) => f.retrying), retry: () => failed.forEach((f) => f.retry()) };
}

/**
 * This week's count of the requests the kernel refused, in Claude's voice: the figure Today's
 * "Last 7 days" shows. With none, it says so only once the attempts say no request was refused
 * this week either, and only while neither read has failed since it last worked, so an earlier
 * read never passes for current. Claude's own stopped drafts are no request anyone made, so with
 * them alone none were turned down, and the list below has the drafts. With nothing stopped at
 * all, under the same conditions, what will show up here and how to see one follow. A failed read
 * of the count or of the attempts says so first, in either view, since "Every entry" has no list
 * of the attempts to say it over.
 */
function Headline({ deskId, slug }: { deskId: string; slug: string }) {
  const today = useToday(deskId);
  const safety = useAttempts(deskId);
  const todayFailure = useReadFailure(today, { pausedRoute: 'today' });
  const attemptsFailure = useReadFailure(safety, { pausedRoute: 'safety' });
  const failure = anyFailed(todayFailure, attemptsFailure);
  const week = today.data?.this_week;
  const attempts = safety.data;
  // Both reads in, and neither failed since it last worked: a count of none can be said.
  const current = week !== undefined && attempts !== undefined && failure === null;
  let shown: ReactNode = null;
  if (week !== undefined && week.stopped > 0) {
    shown = <p className="cd-safety__headline cd-type-summary">{turnedDownHeadline(week.stopped)}</p>;
  } else if (current && !anythingTurnedDownIn(attempts, week)) {
    shown = <p className="cd-safety__headline cd-type-summary">{turnedDownHeadline(0)}</p>;
  }
  let empty: ReactNode = null;
  if (current && week.stopped === 0 && !anythingStoppedIn(attempts, week)) {
    empty = (
      <EmptyState
        body="When a request is turned down or a reply is stopped, you'll see here what was asked and why. Try it yourself from your public page."
        action={
          <Button variant="secondary" href={customerLink(slug, deskId)} external>
            Open your public page
          </Button>
        }
      />
    );
  }
  return (
    <>
      <ReadFailed failure={failure} />
      {shown}
      {empty}
    </>
  );
}

/** Requests held for the owner right now, opening the oldest one's conversation. */
function HeldForYou({ deskId }: { deskId: string }) {
  const needsYou = useNeedsYou(deskId);
  const held = heldOldestFirst(needsYou.data ?? []);
  const first = held[0];
  if (first === undefined) return null;
  return (
    <Button variant="secondary" href={requestPath(deskId, first.decision.decision_id, first.session)}>
      <StatusLabel tone="held">{heldForYou(held.length)}</StatusLabel>
    </Button>
  );
}

/** "All" first, then each category's words once, then "Not sorted yet". */
const ALL = 'All';
const FILTERS: readonly string[] = [ALL, ...CATEGORY_LABELS, NOT_SORTED];

/** The filters over the attempts: one chosen at a time, "All" until the owner picks another. */
function Filters({ chosen, onChoose }: { chosen: string; onChoose: (filter: string) => void }) {
  return (
    <div className="cd-attempts__filters" role="group" aria-label="Show by kind">
      {FILTERS.map((filter) => (
        <Chip key={filter} selected={filter === chosen} onClick={() => onChoose(filter)}>
          {filter}
        </Chip>
      ))}
    </div>
  );
}

/** From this width the open attempt sits beside the list (Safety.css); under it, under the list. */
const BESIDE = SIDE_BY_SIDE;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * Moves the owner to the attempt they picked: the focus, so a keyboard or screen reader user lands
 * on it, and the window, since under 1280 px it opens under the list, often past the window's edge.
 * Beside the list it only scrolls when the attempt is out of view.
 */
function moveToOpened(opened: HTMLElement): void {
  opened.focus({ preventScroll: true });
  opened.scrollIntoView({
    block: window.matchMedia(BESIDE).matches ? 'nearest' : 'start',
    behavior: window.matchMedia(REDUCED_MOTION).matches ? 'auto' : 'smooth',
  });
}

interface AttemptsViewProps {
  deskId: string;
  /** The attempt the address opens, if it names one. */
  refId: string | undefined;
  page: LedgerPage | undefined;
  devKey: boolean;
  timezone: string;
}

/**
 * The attempts, each a link that opens it beside the list, a refused request's row saying why it
 * was turned down when the API gave a cause: the one the address names, else the newest. With
 * none, the list is left out: the empty state above already says nothing was stopped. A failed
 * read is said above, beside the headline (`Headline`), over the attempts read before, and
 * with nothing read yet it takes the place of "Reading what was stopped".
 */
function AttemptsView({ deskId, refId, page, devKey, timezone }: AttemptsViewProps) {
  const safety = useAttempts(deskId);
  const failure = useReadFailure(safety, { pausedRoute: 'safety' });
  const [filter, setFilter] = useState(ALL);
  // The row the owner last picked. The attempt open on arrival, or after a filter, leaves the
  // focus where it is; a picked one takes it once its address has opened it.
  const [picked, setPicked] = useState<{ refId: string } | null>(null);
  const movedFor = useRef<{ refId: string } | null>(null);
  const opened = useRef<HTMLDivElement>(null);

  const attempts = safety.data ?? [];
  const shown = filter === ALL ? attempts : attempts.filter((a) => categoryLabel(a) === filter);
  const open = refId === undefined ? (shown[0] ?? null) : (attempts.find((a) => a.ref_id === refId) ?? null);
  const openId = open?.ref_id ?? null;

  useEffect(() => {
    if (picked === null || movedFor.current === picked || picked.refId !== openId || opened.current === null) return;
    movedFor.current = picked;
    moveToOpened(opened.current);
  }, [picked, openId]);

  if (safety.data === undefined) {
    return failure !== null ? null : (
      <p className="cd-safety__loading cd-type-meta" role="status">
        Reading what was stopped
      </p>
    );
  }
  if (attempts.length === 0) return null;
  const now = new Date();

  return (
    <div className="cd-safety__split">
      <div className="cd-attempts">
        <Filters chosen={filter} onChoose={setFilter} />
        {shown.length === 0 ? (
          <p className="cd-safety__hint cd-type-meta">Nothing of this kind. Choose All to see the rest.</p>
        ) : (
          <ul className="cd-attempts__list" aria-label="Stopped, newest first">
            {shown.map((a) => (
              // The row's link opens the attempt through the page's in-app links; this only notes the pick.
              <li key={a.ref_id} onClick={() => setPicked({ refId: a.ref_id })}>
                <AttemptRow
                  time={formatWhen(attemptTime(a, page), timezone, now)}
                  why={rowLabel(a) ?? undefined}
                  title={triageOf(a)?.summary ?? a.reason_plain}
                  who={originCopy(a.origin)}
                  stoppedBy={stoppedBy(a)}
                  href={attemptPath(deskId, a.ref_id)}
                  current={a.ref_id === open?.ref_id}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="cd-safety__beside">
        {open !== null ? (
          <div ref={opened} className="cd-safety__opened" tabIndex={-1}>
            <AttemptDetail key={open.ref_id} attempt={open} page={page} devKey={devKey} deskId={deskId} timezone={timezone} />
          </div>
        ) : refId !== undefined ? (
          <EmptyState title="This one isn't in the list" body="It may be from an earlier copy of this Desk. Choose one from the list to see how it was stopped." />
        ) : null}
      </div>
    </div>
  );
}

/**
 * `/app/:deskId/safety` and `/app/:deskId/safety/:refId`: this week's stopped attempts and the
 * signed record they are kept in. The header has the count, what is held for the owner, and the
 * record's check; then the attempts, each with what stopped it, or every entry of the record
 * (`?view=entries`), each opening its full trace.
 */
export function SafetyPage() {
  const { business, desk } = useOwnerDesk();
  // With an attempt open beside the list too.
  useDocumentTitle(inApp(TITLE));
  const deskId = desk.desk_id;
  const navigate = useNavigate();
  const { refId } = useParams();
  const [params, setParams] = useSearchParams();
  const view: SafetyView = params.get('view') === 'entries' ? 'entries' : 'attempts';
  const ledger = useLedger(deskId);
  const ledgerFailure = useReadFailure(ledger, { pausedRoute: 'ledger' });
  const health = useHealth();
  const healthFailure = useReadFailure(health, { pausedRoute: 'health' });
  const devKey = health.data?.kernel?.dev_signing_key ?? false;
  // Keep every first-view read mounted in either view. Switching back reuses the attempts.
  const attempts = useAttempts(deskId);
  const today = useToday(deskId);
  const settled = [ledger, health, attempts, today].every((read) => read.isFetched || read.isPaused);
  // Once either view has shown the real region, keep its control mounted. This also retains
  // paused-read errors across reconnect while reads with no data start for the first time.
  const [hasShownRegion, setHasShownRegion] = useState(settled || view === 'entries');
  if ((settled || view === 'entries') && !hasShownRegion) setHasShownRegion(true);
  const ready = settled || hasShownRegion;

  const changeView = (next: SafetyView) => {
    setParams(
      (current) => {
        const out = new URLSearchParams(current);
        if (next === 'entries') out.set('view', 'entries');
        else out.delete('view');
        return out;
      },
      { replace: true },
    );
  };

  return (
    <div className="cd-safety" onClick={followInAppLinks(navigate)}>
      <PageHeader title={TITLE} subtitle={SAFETY_SUBTITLE} actions={<HeldForYou deskId={deskId} />} />
      <SkeletonScreen loading={view === 'attempts' && !ready} status="Reading what was stopped" skeleton={<SafetySkeleton withHeader={false} />} className="cd-safety__region">
        <Headline deskId={deskId} slug={desk.slug} />
        <div className="cd-safety__bar">
          {/* A failed read of the record says so first, beside the check it last made, which the
              record's entries below also come from. */}
          <div className="cd-safety__chain">
            <ReadFailed failure={ledgerFailure} />
            <ReadFailed failure={healthFailure} />
            {ledger.data ? (
              <ChainStatus chainOk={ledger.data.chain_ok} firstBadSeq={ledger.data.first_bad_seq} entries={ledger.data.entries.length} devKey={devKey} />
            ) : ledgerFailure === null ? (
              <p className="cd-safety__loading cd-type-meta" role="status">
                Checking the record
              </p>
            ) : null}
          </div>
          <SegmentedControl label="What to show" options={VIEWS} value={view} onChange={changeView} />
        </div>
        {view === 'entries' ? (
          ledger.data ? (
            <RecordList page={ledger.data} devKey={devKey} timezone={business.timezone} />
          ) : null
        ) : (
          <AttemptsView deskId={deskId} refId={refId} page={ledger.data} devKey={devKey} timezone={business.timezone} />
        )}
      </SkeletonScreen>
    </div>
  );
}
