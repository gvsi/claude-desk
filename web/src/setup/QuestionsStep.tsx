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

/**
 * An answer that didn't go through: the question it answers, the words, and whether the API may
 * have taken it (its reply was lost, and the interview couldn't be read to say) or plainly didn't.
 */
interface Answer {
  question: QuestionKey;
  text: string;
  /** The API may have taken it: true after a lost reply, false after a refusal. */
  unknown: boolean;
}

/** The interview no longer waits on `question`: an answer to it was taken, here or elsewhere. */
const movedPast = (state: SetupState, question: QuestionKey) => state.step !== 'questions' || state.question !== question;

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
function AnswerBox({
  failed,
  sending,
  retrying,
  onSend,
  onRetry,
}: {
  failed: boolean;
  sending: boolean;
  retrying: boolean;
  onSend: (text: string) => void;
  onRetry: () => void;
}) {
  return (
    <>
      {failed ? (
        <Notice
          tone="error"
          action={
            <Button variant="secondary" busy={retrying} onClick={onRetry}>
              {copy.tryAgain}
            </Button>
          }
        >
          {copy.failed}
        </Notice>
      ) : null}
      <Composer variant="owner" label={copy.composerLabel} placeholder={copy.placeholder} maxLength={ANSWER_MAX} disabled={sending || retrying} onSend={onSend} />
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
  /** "Try again" is reading the interview. */
  const [retrying, setRetrying] = useState(false);
  /** A consent whose reply was lost, and the read after it too: the next press reads first. */
  const [consentUnknown, setConsentUnknown] = useState(false);
  /** Words to put back in the composer once it takes text again. */
  const [refill, setRefill] = useState<{ text: string } | null>(null);
  const id = state.interview_id;
  const asking = awaitsConsent(state);
  const number = questionNumber(state);

  /**
   * The consent, sent once. A lost reply, or a 409 (it was given already), reads the interview,
   * which says whether it was taken. When that read fails too, the outcome is unknown: the next
   * press reads first and sends only if consent is still awaited, so it is never given twice.
   */
  const consent = async (allow: boolean) => {
    if (consenting !== null) return;
    setConsenting(allow);
    try {
      if (consentUnknown) {
        // Still unknown while the interview can't be read: the line already says so.
        const now = await reread();
        if (now === null) return;
        setConsentUnknown(false);
        setConsentError(null);
        if (!awaitsConsent(now)) return;
      }
      setConsentError(null);
      onState(await request('setupConsent', { params: { id }, body: { allow } }));
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      const unsure = isUncertain(err) || (err instanceof ApiError && err.kind === 'conflict');
      const now = unsure ? await reread() : null;
      if (now !== null && !awaitsConsent(now)) return;
      if (unsure && now === null) setConsentUnknown(true);
      setConsentError(ownerErrorCopy(err));
    } finally {
      setConsenting(null);
    }
  };

  /**
   * Sends `answer` for its own question, decided only by the question and where the interview
   * stands, never by the words. A refusal (a 409 means the interview moved past that question
   * before these words reached it) keeps the words: the interview is read, and they stay in the
   * composer for the question now asked. A lost reply reads the interview: moved past that question
   * means the answer was taken, so the page moves on; still on it means it wasn't, and the words
   * come back with the failure line; a read that fails leaves the outcome unknown, with the words
   * and the line.
   */
  const submit = async (answer: Omit<Answer, 'unknown'>) => {
    setSending(answer.text);
    setFailed(null);
    try {
      onState(await request('setupAnswer', { params: { id }, body: { question: answer.question, text: answer.text } }));
      setSending(null);
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      if (err instanceof ApiError && err.kind === 'conflict') {
        const now = await reread();
        setSending(null);
        if (now === null) setFailed({ ...answer, unknown: false });
        setRefill({ text: answer.text });
        return;
      }
      const now = isUncertain(err) ? await reread() : null;
      setSending(null);
      if (now !== null && movedPast(now, answer.question)) return;
      setFailed({ ...answer, unknown: isUncertain(err) && now === null });
      setRefill({ text: answer.text });
    }
  };

  /**
   * "Try again", and Send while an answer didn't go through: the interview is read first, since the
   * answer may have been taken. Moved past its question: one taken unknowingly moves the page on,
   * with nothing sent; one refused keeps its words for the question now asked. Still on it: the
   * words are sent as the answer to that question, never to another. A read that fails changes
   * nothing, and the line stays.
   */
  const retry = async (typed?: string) => {
    if (failed === null || retrying) return;
    setRetrying(true);
    const now = await reread();
    setRetrying(false);
    const box = composer.current?.querySelector('textarea');
    const text = typed ?? (box?.value.trim() || failed.text);
    if (now === null) {
      if (typed !== undefined) setRefill({ text });
      return;
    }
    if (movedPast(now, failed.question)) {
      setFailed(null);
      if (failed.unknown) {
        if (box) fillComposer(box, '');
      } else if (typed !== undefined) {
        setRefill({ text });
      }
      return;
    }
    if (box) fillComposer(box, '');
    void submit({ question: failed.question, text });
  };

  /** The composer's words: the answer to the question the page shows, unless one before them is still unsettled. */
  const send = (text: string) => {
    if (failed !== null) {
      void retry(text);
      return;
    }
    if (state.question === null) {
      // No question is waiting here: read where the interview stands, and keep the words.
      setRefill({ text });
      void reread();
      return;
    }
    void submit({ question: state.question, text });
  };

  useEffect(() => {
    const box = composer.current?.querySelector('textarea');
    if (refill === null || !box || box.disabled) return;
    fillComposer(box, refill.text);
    setRefill(null);
  }, [refill, sending, retrying]);

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
          <AnswerBox failed={failed !== null} sending={sending !== null} retrying={retrying} onSend={send} onRetry={() => void retry()} />
        </div>
      )}
    </div>
  );
}
