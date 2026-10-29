import type { CopyLanguage, CopyPair } from '../Notice/errorCopy.ts';

import './WritingIndicator.css';

/** While Claude is writing. */
const CLAUDE_WRITING_COPY: CopyPair = { en: 'Claude is writing', es: 'Claude está escribiendo' };

/** After a person's name while they type: "Dana is typing". */
const PERSON_TYPING_COPY: CopyPair = { en: 'is typing', es: 'está escribiendo' };

/**
 * Where a typing person's next message appears: `visitor` on the right, as a visitor's bubble;
 * `person` on the left, as the owner's words after a take-over.
 */
export type TypingSide = 'visitor' | 'person';

interface WritingIndicatorBase {
  /** The language of the line: the visitor's on the public page, the owner's on their screens. */
  language: CopyLanguage;
}

/** One line of words: "Claude is writing", or "Dana is typing" with a name. */
export interface WritingLineProps extends WritingIndicatorBase {
  variant?: 'line';
  /** A person's name when they are the one typing ("Dana"); Claude when absent. */
  who?: string;
}

/** A person typing, as three dots in a small bubble on their side of the transcript. */
export interface TypingBubbleProps extends WritingIndicatorBase {
  variant: 'bubble';
  /** The name of the person typing ("Dana"), said to screen readers. A blank name shows nothing. */
  who: string;
  /** Their side of the transcript; `visitor` (the right) by default. */
  side?: TypingSide;
}

export type WritingIndicatorProps = WritingLineProps | TypingBubbleProps;

function inLanguage(copy: CopyPair, language: CopyLanguage): string {
  return Object.hasOwn(copy, language) ? copy[language] : copy.en;
}

/** "{name} is typing", the name set off as their own words and first in the line. */
function personTyping(person: string, language: CopyLanguage) {
  return (
    <>
      {/* Set off as their own words and first in the line: a name such as "Claude" never reads as Claude. */}
      <bdi className="cd-user-name" data-copy="user">
        {person}
      </bdi>{' '}
      {inLanguage(PERSON_TYPING_COPY, language)}
    </>
  );
}

/**
 * Says that someone is writing: "Claude is writing" or "Dana is typing", or, as a bubble, three
 * dots on the typing person's side with "Dana is typing" for screen readers. It takes no message
 * text, so a draft never shows before the kernel has checked and delivered the reply.
 */
export function WritingIndicator(props: WritingIndicatorProps) {
  const { language, who } = props;
  const person = who !== undefined && who.trim() !== '' ? who : null;

  if (props.variant === 'bubble') {
    // Only a named person types in a bubble; Claude's writing is always the line.
    if (person === null) return null;
    const side = props.side === 'person' ? 'person' : 'visitor';
    return (
      <div className={`cd-writing-indicator cd-writing-indicator--bubble cd-writing-indicator--${side}`} role="status" lang={language}>
        {/* Drawn only: the pulse is the stylesheet's, so the live region never changes and is announced once. */}
        <span className="cd-writing-indicator__bubble cd-type-message" aria-hidden="true">
          <span className="cd-writing-indicator__dot" />
          <span className="cd-writing-indicator__dot" />
          <span className="cd-writing-indicator__dot" />
        </span>
        <span className="cd-sr-only">{personTyping(person, language)}</span>
      </div>
    );
  }

  return (
    <p className="cd-writing-indicator cd-writing-indicator--line cd-type-meta" role="status" lang={language}>
      {person === null ? inLanguage(CLAUDE_WRITING_COPY, language) : personTyping(person, language)}
    </p>
  );
}
