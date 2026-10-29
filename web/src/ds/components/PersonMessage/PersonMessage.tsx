import type { RenderedBlock } from '../../../api/contracts.ts';
import type { CopyLanguage } from '../Notice/errorCopy.ts';

import './PersonMessage.css';

export interface PersonMessageProps {
  /** The person's name as text: `owner_display_name` for the owner, or "You" on the owner's own screen. */
  name: string;
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

/**
 * A person speaking in the chat, usually the owner after taking over: initials, their name and
 * role, and their words in sans with no bubble. An `owner_said` block shows its text verbatim,
 * without a card frame, because the kernel delivers the owner's words exactly as written.
 */
export function PersonMessage({ name, role, blocks, language }: PersonMessageProps) {
  return (
    <div className="cd-person-message">
      <span className="cd-person-message__avatar" aria-hidden="true">
        {initialsOf(name)}
      </span>
      <div className="cd-person-message__body">
        <p className="cd-person-message__who cd-type-meta">
          <span className="cd-person-message__name" data-copy="user">
            {name}
          </span>
          {role === undefined || role.trim() === '' ? null : <span className="cd-person-message__role">, {role}</span>}
        </p>
        <div className="cd-person-message__words" lang={language} data-copy="user">
          {blocks.map((block, index) =>
            block.text.trim() === '' ? null : (
              <p key={index} className="cd-person-message__text cd-type-message">
                {block.text}
              </p>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
