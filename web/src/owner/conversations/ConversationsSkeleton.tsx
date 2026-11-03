import { useLayoutEffect, useRef } from 'react';

import { AppShellOnly, CARD_CHROME, ConceptFooter, OWNER_STATE_WORDS, Skeleton, SkeletonCard, useControlWidth } from '../../ds/index.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { useTextBox, useTextLines, type TextPart } from '../../lib/useTextLines.ts';
import { HeldRuleShape } from '../approvals/HeldRuleShape.tsx';
import { publicLink } from '../customerLink.ts';
import { TRANSCRIPT_NOTE } from './copy.ts';

import './Conversations.css';

/** The fresh copy's link, as Today's skeleton measures it: the slug isn't known before the read lands. */
const FRESH_LINK = publicLink('turner-plumbing-abc123').replace(/^https?:\/\//, '');

/** The fresh copy's held chat is with a visitor who gave no name, so the page calls them this. */
const VISITOR = { text: 'Visitor', className: 'cd-user-name' } as const;

/**
 * The words of the fresh copy's held chat, from the seed the copy is made from, as the Today
 * preview takes them (`owner/arrival/preview.ts`). They are only measured, so each shape is as
 * many lines, and as tall, as its part lands; none of them is ever drawn.
 */
const QUESTION = rivera.conversations.visitor.turns.find((turn) => turn.kind === 'visitor')?.text ?? '';
const HELD_CHAT = {
  question: QUESTION,
  handoff: { label: CARD_CHROME.handoff.en.label, headline: rivera.blocks.handoff.en.title ?? '', detail: rivera.blocks.handoff.en.lines?.[0] ?? '' },
  reason: rivera.decisions.held.reason_plain,
  context: `From the visitor: “${QUESTION}”`,
  // The receipts under Claude's handoff reply: the kernel's line for a reply it passed to the owner,
  // then the hold's own words, alone, since its card is right under the row.
  receipts: [`Passed to ${rivera.business.ownerName} to answer`, OWNER_STATE_WORDS.held],
} as const;

type LineText = 'caption' | 'meta' | 'section' | 'summary';

/**
 * The page's own words, known before the read lands, as many lines as they wrap to here in this
 * browser's fonts (`useTextLines`), in a box with the part's own classes for its margins. With
 * `drawn` false it only holds their height, with no shape.
 */
function MeasuredLines({
  parts,
  className,
  text,
  fallback = 1,
  width = '100%',
  drawn = true,
  boxClassName,
}: {
  parts: readonly TextPart[];
  className: string;
  text: LineText;
  fallback?: number;
  width?: string;
  drawn?: boolean;
  boxClassName?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const count = useTextLines(box, { parts, className }, fallback);
  if (!drawn) {
    return (
      <div ref={box} className={boxClassName}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className={`cd-conversation-skeleton__room-line cd-type-${text}`} />
        ))}
      </div>
    );
  }
  return (
    <div ref={box} className={boxClassName}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} shape="line" text={text} width={i === count - 1 && count > 1 ? '60%' : width} />
      ))}
    </div>
  );
}

/**
 * The visitor's message: their bubble at the left, as the owner's view draws it, as wide as its
 * words on one line, never wider than the bubble's cap there (the Desk's column, min(520 px, 88%) of
 * the row), and as tall as they wrap to there, padding included.
 */
