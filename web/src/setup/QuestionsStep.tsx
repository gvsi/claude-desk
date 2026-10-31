import { useEffect, useRef, useState } from 'react';

import { ApiError, isUncertain, ownerErrorCopy, request } from '../api/http.ts';
import type { QuestionKey, SetupMessage, SetupState } from '../api/views.ts';
import { Button, ClaudeMessage, Composer, Notice, PageHeader, ToolLabel, Transcript, VisitorMessage, WritingIndicator } from '../ds/index.ts';
import { fillComposer } from '../lib/composer.ts';
import { QUESTION_ORDER, SETUP_COPY } from './copy.ts';

/** Plan 02's limit on an answer. */
const ANSWER_MAX = 2000;

const copy = SETUP_COPY.questions;

export interface QuestionsStepProps {
  state: SetupState;
  /** The API answered with the interview as it stands. */
  onState: (state: SetupState) => void;
  /** Reads the interview again after a write whose answer was lost; null when it can't be read. */
  reread: () => Promise<SetupState | null>;
}

/** The owner hasn't answered whether Claude may read their memory and website. */
function awaitsConsent(state: SetupState): boolean {
  return state.consent === null;
}

/** An answer as sent: the question it answers, the words, and how often the owner had said those words before. */
interface Answer {
  question: QuestionKey;
  text: string;
  before: number;
}

/** How often the conversation holds the owner saying `text`. */
const timesSaid = (state: SetupState, text: string) => state.messages.filter((message) => message.role === 'owner' && message.text === text).length;

/** The interview, as read, holds the answer: its words are there once more than before it was sent. */
const holds = (state: SetupState, answer: Answer) => timesSaid(state, answer.text) > answer.before;

/**
 * The question in view, counted from 1: the API's own (`question`), else the questions Claude has
 * asked since the consent question. Null before consent.
 */
function questionNumber(state: SetupState): number | null {
  if (awaitsConsent(state)) return null;
  const at = state.question == null ? -1 : QUESTION_ORDER.indexOf(state.question);
  if (at !== -1) return at + 1;
  const asked = state.messages.filter((message) => message.role === 'claude').length - 1;
  return Math.min(Math.max(asked, 1), QUESTION_ORDER.length);
}

/** One line of the conversation: Claude's in its serif, the owner's as theirs, a read as its label. */
function Line({ message }: { message: SetupMessage }) {
  if (message.role === 'claude') return <ClaudeMessage blocks={[{ kind: 'prose', text: message.text }]} language="en" ownerName="" />;
  if (message.role === 'owner') return <VisitorMessage text={message.text} />;
  return <ToolLabel text={message.text} />;
}

/**
 * Where the owner answers, and how an answer that didn't go through comes back: the line saying so
 * with "Try again", and the words back in the composer.
 * stopgap: swap for the design system's failed-send state on `Composer` (the words kept in the box
 * with "Try again" inside it, N-R2-Setup-04-Answer-Failed) once it is on main.
 */
function AnswerBox({ failed, sending, onSend, onRetry }: { failed: boolean; sending: boolean; onSend: (text: string) => void; onRetry: () => void }) {
  return (
    <>
      {failed ? (
        <Notice
          tone="error"
          action={
            <Button variant="secondary" onClick={onRetry}>
              {copy.tryAgain}
            </Button>
          }
        >
          {copy.failed}
        </Notice>
      ) : null}
      <Composer variant="owner" label={copy.composerLabel} placeholder={copy.placeholder} maxLength={ANSWER_MAX} disabled={sending} onSend={onSend} />
    </>
  );
}

/**
 * "A few questions": the setup conversation in order, Claude's words in its serif, the owner's as
 * theirs and each read of their memory or website as its label. First Claude asks to read the
 * owner's Claude memory ("Yes, use it" or "No, I'll type it"); then each answer goes to the API,
 * which asks the next question. An answer that didn't go through stays in the composer.
 */
