import type { ReactNode } from 'react';

import { StatusDot, type StatusTone } from '../StatusDot/StatusDot.tsx';

import './Notice.css';

/** `info` (something to know), `waiting` (something is in progress) or `error` (something failed). */
export type NoticeTone = 'info' | 'waiting' | 'error';

/** Each tone's dot: hollow for info, held for waiting, refused for an error. */
const NOTICE_DOT = {
  info: 'info',
  waiting: 'held',
  error: 'refused',
} as const satisfies Record<NoticeTone, StatusTone>;

export interface NoticeProps {
  tone: NoticeTone;
  /** What happened and what to do, in plain words. Never a code. */
  children: ReactNode;
  /** The next step, when there is one: a `Button` ("Try again") or a `TextLink`. */
  action?: ReactNode;
}

/**
 * One quiet line about the state of things: a status dot, what happened and what to do, and the
 * next step at the right. An error is an `alert`, read out at once; the other tones are a `status`.
 */
export function Notice({ tone, children, action }: NoticeProps) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`cd-notice cd-notice--${tone}`}>
      <p className="cd-notice__message cd-type-meta">
        <StatusDot tone={NOTICE_DOT[tone]} />
        <span>{children}</span>
      </p>
      {action ? <div className="cd-notice__action cd-type-meta">{action}</div> : null}
    </div>
  );
}
