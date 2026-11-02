import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { ApiError, isUncertain, request } from '../api/http.ts';
import type { CopyOut } from '../api/views.ts';
import type { SessionEndedState } from '../app/providers.tsx';
import { IntroDialog, type IntroErrorCode } from '../ds/index.ts';
import { THINGS_TO_TRY } from './arrival/ideas.ts';
import { TodayPreview } from './arrival/TodayPreview.tsx';
import { DESKS_KEY, dropTheOldInbox, forgetReadAhead, invalidateCopy, lastOrFirst, READ_AHEAD_MS, readTodayAhead, todayPath } from './useDesks.ts';

const TITLE = 'A Claude front desk for your business';
const INTRO =
  'You’re Mike Turner today, owner of Turner Plumbing. His Desk answers customers and their agents under his rules. Try it, then try to break it.';
const SESSION_ENDED = 'Your demo session ended. Enter the passcode to start a fresh copy.';

/** What the dialog says when a try fails: a wrong passcode, too many tries, or anything else. */
function introErrorFor(err: unknown): IntroErrorCode {
  if (err instanceof ApiError && err.status === 401) return 'wrong_passcode';
  if (err instanceof ApiError && err.status === 429) return 'rate_limited';
  return 'unreachable';
}

/**
 * Reads ahead what `deskId`'s Today first shows, for up to `READ_AHEAD_MS`, so the page opens onto
 * Today already drawn rather than onto the owner's loading page and then an empty Today. Never from
 * Desks read before: a read ahead that failed would keep them, in error, and Today would show that
 * error until its own read came in, where a first visit shows its loading page.
 */
async function readAhead(queryClient: QueryClient, deskId: string): Promise<void> {
  queryClient.removeQueries({ queryKey: DESKS_KEY });
  await readTodayAhead(queryClient, deskId, READ_AHEAD_MS);
}

/**
 * `/`, the first visit (spec "First visit and hosting"): a still preview of Turner's Today at once,
 * then the copy this browser already has. A copy opens its Today, read ahead, and the dialog never
 * shows; no copy (401), or any other answer, opens the intro dialog over the preview, which only
 * the passcode gets past. After an owner session ends the dialog opens with that news first.
 */
export function Arrival() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const ended = (location.state as Partial<SessionEndedState> | null)?.ended === true;

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<IntroErrorCode | undefined>(undefined);
  // The Desk whose Today, read ahead, the dialog is leaving onto; Today opens once it has closed.
  const [leavingTo, setLeavingTo] = useState<string | null>(null);
  // The copy this browser has is opening: Today is read ahead behind the preview, which assistive
  // technology doesn't see, so a status says so.
  const [opening, setOpening] = useState(false);
  // When the new copy opened, as this page read it the moment the copy answered: the preview is drawn
  // again from it, so the Today the dialog leaves onto has the times and days the preview showed.
  // Until then the preview is dated from when the page was drawn.
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  // One `me` per visit, kept across a development remount, so the page asks once.
  const asked = useRef<Promise<CopyOut> | null>(null);
  // Whether this page is still shown: the owner may leave it while Today is read ahead.
  const shown = useRef(true);
  // The Desk whose Today this page has read ahead, if any. Left before that Today opened, the page
  // forgets the read ahead, so a later Today of that Desk isn't taken for this visit's.
  const readAheadFor = useRef<string | null>(null);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
      if (readAheadFor.current !== null) forgetReadAhead(queryClient, readAheadFor.current);
    };
  }, [queryClient]);

  useEffect(() => {
    let live = true;
    asked.current ??= request('me');
    asked.current.then(
      async (copy) => {
        // Gone from this page: its reads, Desks included, belong to the page the owner went to.
        if (!live) return;
        // The last Desk opened when it is still the copy's, else its first.
        const deskId = lastOrFirst(copy.desks);
        if (deskId === null) {
          setOpen(true);
          return;
        }
        setOpening(true);
        readAheadFor.current = deskId;
        await readAhead(queryClient, deskId);
        if (live) void navigate(todayPath(deskId), { replace: true });
      },
      () => {
        if (live) setOpen(true);
      },
    );
    return () => {
      live = false;
    };
  }, [navigate, queryClient]);

  /**
   * The new copy's first Today, which takes the dialog away, called as the copy answers. The preview
   * is drawn again from that moment, the closest this page can read to when the copy opened. The
   * dialog stays up, busy over the preview, until Today is read ahead; then it leaves, and Today
   * opens once it has closed, already drawn. When the owner has left this page while the copy was
   * made, the reads are left to the page they went to, which already shows them: dropping its Desks
   * would leave it watching a read nothing updates.
   */
  const openCopy = async (copy: CopyOut): Promise<boolean> => {
    const answeredAt = Date.now();
    const first = copy.desks[0];
    if (!first) return false;
    if (!shown.current) return true;
    setOpenedAt(answeredAt);
    await dropTheOldInbox(queryClient);
    await invalidateCopy(queryClient);
    if (!shown.current) return true;
    readAheadFor.current = first.desk_id;
    await readAhead(queryClient, first.desk_id);
    if (shown.current) setLeavingTo(first.desk_id);
    return true;
  };

  /** The dialog has left: on to the Today it left onto, unless the owner has gone elsewhere. */
  const onClosed = () => {
    if (leavingTo !== null && shown.current) void navigate(todayPath(leavingTo), { replace: true });
  };

  const onSubmit = async (passcode: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const copy = await request('copies', { body: { passcode } });
      if (!(await openCopy(copy))) setError('unreachable');
    } catch (err) {
      // A lost answer may still have made the copy: the copy this browser now has says.
      if (isUncertain(err)) {
        const made = await request('me').catch(() => null);
        if (made !== null && (await openCopy(made))) return;
      }
      setError(introErrorFor(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <TodayPreview openedAt={openedAt} />
      {/* There from the start, so the line is announced when it comes. */}
      <p className="cd-sr-only" role="status">
        {opening ? 'Opening your Desk' : null}
      </p>
      {open ? (
        <IntroDialog
          title={TITLE}
          intro={ended ? `${SESSION_ENDED} ${INTRO}` : INTRO}
          thingsToTry={THINGS_TO_TRY.map(({ title, detail, icon }) => ({ title, detail, icon }))}
          submitLabel="Start the demo"
          onSubmit={onSubmit}
          busy={busy}
          error={error}
          leaving={leavingTo !== null}
          onClosed={onClosed}
        />
      ) : null}
    </>
  );
}