function VisitorShape({ words, anchor }: { words: string; anchor?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const { height } = useTextBox(box, { parts: [words], className: 'cd-visitor-message__bubble cd-type-message' }, 1);
  return (
    <div className="cd-transcript-row">
      <div className="cd-transcript-row__main">
        <div className="cd-visitor-message" data-skeleton-anchor={anchor}>
          <div ref={box} className="cd-conversation-skeleton__bubble">
            <Skeleton
              shape="block"
              measure={{ label: words, className: 'cd-visitor-message__bubble cd-type-message', tagName: 'span' }}
              height={height}
              radius="card"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Claude's handoff card, as `ReplyCard` lays one out in the owner's view: a compact card the width
 * of the owner's column, its label's icon and words, then its headline and its line, each as many
 * lines as its words take.
 */
function HandoffCardShape({ anchor }: { anchor?: string }) {
  return (
    <div className="cd-claude-message">
      <div className="cd-reply-card" data-skeleton-anchor={anchor}>
        <SkeletonCard padding={16}>
          <div className="cd-reply-card__label cd-type-caption">
            <Skeleton shape="block" width={16} height={16} />
            <Skeleton shape="line" text="caption" width={110} />
          </div>
          <div className="cd-reply-card__data">
            <MeasuredLines
              parts={[HELD_CHAT.handoff.headline]}
              className="cd-type-section"
              text="section"
              width="60%"
              boxClassName="cd-reply-card__headline"
            />
            <MeasuredLines parts={[HELD_CHAT.handoff.detail]} className="cd-type-meta" text="meta" width="50%" boxClassName="cd-reply-card__detail" />
          </div>
        </SkeletonCard>
      </div>
    </div>
  );
}

/**
 * The held request's card, as `ApprovalCard` lays one out: its status line, the kernel's reason and
 * the visitor's words, each as many lines as its words take, the "Your rule" box that names the rule
 * that held it (`HeldRuleShape`), then Allow and Deny at the answers' own heights
 * (`cd-conversation-skeleton__answer`).
 */
function HeldCardShape({ anchor }: { anchor?: string }) {
  const answers = useRef<HTMLDivElement>(null);
  // Probe inside the answers' container so ApprovalCard's own narrow-card rule sets the height.
  const { height: allowHeight } = useTextBox(answers, { parts: ['Allow this time'], className: 'cd-button cd-button--secondary cd-button--main cd-type-control' }, 1);
  const { height: denyHeight } = useTextBox(answers, { parts: ['Deny this time'], className: 'cd-button cd-button--danger cd-button--main cd-type-control' }, 1);
  return (
    <div className="cd-conversation__held" data-skeleton-anchor={anchor}>
      <SkeletonCard>
        <div className="cd-approval-card__top">
          <Skeleton shape="line" text="caption" width="80%" />
        </div>
        <MeasuredLines parts={[HELD_CHAT.reason]} className="cd-type-summary" text="summary" fallback={2} boxClassName="cd-approval-card__reason" />
        <MeasuredLines parts={[HELD_CHAT.context]} className="cd-type-meta" text="meta" boxClassName="cd-approval-card__context" />
        <HeldRuleShape />
        <div className="cd-approval-card__answers">
          <div ref={answers} className="cd-approval-card__row">
            <Skeleton
              shape="block"
              className="cd-conversation-skeleton__answer"
              height={allowHeight}
              measure={{ label: 'Allow this time', className: 'cd-button cd-button--secondary cd-button--main cd-type-control' }}
            />
            <Skeleton
              shape="block"
              className="cd-conversation-skeleton__answer"
              height={denyHeight}
              measure={{ label: 'Deny this time', className: 'cd-button cd-button--danger cd-button--main cd-type-control' }}
            />
          </div>
        </div>
      </SkeletonCard>
    </div>
  );
}

/**
 * A receipt under a message: its dot, and its line as a pill as wide as its words in the caption
 * type, so the shape, flush right under the reply as the receipt lands (board REV-FLIP), starts
 * where the receipt starts.
 */
function Receipt({ words, anchor }: { words: string; anchor?: string }) {
  const line = useRef<HTMLSpanElement>(null);
  const width = useControlWidth(line, { label: words, className: 'cd-margin-line__text cd-type-caption', tagName: 'span' });
  return (
    <div className="cd-margin-line cd-type-caption" data-skeleton-anchor={anchor}>
      <span className="cd-margin-line__dot">
        <Skeleton shape="circle" size={6} />
      </span>
      <span ref={line} className="cd-margin-line__text">
        <Skeleton shape="line" text="caption" width={width ?? 0} />
      </span>
    </div>
  );
}

/**
 * Where the owner's controls will be, for a live chat as Claude answers it: the line about
 * whispers, then the whisper box and its helper line (Take over is in the bar). Nothing is drawn
 * there, since a recorded chat has none and an agent's differ, but the room is kept, so the
 * transcript's region over it is as tall as the chat's, and what lands at its foot lands where
 * its shapes were.
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
      </div>
      <div className="cd-composer cd-composer--whisper">
        <div className="cd-conversation-skeleton__composer" />
        <div className="cd-composer__meta">
          <MeasuredLines
            parts={[VISITOR, " isn't in the chat now. Claude will use your whisper when they next write."]}
            className="cd-composer__helper cd-type-caption"
            text="caption"
            drawn={false}
            boxClassName="cd-composer__helper"
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The transcript's region, opened at its end as the chat's is: at its top when all of it fits. In a
 * window too short for the region, where it takes its own height and the open conversation around
 * it scrolls instead (as the chat's does, `useEndInView`), that opens at its end.
 */
function useOpensAtTheEnd() {
  const region = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = region.current;
    if (!element) return undefined;
    const toTheEnd = () => {
      element.scrollTop = element.scrollHeight;
      if (element.scrollHeight > element.clientHeight) return;
      const open = element.closest<HTMLElement>('.cd-conversations__open');
      if (open && getComputedStyle(open).overflowY === 'auto') open.scrollTop = open.scrollHeight;
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
 * Today's "Open the request" opens) draws: its bar, pinned at the top of the pane with its own
 * ground and hairline, with who it is with (their name and the level pill) and the latest line,
 * and no shape for Take over, since a recorded or paused chat has none there (the bar is as tall
 * either way); the transcript's header lines; the visitor's bubble at the left; Claude's handoff
 * card with its two receipt lines in the owner's column at the right (board REV-FLIP); and the held
 * request's card across the transcript, each part as tall as it lands. The transcript's region
 * opens at its end, as the chat's does, over the room the owner's controls take.
 */
export function ConversationSkeleton() {
  const region = useOpensAtTheEnd();
  const who = useRef<HTMLDivElement>(null);
  const dot = useRef<HTMLSpanElement>(null);
  const nameWidth = useControlWidth(who, { label: VISITOR.text, className: 'cd-conversation__name cd-type-section', tagName: 'span' });
  const dotWidth = useControlWidth(dot, { label: '·', className: 'cd-conversation__dot cd-type-meta', tagName: 'span' });
  return (
    <div className="cd-conversation cd-conversation-skeleton">
      <div className="cd-conversation__bar" data-skeleton-anchor="conversation-bar">
        <div ref={who} className="cd-conversation__who">
          <Skeleton shape="line" text="section" width={nameWidth} anchor="conversation-name" />
          <Skeleton shape="block" measure={{ label: 'Public', className: 'cd-pill cd-type-pill', tagName: 'span' }} height="var(--space-20)" radius="full" />
        </div>
        <span ref={dot} className="cd-conversation__dot cd-type-meta" style={{ width: dotWidth }} aria-hidden="true" />
        <div className="cd-conversation__latest">
          <Skeleton shape="line" text="meta" width={200} />
        </div>
      </div>
      <div ref={region} className="cd-conversation__scroll">
        <div className="cd-transcript cd-transcript--owner">
          <div className="cd-transcript-row cd-transcript-header" data-skeleton-anchor="transcript-head">
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
          <VisitorShape words={HELD_CHAT.question} anchor="first-message" />
          <div className="cd-transcript-row">
            <div className="cd-transcript-row__main">
              <HandoffCardShape anchor="reply-card" />
            </div>
            <div className="cd-transcript-row__margin">
              <Receipt words={HELD_CHAT.receipts[0]} anchor="receipt-0" />
              <Receipt words={HELD_CHAT.receipts[1]} anchor="receipt-1" />
            </div>
          </div>
          <HeldCardShape anchor="held-card" />
        </div>
      </div>
      <ControlsRoom />
    </div>
  );
}

/**
 * A fresh copy's first rows: two visitor previews, one booked and one held, then an agent's line
 * saying what it did, above its status.
 */
const ROWS = [
  { name: '50%', preview: '75%', status: '20%' },
  { name: '40%', preview: '85%', status: '45%' },
  { name: '75%', preview: '45%', status: '25%' },
] as const;

/** Day groups enough to fill a tall window's list column; what the column can't show is cut off. */
const GROUPS = 6;

/**
 * Everything under the list's title as shapes: the recorded-history caption on the starting Desk,
 * then a day heading every three rows on down the column, each row a `ConversationListItem` shape.
 */
function ListShapes({ recordedHistory }: { recordedHistory: boolean }) {
  return (
    <div className="cd-conversations__under cd-conversations-skeleton__list">
      {recordedHistory ? (
        <div className="cd-conversations__caption cd-conversations-skeleton__caption" data-skeleton-anchor="conversations-caption">
          <Skeleton shape="line" text="caption" width={137} />
        </div>
      ) : null}
      {Array.from({ length: GROUPS }, (_, group) => (
        <div key={group} className="cd-conversations__group">
          <div className="cd-conversations__day cd-type-caption" data-skeleton-anchor={group === 0 ? 'conversations-day-0' : undefined}>
            <Skeleton shape="line" text="caption" width={group === 0 ? 40 : 72} />
          </div>
          <div className="cd-conversations__items">
            {ROWS.map((row, i) => (
              <div key={i} className="cd-conversation-item" data-skeleton-anchor={group === 0 ? `conversation-row-${i}` : undefined}>
                <span className="cd-conversation-item__top">
                  <Skeleton shape="line" text="control" width={row.name} />
                  <Skeleton shape="line" text="caption" width={44} />
                </span>
                {row.preview === null ? null : (
                  <span className="cd-conversation-item__quote cd-type-meta">
                    <Skeleton shape="line" text="meta" width={row.preview} />
                  </span>
                )}
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
export function ConversationsSkeleton({ withHeader, open, recordedHistory = true }: { withHeader: boolean; open: boolean; recordedHistory?: boolean }) {
  if (!withHeader) return <ListShapes recordedHistory={recordedHistory} />;
  return (
    <div className={`cd-conversations${open ? ' cd-conversations--open' : ''}`}>
      <div className="cd-conversations__list">
        <div className="cd-conversations__title">
          <Skeleton shape="line" text="page-title" width={170} />
        </div>
        <div className="cd-conversations__region">
          <ListShapes recordedHistory={recordedHistory} />
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
      <AppShellOnly layout="compact">
        <div className="cd-conversations__footer" data-skeleton-anchor="owner-footer" data-owner-footer>
          <ConceptFooter skeleton />
        </div>
      </AppShellOnly>
    </div>
  );
}