export function QuestionsStep({ state, onState, reread }: QuestionsStepProps) {
  const composer = useRef<HTMLDivElement>(null);
  const [consenting, setConsenting] = useState<boolean | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  /** The answer that didn't go through, or whose outcome is unknown, with the question it answers. */
  const [failed, setFailed] = useState<Answer | null>(null);
  /** Words to put back in the composer once it takes text again. */
  const [refill, setRefill] = useState<{ text: string } | null>(null);
  const id = state.interview_id;
  const asking = awaitsConsent(state);
  const number = questionNumber(state);

  const consent = async (allow: boolean) => {
    if (consenting !== null) return;
    setConsenting(allow);
    setConsentError(null);
    try {
      onState(await request('setupConsent', { params: { id }, body: { allow } }));
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      // A lost answer may have been taken: the interview as it stands says whether it was.
      const now = isUncertain(err) ? await reread() : null;
      if (now === null || awaitsConsent(now)) setConsentError(ownerErrorCopy(err));
    } finally {
      setConsenting(null);
    }
  };

  /**
   * Sends `answer` for its own question. A lost answer may have been taken, and one the API refuses
   * as stale (409) means the interview has moved past that question: either way the interview is
   * read, and where it stands says what happened. Taken: on to the next question. Moved past without
   * these words: they stay in the composer for the question now asked. Else they come back with the
   * failure line.
   */
  const submit = async (answer: Answer) => {
    setSending(answer.text);
    setFailed(null);
    try {
      onState(await request('setupAnswer', { params: { id }, body: { question: answer.question, text: answer.text } }));
      setSending(null);
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      const unknown = isUncertain(err) || (err instanceof ApiError && err.kind === 'conflict');
      const now = unknown ? await reread() : null;
      setSending(null);
      if (now !== null && holds(now, answer)) return;
      if (now !== null && (now.step !== 'questions' || now.question !== answer.question)) {
        setRefill({ text: answer.text });
        return;
      }
      setFailed(answer);
      setRefill({ text: answer.text });
    }
  };

  /** The composer's words, as the answer to the question the page shows. */
  const send = (text: string) => {
    if (state.question === null) {
      // No question is waiting here: read where the interview stands, and keep the words.
      setRefill({ text });
      void reread();
      return;
    }
    void submit({ question: state.question, text, before: timesSaid(state, text) });
  };

  useEffect(() => {
    const box = composer.current?.querySelector('textarea');
    if (refill === null || !box || box.disabled) return;
    fillComposer(box, refill.text);
    setRefill(null);
  }, [refill, sending]);

  /** "Try again": the words in the composer, still as the answer to the question they were written for. */
  const retry = () => {
    if (failed === null) return;
    const box = composer.current?.querySelector('textarea');
    const text = box?.value.trim() || failed.text;
    if (box) fillComposer(box, '');
    void submit({ ...failed, text });
  };

  return (
    <div className="cd-setup-step">
      <PageHeader title={copy.title} subtitle={number === null ? copy.beforeConsent : copy.counter(number, QUESTION_ORDER.length)} />
      <Transcript label={copy.conversation}>
        {state.messages.map((message, index) => (
          <Line key={`${index}-${message.role}`} message={message} />
        ))}
        {sending !== null ? <VisitorMessage text={sending} /> : null}
        {sending !== null ? <WritingIndicator language="en" /> : null}
      </Transcript>
      {asking ? (
        <>
          {consentError === null ? null : <Notice tone="error">{consentError}</Notice>}
          <div className="cd-setup-step__actions">
            <Button variant="primary" size="main" busy={consenting === true} waiting={consenting === false} onClick={() => void consent(true)}>
              {copy.allow}
            </Button>
            <Button variant="secondary" size="main" busy={consenting === false} waiting={consenting === true} onClick={() => void consent(false)}>
              {copy.decline}
            </Button>
          </div>
        </>
      ) : (
        <div ref={composer}>
          <AnswerBox failed={failed !== null} sending={sending !== null} onSend={send} onRetry={retry} />
        </div>
      )}
    </div>
  );
}
