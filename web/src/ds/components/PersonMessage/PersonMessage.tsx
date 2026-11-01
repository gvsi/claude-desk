import type { ReactNode } from 'react';

import type { RenderedBlock } from '../../../api/contracts.ts';
import type { CopyLanguage } from '../Notice/errorCopy.ts';

import './PersonMessage.css';

export interface PersonMessageProps {
  /** The person's name as text: `owner_display_name` for the owner, or "You" on the owner's own screen. */
  name: string;
  /**
   * The initials beside the name, when the name shown isn't the person's own: on the owner's own
   * screen, "You" beside his own initials ("MT"). Left out, they are the name's.
   */
  initials?: string;
  /** What they are here, after the name: "owner". */
  role?: string;
  /** The delivered message's blocks. An owner's say arrives as one `owner_said` block. */
  blocks: readonly RenderedBlock[];
  /** The event's `language`, set as `lang` on the words. */
  language: CopyLanguage;
}

/** The first letter of the first and last words, as written; the name beside them is the text. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word !== '');
  const first = words[0];
  if (first === undefined) return '';
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  return [first, last].map((word) => (word === undefined ? '' : (Array.from(word)[0] ?? ''))).join('');
}

export interface PersonFrameProps {
  /** The person's name, for their initials. */
  name: string;
  /** Their initials, when `name` isn't their own name ("You"); left out, they are the name's. */
  initials?: string;
  /** The line that names them, over their words. */
  who: ReactNode;
  /** That line as a live region, for a line that says they are typing. */
  whoRole?: 'status';
  /** That line's language, when it holds interface words. */
  whoLang?: CopyLanguage;
  /** Under that line, where their words are. */
  children: ReactNode;
}

/**
 * A person's frame in the chat: their initials, hidden from screen readers, the line that names
 * them, and their words under it. `WritingIndicator` draws the same frame while they type, so
 * their message takes its place without moving.
 */
export function PersonFrame({ name, initials, who, whoRole, whoLang, children }: PersonFrameProps) {
  return (
    <div className="cd-person-message">
      <span className="cd-person-message__avatar" aria-hidden="true">
        {initials ?? initialsOf(name)}
      </span>
      <div className="cd-person-message__body">
        <p className="cd-person-message__who cd-type-meta" role={whoRole} lang={whoLang}>
          {who}
        </p>
        {children}
      </div>
    </div>
  );
}

/**
 * A person speaking in the chat, usually the owner after taking over: initials, their name and
 * role, and their words in sans with no bubble. An `owner_said` block shows its text verbatim,
 * without a card frame, because the kernel delivers the owner's words exactly as written.
 */
export function PersonMessage({ name, initials, role, blocks, language }: PersonMessageProps) {
  return (
    <PersonFrame
      name={name}
      initials={initials}
      who={
        <>
          <span className="cd-person-message__name" data-copy="user">
            {name}
          </span>
          {role === undefined || role.trim() === '' ? null : <span className="cd-person-message__role">, {role}</span>}
        </>
      }
    >
      <div className="cd-person-message__words" lang={language} data-copy="user">
        {blocks.map((block, index) =>
          block.text.trim() === '' ? null : (
            <p key={index} className="cd-person-message__text cd-type-message">
              {block.text}
            </p>
          ),
        )}
      </div>
    </PersonFrame>
  );
}
