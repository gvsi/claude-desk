import { useId } from 'react';
import { Link } from 'react-router';

import type { Today } from '../../api/views.ts';
import { Card, Icon, SectionHeader, StatusDot, type IconName, type StatusTone } from '../../ds/index.ts';
import { conversationsPath } from '../conversations/ConversationsPage.tsx';
import { todayPath } from '../useDesks.ts';
import { HOW_IT_WORKS_TITLE, howItWorksSteps, stepLabel, todayOutcomes, type TodayCounts, type TodayOutcomeKind } from './copy.ts';
import { requestPath } from './requestLink.ts';

/** Each step's icon: who asks, Claude's answer, the owner's rules. */
const STEP_ICONS: readonly IconName[] = ['people', 'conversations', 'rules'];

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

export interface HowItWorksProps {
  deskId: string;
  /** The business's name, as the Desk has it. */
  business: string;
  /** The Today read, or undefined while it is out or has failed. */
  today: Today | undefined;
  /** The requests held in Needs you, excluding callbacks; undefined until a current read is in. */
  heldCount: number | undefined;
  /** Callbacks and handoffs in Needs you, which rule out a quiet day. */
  callbackCount: number;
  /** The oldest request still held, which "held N for you" opens in Needs you; null when none is. */
  firstHeldId: string | null;
}

/**
 * "How your Desk works": the three steps a conversation takes (someone asks, Claude answers, the
 * owner's rules decide), then, once Today is read, what Claude did today on one line under a
 * hairline, each outcome a link to where it is: what it handled to Conversations, what it held to
 * Needs you, what it turned down to Safety.
 */
export function HowItWorks({ deskId, business, today, heldCount, callbackCount, firstHeldId }: HowItWorksProps) {
  const titleId = useId();
  const counts = todayCounts(today, heldCount);
  const outcomes = counts === null ? null : todayOutcomes(counts);
  const hrefs: Readonly<Record<TodayOutcomeKind, string>> = {
    handled: conversationsPath(deskId),
    // Keep a Needs you landing if the oldest request disappears while an answer settles.
    held: firstHeldId === null ? `${todayPath(deskId)}#needs-you` : requestPath(deskId, firstHeldId),
    turnedDown: `/app/${encodeURIComponent(deskId)}/safety`,
  };
  return (
    <section className="cd-today__section cd-how" aria-labelledby={titleId}>
      <SectionHeader id={titleId} title={HOW_IT_WORKS_TITLE} />
      <Card>
        <ol className="cd-how__steps">
          {howItWorksSteps(business).map((step, i) => (
            <li key={step.title} className="cd-how__step">
              <span className="cd-how__tile" aria-hidden="true">
                <Icon name={STEP_ICONS[i]!} />
              </span>
              <div className="cd-how__words">
                <p className="cd-how__label cd-type-meta">{stepLabel(i + 1)}</p>
                <p className="cd-how__title cd-type-control">{step.title}</p>
                <p className="cd-how__line cd-type-meta">{step.line}</p>
              </div>
            </li>
          ))}
        </ol>
        {outcomes === null || (outcomes.quiet && callbackCount > 0) ? null : outcomes.quiet ? (
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
        )}
      </Card>
    </section>
  );
}
