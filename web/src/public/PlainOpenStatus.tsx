/**
 * The kernel's open status as a plain line, until the design system's PublicShell takes it in its
 * header (`openStatus`); then this file and its stylesheet go, as the guard in app/guards.test.ts
 * requires. It shows the kernel's words as written, with a dot from `open` (filled when open,
 * hollow when closed; the words carry the state), and "Claude can still help." when closed.
 */
import type { OpenStatus } from '../api/contracts.ts';
import type { CopyLanguage } from '../ds/index.ts';
import { PUBLIC_COPY } from './copy.ts';

import './PlainOpenStatus.css';

export interface PlainOpenStatusProps {
  /** `useOpenStatus`'s value, as the kernel served it; null shows no line. */
  openStatus: OpenStatus | null;
  /** The page's language, for the closed line. */
  language: CopyLanguage;
}

export function PlainOpenStatus({ openStatus, language }: PlainOpenStatusProps) {
  if (openStatus === null || typeof openStatus.text !== 'string' || openStatus.text.trim() === '') return null;
  // Anything but a plain `true` reads as closed: a dot never says open when the kernel didn't.
  const open = openStatus.open === true;
  return (
    <div className="cd-plain-open-status">
      <p className="cd-plain-open-status__line cd-type-meta">
        <span className={`cd-plain-open-status__dot cd-plain-open-status__dot--${open ? 'open' : 'closed'}`} aria-hidden="true" />
        {/* The kernel's words, as written. */}
        <span className="cd-plain-open-status__text">{openStatus.text}</span>
      </p>
      {open ? null : <p className="cd-plain-open-status__still-helps cd-type-caption">{PUBLIC_COPY[language].stillHelps}</p>}
    </div>
  );
}
