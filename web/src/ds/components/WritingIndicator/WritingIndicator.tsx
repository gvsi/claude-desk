import type { CopyLanguage, CopyPair } from '../Notice/errorCopy.ts';
import { PersonFrame } from '../PersonMessage/PersonMessage.tsx';

import './WritingIndicator.css';

/** While Claude is writing. */
const CLAUDE_WRITING_COPY: CopyPair = { en: 'Claude is writing', es: 'Claude está escribiendo' };

/** After a person's name while they type: "Dana is typing". */
const PERSON_TYPING_COPY: CopyPair = { en: 'is typing', es: 'está escribiendo' };

interface WritingIndicatorBase {
  /** The language of the line: the visitor's on the public page, the owner's on their screens. */
  language: CopyLanguage;
}

/** One reply line of dots for Claude, or "Dana is typing" with a name. */
export interface WritingLineProps extends WritingIndicatorBase {
  variant?: 'line';
  /** A person's name when they are the one typing ("Dana"); Claude when absent. */
  who?: string;
}

/** A visitor typing, as three dots in a small bubble on their side, the right, where their next bubble appears. */
export interface TypingBubbleProps extends WritingIndicatorBase {
  variant: 'bubble';
  /** The name of the person typing ("Dana"), said to screen readers. A blank name shows nothing. */
  who: string;
}

/**
 * The owner or another person typing on their side, the left: their initials and name, as on their
 * messages, and three dots where their first line of words will start. No fill and no bubble.
 */
export interface PersonTypingProps extends WritingIndicatorBase {
  variant: 'person';
  /** Their name as their messages show it ("Mike Turner"). A blank name shows nothing. */
  who: string;
}

export type WritingIndicatorProps = WritingLineProps | TypingBubbleProps | PersonTypingProps;

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
 * Claude's writing dots, or a person's typing dots, show with the words for screen readers.
 * The stylesheet animates them, so the live region never changes.
 */
function Dots() {
  return (
    <>
      <span className="cd-writing-indicator__dot" />
      <span className="cd-writing-indicator__dot" />
      <span className="cd-writing-indicator__dot" />
    </>
  );
}

/**
 * Shows Claude writing as three dots with the words for screen readers, or "Dana is typing" as
 * a line; a visitor's three dots in a bubble on their side; or a person's initials, name and three
 * dots on theirs, with "{name} is typing" for screen readers. It takes no message text, so a draft
 * never shows before the kernel has checked and delivered the reply.
 */
export function WritingIndicator(props: WritingIndicatorProps) {
  const { language, who } = props;
  const person = who !== undefined && who.trim() !== '' ? who : null;

  if (props.variant === 'bubble') {
    // Only a named person types in a bubble; Claude's writing is always the line.
    if (person === null) return null;
    return (
      <div className="cd-writing-indicator cd-writing-indicator--bubble" role="status" lang={language}>
        <span className="cd-writing-indicator__bubble cd-type-message" aria-hidden="true">
          <Dots />
        </span>
        <span className="cd-sr-only">{personTyping(person, language)}</span>
      </div>
    );
  }

  if (props.variant === 'person') {
    if (person === null) return null;
    // The line that names them is the live region: their name as it shows, then the rest of
    // "{name} is typing" for screen readers only, announced once.
    return (
      <div className="cd-writing-indicator cd-writing-indicator--person">
        <PersonFrame
          name={person}
          whoRole="status"
          whoLang={language}
          who={
            <>
              <bdi className="cd-user-name" data-copy="user">
                {person}
              </bdi>
              <span className="cd-sr-only"> {inLanguage(PERSON_TYPING_COPY, language)}</span>
            </>
          }
        >
          <div className="cd-person-message__words cd-writing-indicator__dots cd-type-message" aria-hidden="true">
            <Dots />
          </div>
        </PersonFrame>
      </div>
    );
  }

  if (person === null) {
    return (
      <p className="cd-writing-indicator cd-writing-indicator--claude cd-type-reply" role="status" lang={language}>
        <span className="cd-writing-indicator__dots" aria-hidden="true"><Dots /></span>
        <span className="cd-sr-only">{inLanguage(CLAUDE_WRITING_COPY, language)}</span>
      </p>
    );
  }

  return (
    <p className="cd-writing-indicator cd-writing-indicator--line cd-type-meta" role="status" lang={language}>
      {personTyping(person, language)}
    </p>
  );
}
