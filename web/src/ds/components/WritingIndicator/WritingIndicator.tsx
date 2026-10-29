import type { CopyLanguage, CopyPair } from '../Notice/errorCopy.ts';

import './WritingIndicator.css';

/** While Claude is writing. */
const CLAUDE_WRITING_COPY: CopyPair = { en: 'Claude is writing', es: 'Claude está escribiendo' };

/** After a person's name while they type: "Dana is typing". */
const PERSON_TYPING_COPY: CopyPair = { en: 'is typing', es: 'está escribiendo' };

export interface WritingIndicatorProps {
  /** The language of the line: the visitor's on the public page, the owner's on their screens. */
  language: CopyLanguage;
  /** A person's name when they are the one typing ("Dana"); Claude when absent. */
  who?: string;
}

function inLanguage(copy: CopyPair, language: CopyLanguage): string {
  return Object.hasOwn(copy, language) ? copy[language] : copy.en;
}

/**
 * Says that someone is writing: "Claude is writing" or "Dana is typing". It takes no message
 * text, so a draft never shows before the kernel has checked and delivered the reply.
 */
export function WritingIndicator({ language, who }: WritingIndicatorProps) {
  const person = who !== undefined && who.trim() !== '' ? who : null;
  return (
    <p className="cd-writing-indicator cd-type-meta" role="status" lang={language}>
      {person === null ? (
        inLanguage(CLAUDE_WRITING_COPY, language)
      ) : (
        <>
          <span data-copy="user">{person}</span> {inLanguage(PERSON_TYPING_COPY, language)}
        </>
      )}
    </p>
  );
}
