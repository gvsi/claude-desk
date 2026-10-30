import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { ApiError, isUncertain, request } from '../api/http.ts';
import type { CopyOut } from '../api/views.ts';
import type { SessionEndedState } from '../app/providers.tsx';
import { IntroDialog, type IntroErrorCode } from '../ds/index.ts';
import { THINGS_TO_TRY } from './arrival/ideas.ts';
import { TodayPreview } from './arrival/TodayPreview.tsx';
import { DESKS_KEY, invalidateCopy, lastOrFirst, readTodayAhead, todayPath } from './useDesks.ts';

const TITLE = 'A Claude front desk for your business';
const INTRO =
  'You’re Maria Rivera today, owner of Rivera Plumbing. Her Desk answers customers and their agents under her rules. Try it, then try to break it.';
const SESSION_ENDED = 'Your demo session ended. Enter the passcode to start a fresh copy.';
/** How long the dialog waits for the new copy's Today before it opens anyway, still loading. */
const READ_AHEAD_MS = 3_000;

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
 * `/`, the first visit (spec "First visit and hosting"): a still preview of Rivera's Today at once,
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
  // One `me` per visit, kept across a development remount, so the page asks once.
  const asked = useRef<Promise<CopyOut> | null>(null);
  // Whether this page is still shown: the owner may leave it while Today is read ahead.
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    asked.current ??= request('me');
    asked.current.then(
      async (copy) => {
        if (!live) return;
        // The last Desk opened when it is still the copy's, else its first.
        const deskId = lastOrFirst(copy.desks);
        if (deskId === null) {
          setOpen(true);
          return;
        }
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
   * The new copy's first Today, which takes the dialog away. The dialog stays up, busy over the
   * preview, until Today is read ahead, so it closes onto the page already drawn.
   */
  const openCopy = async (copy: CopyOut): Promise<boolean> => {
    const first = copy.desks[0];
    if (!first) return false;
    await invalidateCopy(queryClient);
    await readAhead(queryClient, first.desk_id);
    if (shown.current) void navigate(todayPath(first.desk_id), { replace: true });
    return true;
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
      <TodayPreview />
      {open ? (
        <IntroDialog
          title={TITLE}
          intro={ended ? `${SESSION_ENDED} ${INTRO}` : INTRO}
          thingsToTry={THINGS_TO_TRY.map(({ title, detail, icon }) => ({ title, detail, icon }))}
          submitLabel="Start the demo"
          onSubmit={onSubmit}
          busy={busy}
          error={error}
        />
      ) : null}
    </>
  );
}
