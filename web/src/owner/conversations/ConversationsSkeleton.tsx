import { useLayoutEffect, useRef } from 'react';

import { ConceptFooter, Skeleton, SkeletonCard } from '../../ds/index.ts';
import { useTextLines, type TextPart } from '../../lib/useTextLines.ts';
import { publicLink } from '../customerLink.ts';
import { TRANSCRIPT_NOTE } from './copy.ts';

import './Conversations.css';

/** The fresh copy's link, as Today's skeleton measures it: the slug isn't known before the read lands. */
const FRESH_LINK = publicLink('rivera-plumbing-abc123').replace(/^https?:\/\//, '');

/** The fresh copy's held chat is with a visitor who gave no name, so the page calls them this. */
const VISITOR = { text: 'Visitor', className: 'cd-user-name' } as const;

/**
 * Lines that wrap differently by the open conversation's width, for words not known before the
 * read lands: `wide` of them where the column is wide, `narrow` where it is a phone's
 * (`cd-conversation-skeleton__narrow-line` and `__wide-line`).
 */
function Lines({ wide, narrow, text, width = '100%' }: { wide: number; narrow: number; text: 'caption' | 'meta' | 'summary' | 'reply'; width?: string }) {
  const count = Math.max(wide, narrow);
  return (
    <div>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton
          key={i}
          shape="line"
          text={text}
          width={i === count - 1 && count > 1 ? '60%' : width}
          className={[i >= wide ? 'cd-conversation-skeleton__narrow-line' : '', i >= narrow ? 'cd-conversation-skeleton__wide-line' : ''].join(' ').trim()}
        />
      ))}
    </div>
  );
}

/**
 * The page's own words, known before the read lands, as many lines as they wrap to here in this
 * browser's fonts (`useTextLines`). With `drawn` false it only holds their height, with no shape.
 */
function MeasuredLines({
  parts,
  className,
  text,
  fallback,
  width = '100%',
  drawn = true,
}: {
  parts: readonly TextPart[];
  className: string;
  text: 'caption';
  fallback: number;
  width?: string;
  drawn?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const count = useTextLines(box, { parts, className }, fallback);
  if (!drawn) {
    return (
      <div ref={box}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className={`cd-conversation-skeleton__room-line cd-type-${text}`} />
        ))}
      </div>
    );
  }
  return (
    <div ref={box}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} shape="line" text={text} width={i === count - 1 && count > 1 ? '60%' : width} />
      ))}
    </div>
  );
}

/** A receipt under a message: its dot, and its line as a pill. */
function Receipt({ width }: { width: number }) {
  return (
    <div className="cd-margin-line">
      <span className="cd-margin-line__dot">
        <Skeleton shape="circle" size={6} />
      </span>
      <Skeleton shape="line" text="caption" width={width} />
    </div>
  );
}

/**
 * Where the owner's controls will be, for a live chat as Claude answers it: Take over's line, its
 * button and what the visitor sees, then the whisper box. Nothing is drawn there, since a recorded
 * chat has none and an agent's differ, but the room is kept, so the transcript's region over it is
 * as tall as the chat's, and what lands at its foot lands where its shapes were.
 */
function ControlsRoom() {
  return (
    <div className="cd-conversation__controls">
      <div className="cd-take-over">
        <div className="cd-take-over__lead">
          <MeasuredLines
            parts={[VISITOR, ' never sees whispers. Whispers steer Claude, and your rules still apply.']}
            className="cd-take-over__first cd-take-over__line cd-type-caption"
            text="caption"
            fallback={1}
            drawn={false}
          />
        </div>
        <div className="cd-take-over__action">
          <div className="cd-take-over__buttons">
            <div className="cd-conversation-skeleton__button" />
          </div>
          <MeasuredLines
            parts={[VISITOR, ' sees “Maria Rivera joined the chat.”']}
            className="cd-take-over__line cd-type-caption"
            text="caption"
            fallback={1}
            drawn={false}
          />
        </div>
      </div>
      <div className="cd-conversation-skeleton__composer" />
    </div>
  );
}

/** The transcript's region, opened at its end as the chat's is: at its top when all of it fits. */
function useOpensAtTheEnd() {
  const region = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = region.current;
    if (!element) return undefined;
    const toTheEnd = () => {
      element.scrollTop = element.scrollHeight;
    };
    toTheEnd();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(toTheEnd);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, []);
  return region;
}

/**
 * The open conversation's pane as shapes, from its own classes, as a fresh copy's held chat (what
 * Today's "Open the request" opens) draws: who it is with (their name, the level pill and the
 * latest line); the transcript's header lines; the visitor's bubble at the right; Claude's reply
 * at the left with its two receipt lines; and the held request's card. The transcript's region
 * opens at its end, as the chat's does, over the room the owner's controls take.
 */
