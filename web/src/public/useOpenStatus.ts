/**
 * The header's open status: whether the business is open now, as the kernel last said it.
 *
 * The kernel works the line out from the business's hours on its own clock and writes `text` in
 * the business's time zone and the visitor's language; the page shows it as written. The kernel
 * vouches for `text` until `refresh_at`, so the page asks again then, and when the tab comes back
 * into view. A failed read drops the line (the page can't tell whether `refresh_at` has passed)
 * and tries again at the 30 s floor. Only the header and the about column follow these reads: the
 * chat, its session and its stream are never touched.
 *
 * The browser's clock only runs the timer: nothing here builds a date, formats one or reads the
 * browser's time zone. The status's times are read in one place, `openStatusDelayMs`.
 */
import { useEffect, useState } from 'react';

import type { OpenStatus, PublicDesk } from '../api/contracts.ts';
import { request } from '../api/http.ts';
import { browserLanguage } from '../lib/language.ts';

/** The shortest wait between reads, so a bad or past `refresh_at` can't loop. */
export const OPEN_STATUS_FLOOR_MS = 30_000;

/** The longest: the kernel never vouches for more than 25 hours, and longer timers overflow. */
export const OPEN_STATUS_CEILING_MS = 25 * 60 * 60 * 1_000;

/**
 * How long the kernel vouches for `status`: `refresh_at` minus `as_of`, both the kernel's times,
 * clamped to the floor and the ceiling. A delay that isn't a finite number waits the floor.
 */
export function openStatusDelayMs(status: OpenStatus): number {
  const refreshAt = typeof status.refresh_at === 'string' ? Date.parse(status.refresh_at) : Number.NaN;
  const asOf = typeof status.as_of === 'string' ? Date.parse(status.as_of) : Number.NaN;
  const delay = refreshAt - asOf;
  if (!Number.isFinite(delay)) return OPEN_STATUS_FLOOR_MS;
  return Math.min(OPEN_STATUS_CEILING_MS, Math.max(OPEN_STATUS_FLOOR_MS, delay));
}

/** The latest public Desk the page holds, and whether the kernel still vouches for its status. */
interface Shown {
  desk: PublicDesk;
  vouched: boolean;
}

export interface OpenStatusView {
  /** The latest good answer's `open_status`; null when it has none or the last read failed. */
  openStatus: OpenStatus | null;
  /** The latest good answer, for the header and the about column. */
  desk: PublicDesk | null;
}

/** Desks a mounted page has already scheduled from: a page mounted again reads afresh. */
const scheduled = new WeakSet<PublicDesk>();

/**
 * The open status for `slug`, starting from `first`, the public Desk the chat loaded. Every answer
 * cancels the pending read and schedules the next from its own `refresh_at`.
 */
export function useOpenStatus(slug: string, first: PublicDesk | null): OpenStatusView {
  const [shown, setShown] = useState<Shown | null>(null);

  useEffect(() => {
    if (first === null) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reading = false;
    const language = browserLanguage();

    const schedule = (ms: number | null) => {
      if (timer !== null) clearTimeout(timer);
      timer = ms === null ? null : setTimeout(() => void read(), ms);
    };
    const accept = (answer: PublicDesk) => {
      setShown({ desk: answer, vouched: true });
      // A Desk without hours makes no claim, so there is nothing to keep fresh.
      const status = answer.open_status ?? null;
      schedule(status === null ? null : openStatusDelayMs(status));
    };
    // One read at a time: a visibility and a focus event together make one.
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const answer = await request('publicDesk', { params: { slug }, query: { lang: language } });
        if (alive) accept(answer);
      } catch {
        if (!alive) return;
        // The kernel no longer vouches for the line: drop it, keep the rest, try again at the floor.
        setShown((prev) => (prev === null ? prev : { ...prev, vouched: false }));
        schedule(OPEN_STATUS_FLOOR_MS);
      } finally {
        reading = false;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void read();
    };
    const onFocus = () => void read();

    if (scheduled.has(first)) {
      void read();
    } else {
      scheduled.add(first);
      accept(first);
    }
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      schedule(null);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, [slug, first]);

  const current = shown ?? (first === null ? null : { desk: first, vouched: false });
  let openStatus: OpenStatus | null = null;
  if (current !== null && current.vouched) openStatus = current.desk.open_status ?? null;
  return { openStatus, desk: current?.desk ?? null };
}
