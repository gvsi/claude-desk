import { Link } from 'react-router';

import type { NeedsYouItem, Today } from '../../api/views.ts';
import { StatusDot, type StatusTone } from '../../ds/index.ts';
import { conversationsPath } from '../conversations/ConversationsPage.tsx';
import { todayPath } from '../useDesks.ts';
import { todayOutcomes, type TodayCounts, type TodayOutcomeKind } from './copy.ts';
import { requestPath } from './requestLink.ts';

/** Each outcome's status dot. */
const TONES: Readonly<Record<TodayOutcomeKind, StatusTone>> = { handled: 'handled', held: 'held', turnedDown: 'refused' };

/**
 * Handled and turned down come from Today's briefing since last night. Held counts only the
 * requests waiting for the owner's answer, from the same Needs you read and filter as Safety.
 * Null until both reads are in, and while the API doesn't send the answers.
 */
export function todayCounts(today: Today | undefined, heldCount: number | undefined): TodayCounts | null {
  const answers = today?.briefing.answers;
  if (today === undefined || answers === undefined || heldCount === undefined) return null;
  return { handled: answers + today.briefing.bookings, held: heldCount, turnedDown: today.briefing.turned_down };
}

export interface TodayOutcomesProps {
  deskId: string;
  /** The Today read, or undefined while it is out or has failed. */
  today: Today | undefined;
  /**
   * The server-read count of requests held in Needs you, excluding callbacks, as Safety counts.
   * The link target includes locally kept requests and excludes those answered here, so it can
   * differ from this count until the next read succeeds. Undefined until a current read is in.
   */
  heldCount: number | undefined;
  /** Callbacks and handoffs in Needs you, which rule out a quiet day. */
  callbackCount: number;
  /** The oldest request still held, which "held N for you" opens in its conversation; null when none is. */
  firstHeld: NeedsYouItem | null;
}

/** Today's counts and links, placed below the greeting's presence line. */
export function TodayOutcomes({ deskId, today, heldCount, callbackCount, firstHeld }: TodayOutcomesProps) {
  const counts = todayCounts(today, heldCount);
  const outcomes = counts === null ? null : todayOutcomes(counts);
  const hrefs: Readonly<Record<TodayOutcomeKind, string>> = {
    handled: conversationsPath(deskId),
    // Keep a Needs you landing if the oldest request disappears while an answer settles.
    held: firstHeld?.decision ? requestPath(deskId, firstHeld.decision.decision_id, firstHeld.session) : `${todayPath(deskId)}#needs-you`,
    turnedDown: `/app/${encodeURIComponent(deskId)}/safety`,
  };
  return outcomes === null || (outcomes.quiet && callbackCount > 0) ? null : outcomes.quiet ? (
    <p className="cd-how__today cd-type-meta">{outcomes.line}</p>
  ) : (
    // The spaces between the parts lay nothing out in the flex line; they keep the words apart
    // when the line is read as text.
    <p className="cd-how__today cd-type-meta">
      <span>{outcomes.lead}</span>
      {outcomes.parts.map(({ kind, count, before, after }) => {
        const href = hrefs[kind];
        const words = (
          <>
            {before}
            <b className="cd-how__count">{count}</b>
            {after}
          </>
        );
        return (
          <span key={kind} className="cd-how__outcome">
            {' '}
            <StatusDot tone={TONES[kind]} />
            <Link className="cd-how__link" to={href}>{words}</Link>
          </span>
        );
      })}
    </p>
  );
}
