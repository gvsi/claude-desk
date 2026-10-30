import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import type { LedgerPage } from '../../api/contracts.ts';
import { ownerErrorCopy, request } from '../../api/http.ts';
import { pollMs } from '../../app/poll.ts';
import { AttemptRow, Button, ChainStatus, Chip, EmptyState, Notice, PageHeader, SegmentedControl, StatusDot } from '../../ds/index.ts';
import { formatWhen } from '../../lib/format.ts';
import { customerLink } from '../customerLink.ts';
import { followInAppLinks } from '../inAppLinks.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { heldOldestFirst, todayPath, useNeedsYou, useToday } from '../useDesks.ts';
import { AttemptDetail } from './AttemptDetail.tsx';
import { CATEGORY_LABELS, NOT_SORTED, attemptTime, categoryLabel, originCopy, stoppedBy, stoppedHeadline, triageOf } from './copy.ts';
import { RecordList } from './RecordList.tsx';

import './Safety.css';

type SafetyView = 'attempts' | 'entries';

const VIEWS = [
  { value: 'attempts', label: 'Attempts' },
  { value: 'entries', label: 'Every entry' },
] as const satisfies readonly { value: SafetyView; label: string }[];

/** The Desk's signed record with the checkpoint's check of its chain, polled. */
export function useLedger(deskId: string) {
  return useQuery({
    queryKey: ['ledger', deskId],
    queryFn: () => request('ledger', { params: { desk_id: deskId }, query: { verify: true } }),
    refetchInterval: pollMs('safety'),
  });
}

/** Whether the checkpoint signs with the development key; false until it says so. */
function useDevKey(): boolean {
  const health = useQuery({ queryKey: ['health'], queryFn: () => request('health') });
  return health.data?.kernel?.dev_signing_key ?? false;
}

/** The Desk's stopped attempts, newest first as the API lists them, polled. */
function useAttempts(deskId: string) {
  return useQuery({
    queryKey: ['safety', deskId],
    queryFn: () => request('safety', { params: { desk_id: deskId } }),
    refetchInterval: pollMs('safety'),
  });
}

/** An attempt's page under the Desk, which opens it beside the list. */
export function attemptPath(deskId: string, refId: string): string {
  return `/app/${encodeURIComponent(deskId)}/safety/${encodeURIComponent(refId)}`;
}

/** A failed read, and the way to read it again. */
function ReadFailed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Notice
      tone="error"
      action={
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      {ownerErrorCopy(error)}
    </Notice>
  );
}

/**
 * This week's count of stopped attempts in Claude's voice, the figure Today's "Last 7 days" shows,
 * or, with none, what will show up here and how to see one.
 */
function Headline({ deskId, slug }: { deskId: string; slug: string }) {
  const today = useToday(deskId);
  const stopped = today.data?.this_week.stopped;
  if (stopped === undefined) {
    return today.isError ? <ReadFailed error={today.error} onRetry={() => void today.refetch()} /> : null;
  }
  if (stopped === 0) {
    return (
      <EmptyState
        title="Nothing stopped this week"
        body="When someone tries to get around your rules, you'll see here what they tried and what stopped it. Try it yourself from your public page."
        action={
          <Button variant="secondary" href={customerLink(slug, deskId)} external>
            Open your public page
          </Button>
        }
      />
    );
  }
  return <p className="cd-safety__headline cd-type-summary">{stoppedHeadline(stopped)}</p>;
}

/** Requests held for the owner right now, a click from Today. */
function HeldForYou({ deskId }: { deskId: string }) {
  const needsYou = useNeedsYou(deskId);
  const held = heldOldestFirst(needsYou.data ?? []).length;
  if (held === 0) return null;
  return (
    <Button variant="secondary" href={todayPath(deskId)}>
      <StatusDot tone="held" />
      {held} held for you
    </Button>
  );
}

/** "All" first, then each category's words once, then "Not sorted yet". */
const ALL = 'All';
const FILTERS: readonly string[] = [ALL, ...CATEGORY_LABELS, NOT_SORTED];

/** The filters over the attempts: one chosen at a time, "All" until the owner picks another. */
function Filters({ chosen, onChoose }: { chosen: string; onChoose: (filter: string) => void }) {
  return (
    <div className="cd-attempts__filters" role="group" aria-label="Show attempts">
      {FILTERS.map((filter) => (
        <Chip key={filter} selected={filter === chosen} onClick={() => onChoose(filter)}>
          {filter}
        </Chip>
      ))}
    </div>
  );
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
 * The attempts, each a link that opens it beside the list: the one the address names, else the
 * newest. With none, the list is left out: the headline above already says nothing was stopped.
 */
function AttemptsView({ deskId, refId, page, devKey, timezone }: AttemptsViewProps) {
  const safety = useAttempts(deskId);
  const [filter, setFilter] = useState(ALL);
  if (safety.data === undefined) {
    return safety.isError ? (
      <ReadFailed error={safety.error} onRetry={() => void safety.refetch()} />
    ) : (
      <p className="cd-safety__loading cd-type-meta" role="status">
        Reading the attempts
      </p>
    );
  }
  const attempts = safety.data;
  if (attempts.length === 0) return null;
  const shown = filter === ALL ? attempts : attempts.filter((a) => categoryLabel(a) === filter);
  const open = refId === undefined ? (shown[0] ?? null) : (attempts.find((a) => a.ref_id === refId) ?? null);
  const now = new Date();

  return (
    <div className="cd-safety__split">
      <div className="cd-attempts">
        <Filters chosen={filter} onChoose={setFilter} />
        {shown.length === 0 ? (
          <p className="cd-safety__hint cd-type-meta">No attempts of this kind. Choose All to see every attempt.</p>
        ) : (
          <ul className="cd-attempts__list" aria-label="Attempts, newest first">
            {shown.map((a) => (
              <li key={a.ref_id}>
                <AttemptRow
                  time={formatWhen(attemptTime(a, page), timezone, now)}
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
          <AttemptDetail key={open.ref_id} attempt={open} page={page} devKey={devKey} deskId={deskId} timezone={timezone} />
        ) : refId !== undefined ? (
          <EmptyState title="This attempt isn't in the list" body="It may be from an earlier copy of this Desk. Choose one from the list to see how it was stopped." />
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
  const deskId = desk.desk_id;
  const navigate = useNavigate();
  const { refId } = useParams();
  const [params, setParams] = useSearchParams();
  const view: SafetyView = params.get('view') === 'entries' ? 'entries' : 'attempts';
  const ledger = useLedger(deskId);
  const devKey = useDevKey();

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
      <PageHeader title="Safety" actions={<HeldForYou deskId={deskId} />} />
      <Headline deskId={deskId} slug={desk.slug} />
      <div className="cd-safety__bar">
        <div className="cd-safety__chain">
          {ledger.data ? (
            <ChainStatus chainOk={ledger.data.chain_ok} firstBadSeq={ledger.data.first_bad_seq} entries={ledger.data.entries.length} devKey={devKey} />
          ) : ledger.isError ? (
            <ReadFailed error={ledger.error} onRetry={() => void ledger.refetch()} />
          ) : (
            <p className="cd-safety__loading cd-type-meta" role="status">
              Checking the record
            </p>
          )}
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
    </div>
  );
}
