import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { ApiError, isUncertain, request } from '../api/http.ts';
import type { CopyOut } from '../api/views.ts';
import type { SessionEndedState } from '../app/providers.tsx';
import { useLeavingSignal } from '../app/useLeavingSignal.ts';
import { IntroDialog, type IntroErrorCode } from '../ds/index.ts';
import { INTRO_THINGS } from './arrival/ideas.ts';
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
  // Settles when the owner comes back to this page before it has gone, for what waited for them.
  const back = useRef<{ promise: Promise<void>; settle: () => void } | null>(null);
  // Aborted once the owner leaves the page, which may be while Today is read ahead or the passcode
  // is tried, before the page they went to has drawn and this one has gone.
  const leaving = useLeavingSignal(() => {
    back.current?.settle();
    back.current = null;
  });
  /**
   * Settles once the owner is on this page: at once while they are, or when they come back to it
   * (with Back, say) before it has gone. While they are away the page does nothing more, and once
   * it has gone it never carries on: its reads belong to the page they went to.
   */
  const onThisPage = useCallback(async (): Promise<void> => {
    while (leaving().aborted) {
      if (back.current === null) {
        let settle = () => {};
        const promise = new Promise<void>((resolve) => {
          settle = resolve;
        });
        back.current = { promise, settle };
      }
      await back.current.promise;
    }
  }, [leaving]);
  // The Desk whose Today this page has read ahead, if any. Left before that Today opened, the page
  // forgets the read ahead, so a later Today of that Desk isn't taken for this visit's.
  const readAheadFor = useRef<string | null>(null);
  useEffect(() => {
    return () => {
      if (readAheadFor.current !== null) forgetReadAhead(queryClient, readAheadFor.current);
    };
  }, [queryClient]);

  useEffect(() => {
    let live = true;
    asked.current ??= request('me');
    asked.current.then(
      async (copy) => {
        // Away from this page, nothing more: its reads, Desks included, belong to the page the
        // owner went to.
        await onThisPage();
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
        await onThisPage();
        if (live) void navigate(todayPath(deskId), { replace: true });
      },
      async () => {
        await onThisPage();
        if (live) setOpen(true);
      },
    );
    return () => {
      live = false;
    };
  }, [navigate, onThisPage, queryClient]);

  /**
   * The new copy's first Today, which takes the dialog away, called as the copy answers. The preview
   * is drawn again from that moment, the closest this page can read to when the copy opened. The
   * dialog stays up, busy over the preview, until Today is read ahead; then it leaves, and Today
   * opens once it has closed, already drawn. While the owner is away from this page it waits, and
   * the reads are left to the page they went to, which already shows them: dropping its Desks would
   * leave it watching a read nothing updates. Back before this page has gone, it carries on where it
   * stopped, with the preview still dated from when the copy answered.
   */
  const openCopy = async (copy: CopyOut): Promise<boolean> => {
    // Read before any wait for the owner, so a copy made while they were away is dated from then.
    const answeredAt = Date.now();
    await onThisPage();
    const first = copy.desks[0];
    if (!first) return false;
    setOpenedAt(answeredAt);
    await dropTheOldInbox(queryClient);
    await invalidateCopy(queryClient);
    await onThisPage();
    readAheadFor.current = first.desk_id;
    await readAhead(queryClient, first.desk_id);
    await onThisPage();
    setLeavingTo(first.desk_id);
    return true;
  };

  /** The dialog has left: on to the Today it left onto, once the owner is on this page. */
  const onClosed = () => {
    if (leavingTo === null) return;
    const deskId = leavingTo;
    void onThisPage().then(() => navigate(todayPath(deskId), { replace: true }));
  };

  const onSubmit = async (passcode: string): Promise<void> => {
    // Nothing is sent once the owner has left, even while this page is still on screen.
    if (leaving().aborted) return;
    setBusy(true);
    setError(undefined);
    try {
      const copy = await request('copies', { body: { passcode } });
      if (!(await openCopy(copy))) setError('unreachable');
    } catch (err) {
      await onThisPage();
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
          thingsToTry={[...INTRO_THINGS]}
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
