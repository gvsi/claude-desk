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
 * Today's counts from the Today read: handled is the briefing's answers and bookings, held what
 * needs the owner, turned down the requests refused, all since last night. Null until the read is
 * in, and while the API doesn't send the answers, so the line never says less than happened.
 */
export function todayCounts(today: Today | undefined): TodayCounts | null {
  const answers = today?.briefing.answers;
  if (today === undefined || answers === undefined) return null;
  return { handled: answers + today.briefing.bookings, held: today.needs_you_count, turnedDown: today.briefing.turned_down };
}

export interface HowItWorksProps {
  deskId: string;
  /** The business's name, as the Desk has it. */
  business: string;
  /** The Today read, or undefined while it is out or has failed. */
  today: Today | undefined;
  /** The oldest request still held, which "held N for you" opens in Needs you; null when none is. */
  firstHeldId: string | null;
}

/**
 * "How your Desk works": the three steps a conversation takes (someone asks, Claude answers, the
 * owner's rules decide), then, once Today is read, what Claude did today on one line under a
 * hairline, each outcome a link to where it is: what it handled to Conversations, what it held to
 * Needs you, what it turned down to Safety.
 */
export function HowItWorks({ deskId, business, today, firstHeldId }: HowItWorksProps) {
  const titleId = useId();
  const counts = todayCounts(today);
  const outcomes = counts === null ? null : todayOutcomes(counts);
  const hrefs: Readonly<Record<TodayOutcomeKind, string>> = {
    handled: conversationsPath(deskId),
    // Call-back requests count too; without a held approval, open the Needs you section itself.
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
        {outcomes === null ? null : outcomes.quiet ? (
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
