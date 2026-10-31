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
 * An answer as sent: the question it answers, the words, and how many messages the interview held
 * when it was sent, so a read can tell what came after.
 */
interface Answer {
  question: QuestionKey;
  text: string;
  seen: number;
  /** The API refused it (a 409 to its first send): final, whatever a later read holds. */
  refused?: true;
}

/**
 * What a read of the interview says about an answer whose reply didn't settle it. Taken: the
 * owner's exact words are among the messages that came after it was sent, whether or not the
 * question moved on (a turn can ask a follow-up on the same question). Refused: something else
 * came after it, the question moved on or another answer was stored, without these words. Unknown:
 * nothing has come since, and a turn may still be running.
 */
function outcomeOf(now: SetupState, answer: Answer): 'taken' | 'refused' | 'unknown' {
  const since = now.messages.slice(answer.seen);
  const words = answer.text.trim();
  if (since.some((message) => message.role === 'owner' && message.text.trim() === words)) return 'taken';
  const movedPast = now.step !== 'questions' || now.question !== answer.question;
  return since.length > 0 || movedPast ? 'refused' : 'unknown';
}

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
   * Sends `answer` for its own question. A 409 to a first send is the API's refusal: the interview
   * is read and the words go back in the composer for the question it now asks. A lost reply reads
   * the interview, and what came after the answer was sent settles it (`outcomeOf`): taken moves
   * the page on; refused puts the words back; unknown, or a read that fails, keeps them with
   * "Try again". Sent again (`again`), a 409 is settled the same way, since the first send may have
   * been taken. Words a read shows stored are never sent again or put back.
   */
  const submit = async (answer: Answer, again = false) => {
    setSending(answer.text);
    setFailed(null);
    try {
      onState(await request('setupAnswer', { params: { id }, body: { question: answer.question, text: answer.text } }));
      setSending(null);
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      const refused = err instanceof ApiError && err.kind === 'conflict';
      const now = refused || isUncertain(err) ? await reread() : null;
      setSending(null);
      if (now === null) {
        // Kept with "Try again"; a first send's refusal is remembered, since a read can't undo it.
        setFailed(refused && !again ? { ...answer, refused: true } : answer);
        return;
      }
      if (refused && !again) {
        setRefill({ text: answer.text });
        return;
      }
      const outcome = outcomeOf(now, answer);
      if (outcome === 'taken') return;
      if (outcome === 'refused') setRefill({ text: answer.text });
      else setFailed(answer);
    }
  };

  /**
   * "Try again" reads the interview first, since the answer may have been taken, by a reply that
   * was lost or by a turn that committed late. Taken: the page moves on with nothing sent. Refused:
   * the words go back in the composer for the question now asked. Unknown: the same words are sent
   * again as the answer to the question they were written for, never to another. A read that fails
   * changes nothing, and the failed box stays.
   */
  const retry = async () => {
    if (failed === null || retrying) return;
    setRetrying(true);
    const now = await reread();
    setRetrying(false);
    if (now === null) return;
    const kept = failed;
    // A send the API refused gets its words back, whatever the conversation now holds.
    if (kept.refused) {
      setFailed(null);
      setRefill({ text: kept.text });
      return;
    }
    const outcome = outcomeOf(now, kept);
    if (outcome === 'unknown') {
      void submit(kept, true);
      return;
    }
    setFailed(null);
    if (outcome === 'refused') setRefill({ text: kept.text });
  };

  /** The composer's words: the answer to the question the page shows. */
  const send = (text: string) => {
    // While an answer is unsettled the composer shows it with "Try again", which reads first; nothing posts blind.
    if (failed !== null || retrying) return;
    if (state.question === null) {
      // No question is waiting here: read where the interview stands, and keep the words.
      setRefill({ text });
      void reread();
      return;
    }
    void submit({ question: state.question, text, seen: state.messages.length });
  };

  useEffect(() => {
    const box = composer.current?.querySelector('textarea');
    if (refill === null || !box || box.disabled) return;
    fillComposer(box, refill.text);
    setRefill(null);
  }, [refill, sending, retrying, failed]);

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
          <Composer
            variant="owner"
            label={copy.composerLabel}
            placeholder={copy.placeholder}
            maxLength={ANSWER_MAX}
            disabled={sending !== null || retrying}
            onSend={send}
            {...(failed === null ? {} : { failed: { text: failed.text, line: copy.failed, onRetry: () => void retry() } })}
          />
        </div>
      )}
    </div>
  );
}
