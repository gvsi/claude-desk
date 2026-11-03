import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Button, ConceptFooter, Notice, PageHeader, Transcript } from '../ds/index.ts';
import { useTopFade } from '../lib/useTopFade.ts';
import { SETUP_COPY, setupStartLostLine, setupStartSlowLine, setupStartSpentLine } from './copy.ts';
import { OwnerWords, StartingRead, type StartScreen } from './SetupStartTransition.tsx';
import type { StartFailure } from './StartStep.tsx';
import './SetupConversation.css';

const copy = SETUP_COPY.questions;

/** Each way a start can stay unsettled, by its line. */
const FAILURE_LINES: Readonly<Record<StartFailure, () => string>> = {
  lost: setupStartLostLine,
  under_way: setupStartSlowLine,
  spent: setupStartSpentLine,
};

export interface StartingChatProps {
  /** The owner's own description, as it was sent: their first message. */
  words: string;
  /** Why the start isn't settled, said where Claude's writing dots were; null while it is sent. */
  failure: StartFailure | null;
  /** "Try again": the start sent again (`useSetupStart`). */
  onTryAgain: () => void;
  /** The start page as it left, for the chat's entrance; null for none (reduced motion). */
  from?: StartScreen | null;
}

/**
 * Setup's chat while its start runs, from the press of "Start": the conversation as its interview
 * opens it (`QuestionsStep`, in the same frame), the owner's own words as their first message,
 * Claude's read of them with a quieter line on how long it takes, and Claude's writing dots where
 * its first message will be. A start that doesn't settle says so in their place, with "Try again".
 * Once the interview is made, it opens in this chat's place, the owner's words and the read where
 * they were and the memory question where the dots were.
 *
 * How it comes in and hands off is SetupStartTransition's, the one place the transition moves.
 */
export function StartingChat({ words, failure, onTryAgain, from = null }: StartingChatProps) {
  const title = useRef<HTMLHeadingElement>(null);
  // Just come in from the start page: what follows the words waits for their move. Not once a start
  // didn't settle: tried again, it comes back at once.
  const [entering, setEntering] = useState(from !== null);
  useEffect(() => {
    if (failure !== null) setEntering(false);
  }, [failure]);
  const scroll = useRef<HTMLDivElement>(null);
  // Messages fade where they scroll under the bar, as the interview's do.
  useTopFade(scroll, '.cd-setup-chat__scroll');
  // "Start" went with the form: the chat's heading takes focus in its place, so the page doesn't lose it.
  useLayoutEffect(() => {
    if (document.activeElement === null || document.activeElement === document.body) title.current?.focus({ preventScroll: true });
  }, []);
  // A long description keeps what comes after it in view: the dots, or the line in their place.
  useLayoutEffect(() => {
    const pane = scroll.current;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }, [failure]);

  return (
    <div className={`cd-setup-chat cd-setup-start-transition${entering ? ' cd-setup-start-transition--entering' : ''}`}>
      <div
        className="cd-setup-chat__scroll"
        ref={scroll}
        tabIndex={0}
        // Keyboard users can scroll here; clicking transcript text keeps focus where it was.
        onPointerUp={(event) => {
          if (document.activeElement === event.currentTarget) event.currentTarget.blur();
        }}
      >
        <div className="cd-setup-chat__column cd-setup-step">
          <PageHeader title={copy.title} titleRef={title} />
          <Transcript label={copy.conversation}>
            <OwnerWords words={words} from={from} />
            {failure === null ? <StartingRead afterMove={entering} /> : null}
          </Transcript>
          {failure === null ? null : (
            <Notice
              tone="error"
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    // "Try again" goes with its line: focus moves to the chat's heading rather than the page.
                    title.current?.focus({ preventScroll: true });
                    onTryAgain();
                  }}
                >
                  {copy.tryAgain}
                </Button>
              }
            >
              {FAILURE_LINES[failure]()}
            </Notice>
          )}
        </div>
      </div>
      <div className="cd-setup-dock">
        <div className="cd-setup-dock__column">
          <ConceptFooter />
        </div>
      </div>
    </div>
  );
}