export function ConversationSkeleton() {
  const region = useOpensAtTheEnd();
  return (
    <div className="cd-conversation cd-conversation-skeleton">
      <div className="cd-conversation__head">
        <Skeleton shape="line" text="section" width={64} anchor="conversation-name" />
        <Skeleton shape="block" measure={{ label: 'Public', className: 'cd-pill cd-type-pill', tagName: 'span' }} height="var(--space-20)" radius="full" />
        <Skeleton shape="line" text="meta" width={200} />
      </div>
      <div ref={region} className="cd-conversation__scroll">
        <div className="cd-transcript">
          <div className="cd-transcript-row cd-transcript-header">
            <div className="cd-transcript-row__main">
              <MeasuredLines
                parts={[`Today at 12:00 pm, web chat from ${FRESH_LINK}`]}
                className="cd-transcript-header__caption cd-type-caption"
                text="caption"
                fallback={1}
                width="70%"
              />
            </div>
            <div className="cd-transcript-row__margin">
              <MeasuredLines parts={[TRANSCRIPT_NOTE]} className="cd-transcript-header__caption cd-type-caption" text="caption" fallback={1} width="65%" />
            </div>
          </div>
          <div className="cd-transcript-row">
            <div className="cd-transcript-row__main">
              <div className="cd-visitor-message" data-skeleton-anchor="first-message">
                <Skeleton shape="block" className="cd-type-message" width="62%" height="calc(1lh + 2 * var(--space-8))" radius="card" />
              </div>
            </div>
          </div>
          <div className="cd-transcript-row">
            <div className="cd-transcript-row__main">
              <div className="cd-claude-message">
                <Lines wide={2} narrow={3} text="reply" width="90%" />
              </div>
            </div>
            <div className="cd-transcript-row__margin">
              <Receipt width={170} />
              <Receipt width={80} />
            </div>
          </div>
          <div className="cd-conversation__held" data-skeleton-anchor="last-message">
            <SkeletonCard>
              <div className="cd-approval-card__top">
                <Skeleton shape="line" text="caption" width="80%" />
              </div>
              <div className="cd-approval-card__reason">
                <Lines wide={2} narrow={3} text="summary" />
              </div>
              <div className="cd-approval-card__context">
                <Lines wide={1} narrow={2} text="meta" />
              </div>
              <div className="cd-approval-card__held-by">
                <Skeleton shape="block" width={16} height={16} />
                <div className="cd-conversation-skeleton__rule">
                  <Lines wide={1} narrow={2} text="meta" />
                </div>
              </div>
              <div className="cd-approval-card__answers">
                <div className="cd-approval-card__row">
                  <Skeleton shape="block" width="46%" height="var(--size-control-main)" />
                  <Skeleton shape="block" width="46%" height="var(--size-control-main)" />
                </div>
              </div>
            </SkeletonCard>
          </div>
        </div>
      </div>
      <ControlsRoom />
    </div>
  );
}

/** A fresh copy's first rows, as the list draws them: one with no status line, then two with one. */
const ROWS = [
  { name: '50%', status: null },
  { name: '40%', status: '45%' },
  { name: '75%', status: '25%' },
] as const;

/** Day groups enough to fill a tall window's list column; what the column can't show is cut off. */
const GROUPS = 6;

/**
 * Everything under the list's title as shapes: the recorded-history caption a fresh copy shows,
 * then a day heading every three rows on down the column, each row a `ConversationListItem` shape.
 */
function ListShapes() {
  return (
    <div className="cd-conversations__under cd-conversations-skeleton__list">
      <div className="cd-conversations__caption cd-conversations-skeleton__caption" data-skeleton-anchor="conversations-caption">
        <Skeleton shape="line" text="caption" width={137} />
      </div>
      {Array.from({ length: GROUPS }, (_, group) => (
        <div key={group} className="cd-conversations__group">
          <div className="cd-conversations__day" data-skeleton-anchor={group === 0 ? 'conversations-day-0' : undefined}>
            <Skeleton shape="line" text="meta" width={group === 0 ? 40 : 72} />
          </div>
          <div className="cd-conversations__items">
            {ROWS.map((row, i) => (
              <div key={i} className="cd-conversation-item" data-skeleton-anchor={group === 0 ? `conversation-row-${i}` : undefined}>
                <span className="cd-conversation-item__top">
                  <Skeleton shape="line" text="control" width={row.name} />
                  <Skeleton shape="line" text="caption" width={44} />
                </span>
                {row.status === null ? null : (
                  <span className="cd-conversation-item__status">
                    <Skeleton shape="circle" size={6} />
                    <Skeleton shape="line" text="caption" width={row.status} />
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Conversations as shapes. Inside the app the list's title is real and its region draws only what
 * is under it. With `withHeader`, the full-page loader's page on the fill page's columns: the
 * title too, and with `open` a conversation's pane beside the list (its way back above it under
 * 1024 px), and the real concept footer where the page puts it.
 */
export function ConversationsSkeleton({ withHeader, open }: { withHeader: boolean; open: boolean }) {
  if (!withHeader) return <ListShapes />;
  return (
    <div className={`cd-conversations${open ? ' cd-conversations--open' : ''}`}>
      <div className="cd-conversations__list">
        <div className="cd-conversations__title">
          <Skeleton shape="line" text="page-title" width={170} />
        </div>
        <div className="cd-conversations__region">
          <ListShapes />
        </div>
      </div>
      <div className="cd-conversations__open">
        {open ? (
          <>
            <div className="cd-conversations__back">
              <Skeleton shape="line" text="meta" width={100} />
            </div>
            <div className="cd-conversation-pane">
              <ConversationSkeleton />
            </div>
          </>
        ) : null}
      </div>
      <div className="cd-conversations__footer">
        <ConceptFooter />
      </div>
    </div>
  );
}
