import { ConceptFooter, Skeleton } from '../../ds/index.ts';

import './Conversations.css';

/**
 * Lines that wrap differently by the open conversation's width: `wide` of them where the column is
 * wide, `narrow` where it is a phone's (`cd-conversation-skeleton__narrow-line` and `__wide-line`).
 */
function Lines({ wide, narrow, text, width = '100%' }: { wide: number; narrow: number; text: 'caption' | 'reply'; width?: string }) {
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

/** A receipt under a message: its dot, and its line as a pill. */
function Receipt({ width }: { width: number }) {
  return (
    <div className="cd-transcript-row__margin">
      <div className="cd-margin-line">
        <span className="cd-margin-line__dot">
          <Skeleton shape="circle" size={6} />
        </span>
        <Skeleton shape="line" text="caption" width={width} />
      </div>
    </div>
  );
}

/** A visitor's message: the bubble at the right, its receipt under it on that side. */
function VisitorShape({ width, anchor }: { width: string; anchor?: string }) {
  return (
    <div className="cd-transcript-row">
      <div className="cd-transcript-row__main">
        <div className="cd-visitor-message" data-skeleton-anchor={anchor}>
          <Skeleton shape="block" className="cd-type-message" width={width} height="calc(1lh + 2 * var(--space-8))" radius="card" />
        </div>
      </div>
      <Receipt width={110} />
    </div>
  );
}

/** Claude's reply: its lines at the left, its receipt under them. */
function ClaudeShape({ lines }: { lines: number }) {
  return (
    <div className="cd-transcript-row">
      <div className="cd-transcript-row__main">
        <div className="cd-claude-message">
          <Lines wide={lines} narrow={lines + 1} text="reply" width="90%" />
        </div>
      </div>
      <Receipt width={170} />
    </div>
  );
}

/**
 * The open conversation's pane as shapes, from its own classes: who it is with (their name, the
 * level pill and the latest line), then the transcript's header lines and a few messages in the
 * reading column, visitors' bubbles at the right and Claude's lines at the left, each with a
 * receipt line under it. The owner's controls aren't drawn: a recorded chat has none, and an
 * agent's differ, so they arrive with the chat.
 */
export function ConversationSkeleton() {
  return (
    <div className="cd-conversation cd-conversation-skeleton">
      <div className="cd-conversation__head">
        <Skeleton shape="line" text="section" width={64} anchor="conversation-name" />
        <Skeleton shape="block" measure={{ label: 'Public', className: 'cd-pill cd-type-pill', tagName: 'span' }} height="var(--space-20)" radius="full" />
        <Skeleton shape="line" text="meta" width={200} />
      </div>
      <div className="cd-conversation__scroll">
        <div className="cd-transcript">
          <div className="cd-transcript-row cd-transcript-header">
            <div className="cd-transcript-row__main">
              <Lines wide={1} narrow={2} text="caption" width="70%" />
            </div>
            <div className="cd-transcript-row__margin">
              <Lines wide={1} narrow={2} text="caption" width="65%" />
            </div>
          </div>
          <VisitorShape width="62%" anchor="first-message" />
          <ClaudeShape lines={2} />
          <VisitorShape width="40%" />
          <ClaudeShape lines={1} />
        </div>
      </div>
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
