import { useEffect, useRef, useState } from 'react';

import { ApiError, isUncertain, ownerErrorCopy, request } from '../api/http.ts';
import type { SetupMessage, SetupState } from '../api/views.ts';
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

/** The owner hasn't been asked to let Claude read their memory and website yet, or hasn't answered. */
function awaitsConsent(state: SetupState): boolean {
  if (state.consent !== undefined) return state.consent === null;
  return !state.messages.some((message) => message.role === 'owner');
}

/**
 * The question in view, counted from 1: the API's own when it says which (`question`), else the
 * questions Claude has asked since the consent question. Null before consent.
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
  const [failed, setFailed] = useState<string | null>(null);
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

  const send = async (text: string) => {
    setSending(text);
    setFailed(null);
    try {
      onState(await request('setupAnswer', { params: { id }, body: { text } }));
      setSending(null);
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      // A lost answer may have been taken: one the interview now holds isn't asked for again.
      const now = isUncertain(err) ? await reread() : null;
      setSending(null);
      if (now !== null && now.messages.length > state.messages.length) return;
      setFailed(text);
      setRefill({ text });
    }
  };

  useEffect(() => {
    const box = composer.current?.querySelector('textarea');
    if (refill === null || !box || box.disabled) return;
    fillComposer(box, refill.text);
    setRefill(null);
  }, [refill, sending]);

  const retry = () => {
    const box = composer.current?.querySelector('textarea');
    const text = box?.value.trim() || failed;
    if (!text) return;
    if (box) fillComposer(box, '');
    void send(text);
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
          <AnswerBox failed={failed !== null} sending={sending !== null} onSend={(text) => void send(text)} onRetry={retry} />
        </div>
      )}
    </div>
  );
}
