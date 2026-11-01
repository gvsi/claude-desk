import { useId, type CSSProperties } from 'react';

import type { ThisWeek as ThisWeekFigures, ThisWeekDay } from '../../api/views.ts';
import { Card, SectionHeader, StatusDot, TextLink } from '../../ds/index.ts';
import { formatCents, formatDay } from '../../lib/format.ts';
import { useToday } from '../useDesks.ts';
import { RecordedHistoryLink } from './SinceLastNight.tsx';
import { handledCount, steppedInCount, TODAY_COPY } from './copy.ts';

/** "1 booking", "2 bookings". */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A day's share of the busiest day's bookings, which sets its bar's height. */
type BarStyle = CSSProperties & { '--cd-week-share': number };

/** The bookings per day, oldest first, today last and marked: each a bar against the busiest day, and its words for assistive tech. */
function DayBars({ days }: { days: readonly ThisWeekDay[] }) {
  const busiest = Math.max(0, ...days.map((d) => d.bookings));
  return (
    <ul className="cd-week__bars" aria-label="Bookings per day">
      {days.map((day, i) => {
        const name = formatDay(day.date);
        const today = i === days.length - 1;
        const style: BarStyle = { '--cd-week-share': busiest > 0 ? day.bookings / busiest : 0 };
        return (
          <li key={day.date} className={`cd-week__day${today ? ' cd-week__day--today' : ''}`} aria-current={today ? 'date' : undefined}>
            <span className="cd-week__bar-room" aria-hidden="true">
              <span className="cd-week__bar" style={style} />
            </span>
            <span className="cd-week__initial cd-type-caption" aria-hidden="true">
              {name.charAt(0)}
            </span>
            <span className="cd-sr-only">
              {name}: {day.bookings === 0 ? 'no bookings' : plural(day.bookings, 'booking', 'bookings')}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Bookings({ week }: { week: ThisWeekFigures }) {
  const today = week.days.at(-1)?.bookings ?? 0;
  if (week.bookings === 0) {
    return (
      <div className="cd-week__part">
        <h3 className="cd-week__title cd-type-control">Bookings</h3>
        <p className="cd-week__line cd-type-meta">No bookings in the last 7 days.</p>
        <DayBars days={week.days} />
      </div>
    );
  }
  // The booked amount is the headline when the API sends it; until then the count stands alone.
  const booked = week.booked_cents;
  return (
    <div className="cd-week__part">
      {booked === undefined ? (
        <h3 className="cd-week__title cd-type-control">Bookings</h3>
      ) : (
        <>
          <h3 className="cd-sr-only">Bookings</h3>
          <p className="cd-week__figure">
            <span className="cd-week__number cd-type-figure">{formatCents(booked)}</span>{' '}
            <span className="cd-week__unit cd-type-body">booked</span>
          </p>
        </>
      )}
      <p className="cd-week__line cd-type-meta">
        {plural(week.bookings, 'booking', 'bookings')}
        {today > 0 ? `, ${today} so far today` : ''}
      </p>
      <DayBars days={week.days} />
    </div>
  );
}

function Handled({ week }: { week: ThisWeekFigures }) {
  return (
    <div className="cd-week__part">
      <h3 className="cd-week__title cd-type-control">{TODAY_COPY.handledTitle}</h3>
      {week.conversations === 0 ? (
        <p className="cd-week__line cd-type-meta">No conversations in the last 7 days.</p>
      ) : (
        <>
          <span className="cd-week__split" aria-hidden="true">
            {week.handled > 0 ? <span className="cd-week__split-part cd-week__split-part--handled" style={{ flexGrow: week.handled }} /> : null}
            {week.stepped_in > 0 ? <span className="cd-week__split-part cd-week__split-part--stepped" style={{ flexGrow: week.stepped_in }} /> : null}
          </span>
          <ul className="cd-week__legend cd-type-meta">
            <li className="cd-week__legend-item">
              <StatusDot tone="handled" />
              <span>{handledCount(week.handled)}</span>
            </li>
            {week.stepped_in > 0 ? (
              <li className="cd-week__legend-item">
                <StatusDot tone="held" />
                <span>{steppedInCount(week.stepped_in)}</span>
              </li>
            ) : (
              <li className="cd-week__legend-item cd-week__legend-item--quiet">
                <span>You haven&apos;t stepped in.</span>
              </li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}

/** The requests the kernel refused in the last 7 days (`stopped`, which counts nothing else), and the way to Safety. */
function TurnedDown({ week, deskId }: { week: ThisWeekFigures; deskId: string }) {
  return (
    <div className="cd-week__part">
      <h3 className="cd-week__title cd-type-control">Turned down</h3>
      {week.stopped === 0 ? (
        <p className="cd-week__line cd-type-meta">{TODAY_COPY.turnedDownEmpty}</p>
      ) : (
        <p className="cd-week__figure">
          <span className="cd-week__number cd-type-figure-small">{week.stopped}</span>{' '}
          <span className="cd-week__unit cd-type-body">{week.stopped === 1 ? 'request' : 'requests'}</span>
        </p>
      )}
      <p className="cd-week__line cd-type-meta">
        <TextLink href={`/app/${encodeURIComponent(deskId)}/safety`}>{TODAY_COPY.openSafety}</TextLink>
      </p>
    </div>
  );
}

/**
 * "Last 7 days" in Today's right column, its section title over one card, as "Needs you" opens the
 * page's column, the seven dates ending today on the business's clock:
 * what was booked, who handled the conversations, and the requests turned down. Every figure is
 * the API's; the page formats them and adds none up.
 */
export function ThisWeek({ deskId }: { deskId: string }) {
  const today = useToday(deskId, { retryOnMount: false });
  const titleId = useId();
  const week = today.data?.this_week;
  if (week === undefined) return null;
  return (
    <section className="cd-today__section" aria-labelledby={titleId}>
      <SectionHeader
        id={titleId}
        title="Last 7 days"
        caption={today.data?.recorded_history?.this_week === true ? <RecordedHistoryLink deskId={deskId} /> : undefined}
      />
      <Card padding={16}>
        <div className="cd-week">
          <Bookings week={week} />
          <Handled week={week} />
          <TurnedDown week={week} deskId={deskId} />
        </div>
      </Card>
    </section>
  );
}
