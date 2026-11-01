import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { ApiError, isUncertain, ownerErrorCopy, request } from '../api/http.ts';
import type { SetupAnswerBody, SetupMessage, SetupState } from '../api/views.ts';
import { Button, ClaudeMessage, Composer, ConceptFooter, Notice, PageHeader, ToolLabel, Transcript, VisitorMessage, WritingIndicator } from '../ds/index.ts';
import { fillComposer } from '../lib/composer.ts';
import { SETUP_COPY, stillCheckingLine } from './copy.ts';
import { ProposalCard, type CardDecision } from './ProposalCard.tsx';
import { isCard, liveChoices } from './conversation.ts';
import { SetupChoices } from './SetupChoices.tsx';
import './SetupConversation.css';
import { useSetupWork } from './useSetupWork.ts';

/** Plan 02's limit on an answer. */
const ANSWER_MAX = 2000;

const copy = SETUP_COPY.questions;
const ACTIVE_CHOICE = '.cd-setup-q3__list button[aria-current="true"]:not(:disabled), .cd-setup-q3__row.is-active input:not(:disabled)';

export interface QuestionsStepProps {
  state: SetupState;
  onContinue: () => void;
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
type Answer = SetupAnswerBody & {
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
  const movedPast = now.step !== 'questions' || now.question !== answer.question || (answer.question === null && now.pending_card !== answer.card);
  return since.length > 0 || movedPast ? 'refused' : 'unknown';
}

/** One line of the conversation: Claude's in its serif, the owner's as theirs, a read as its label. */
function Line({ message }: { message: SetupMessage }) {
  if (message.role === 'claude') return <ClaudeMessage blocks={[{ kind: 'prose' as const, text: message.text }]} language="en" ownerName="" />;
  if (message.role === 'owner') return <VisitorMessage text={message.text} />;
  return <ToolLabel text={message.text} />;
}

/**
 * "A few questions": the setup conversation in order, Claude's words in its serif, the owner's as
 * theirs and each read of their memory or website as its label. First Claude asks to read the
 * owner's Claude memory ("Yes, use it" or "No, I'll type it"); then each answer goes to the API,
 * which asks the next question. An answer that didn't go through stays in the composer.
 */
export function QuestionsStep({ state, onState, reread, onContinue }: QuestionsStepProps) {
  const step = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(false);
  const returnToTextarea = useRef(false);
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
  const [amountRequired, setAmountRequired] = useState<string | null>(null);
  const [decisionFailed, setDecisionFailed] = useState<CardDecision | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<CardDecision | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(() => new Set());
  const id = state.interview_id;
  const asking = awaitsConsent(state);
  const closing = state.step !== 'questions';
  const live = liveChoices(state);
  const busy = state.busy === true;
  const consentBusy = busy && !asking && state.question === null && !state.pending_card && state.messages.filter(({ role }) => role === 'claude').length === 1;
  const blocked = busy || sending !== null || deciding !== null || suggesting || retrying || consenting !== null;
  const panel = live && !closing && !asking && !dismissed.has(live.index) ? live : null;
  const closePanel = () => {
    if (live) setDismissed((previous) => new Set([...previous, live.index]));
  };
  const dismissPanel = () => {
    closePanel();
    composer.current?.querySelector('textarea')?.focus({ preventScroll: true });
  };
  useEffect(() => { if (!busy) setDeciding(null); }, [busy]);
  const work = useSetupWork(state, reread);
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && asking) setConsentError(stillCheckingLine());
    wasBusy.current = busy;
  }, [busy, asking]);
  const waitingForFirstQuestion = useRef(asking || consentBusy);

  useEffect(() => {
    if (asking || consentBusy) waitingForFirstQuestion.current = true;
    if (asking || blocked) return;
    if (!waitingForFirstQuestion.current || state.question === null) return;
    waitingForFirstQuestion.current = false;
    const target = panel ? step.current?.querySelector<HTMLElement>(ACTIVE_CHOICE)
      : window.matchMedia('(pointer: fine)').matches ? composer.current?.querySelector('textarea') : null;
    const focus = document.activeElement;
    if (!target || (focus !== document.body && !step.current?.contains(focus))) return;
    target.focus({ preventScroll: true });
  }, [asking, blocked, consentBusy, state.question, panel?.index]);

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
      if (now !== null && (now.busy === true || !awaitsConsent(now))) return;
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
    if (composer.current?.contains(document.activeElement)) {
      returnFocus.current = true;
      if (!again) returnToTextarea.current = true;
    }
    setSending(answer.text);
    setFailed(null);
    setDecisionFailed(null);
    setAmountRequired(null);
    setSuggestionsError(null);
    try {
      const next = await request('setupAnswer', { params: { id }, body: answer.question === null ? { question: null, card: answer.card, text: answer.text } : { question: answer.question, text: answer.text } });
      onState(next);
      if (next.busy === true && outcomeOf(next, answer) !== 'taken') setRefill({ text: answer.text });
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
    returnFocus.current = composer.current?.contains(document.activeElement) ?? false;
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

  const suggestions = async () => {
    if (suggesting || busy || sending !== null || deciding !== null) return;
    setSuggesting(true);
    setSuggestionsError(null);
    try {
      onState(await request('setupSuggestions', { params: { id }, body: {} }));
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      if (isUncertain(err)) {
        const now = await reread();
        if (now !== null && (now.step !== 'questions' || now.busy === true)) return;
      }
      setSuggestionsError(ownerErrorCopy(err));
    } finally {
      setSuggesting(false);
    }
  };

  const decide = async (decision: CardDecision) => {
    if (deciding !== null || busy || sending !== null) return;
    returnFocus.current = true;
    returnToTextarea.current = false;
    setDeciding(decision);
    setDecisionFailed(null);
    setAmountRequired(null);
    let background = false;
    try {
      const next = await request('setupProposal', { params: { id, proposal_id: decision.proposal_id }, body: decision.body });
      background = next.busy === true;
      onState(next);
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      if (err instanceof ApiError && err.status === 422) {
        await reread();
        const proposal = state.messages.find(({ card }) => card?.proposal_id === decision.proposal_id)?.card;
        if (proposal?.job?.job === 'payment') setAmountRequired(decision.proposal_id);
        return;
      }
      if (err instanceof ApiError && (err.kind === 'not_found' || err.kind === 'conflict')) {
        if (await reread() !== null) return;
      }
      setDecisionFailed(decision);
    } finally {
      if (!background) setDeciding(null);
    }
  };

  /** The composer's words: the answer to the question the page shows. */
  const send = (text: string) => {
    // While an answer is unsettled the composer shows it with "Try again", which reads first; nothing posts blind.
    if (failed !== null || retrying) return;
    if (state.question === null && !state.pending_card) {
      // No question is waiting here: read where the interview stands, and keep the words.
      setRefill({ text });
      void reread();
      return;
    }
    closePanel();
    void submit(state.question === null
      ? { question: null, card: state.pending_card!, text, seen: state.messages.length }
      : { question: state.question, text, seen: state.messages.length });
  };

  useEffect(() => {
    const box = composer.current?.querySelector('textarea');
    if (refill === null || !box || box.disabled) return;
    fillComposer(box, refill.text, { focus: false });
    setRefill(null);
  }, [refill, sending, retrying, failed, busy]);

  useEffect(() => {
    // Disabling the textarea drops focus to the page. An owner's move elsewhere cancels its return,
    // including a click on text that doesn't itself take focus.
    const leave = (event: Event) => {
      if (event.target instanceof Node && !composer.current?.contains(event.target)) returnFocus.current = false;
    };
    document.addEventListener('focusin', leave);
    document.addEventListener('pointerdown', leave);
    return () => {
      document.removeEventListener('focusin', leave);
      document.removeEventListener('pointerdown', leave);
    };
  }, []);

  useEffect(() => {
    if (blocked || !returnFocus.current) return;
    returnFocus.current = false;
    const field = composer.current?.querySelector<HTMLElement>('textarea:not(:disabled)');
    const pending = state.messages.find(({ card }) => card?.proposal_id === state.pending_card)?.card;
    const config = pending?.job?.config;
    const unpriced = pending?.job?.job === 'payment'
      && (config?.block !== 'purpose_payment' || config.amount_cents === null || config.amount_cents <= 0);
    const cardTarget = pending ? unpriced
      ? step.current?.querySelector<HTMLElement>('.cd-setup-c3__amount input:not(:disabled):not([readonly])')
      : step.current?.querySelector<HTMLElement>('.cd-setup-c3__actions button:not(:disabled)') : null;
    const target = failed ? composer.current?.querySelector<HTMLElement>('button:not(:disabled)')
      : decisionFailed ? step.current?.querySelector<HTMLElement>('.cd-setup-c3__failed button:not(:disabled)')
      : panel ? step.current?.querySelector<HTMLElement>(ACTIVE_CHOICE)
      : closing ? step.current?.querySelector<HTMLElement>('.cd-setup-dock button')
      : returnToTextarea.current ? field
      : cardTarget ?? (window.matchMedia('(pointer: fine)').matches ? field : null);
    target?.focus({ preventScroll: true });
  }, [blocked, failed, decisionFailed, closing, panel?.index, state.pending_card, state.messages]);

  useLayoutEffect(() => {
    const pane = scroll.current;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }, [state.messages.length, busy, sending, deciding, panel?.index]);

  useEffect(() => {
    const pane = scroll.current;
    if (!pane) return;
    let pinned = true;
    let previousEnd = pane.scrollHeight - pane.clientHeight;
    const notePlace = () => {
      const end = pane.scrollHeight - pane.clientHeight;
      if (end - pane.scrollTop <= 1) pinned = true;
      // A resize can move the end before its scroll event arrives. Only a move away from
      // both the old and the new end means the owner scrolled back to read.
      else if (previousEnd - pane.scrollTop > 1) pinned = false;
      previousEnd = end;
    };
    pane.addEventListener('scroll', notePlace, { passive: true });
    const observer = new ResizeObserver(() => {
      if (pinned) pane.scrollTop = pane.scrollHeight;
      previousEnd = pane.scrollHeight - pane.clientHeight;
    });
    observer.observe(pane);
    if (pane.firstElementChild) observer.observe(pane.firstElementChild);
    return () => {
      pane.removeEventListener('scroll', notePlace);
      observer.disconnect();
    };
  }, []);

  return (
    <div className="cd-setup-chat" ref={step}>
      <div className="cd-setup-chat__scroll" ref={scroll} tabIndex={0}
        // Keyboard users can scroll here; clicking transcript text keeps the existing body-focus behavior.
        onPointerUp={(event) => { if (document.activeElement === event.currentTarget) event.currentTarget.blur(); }}>
      <div className="cd-setup-chat__column cd-setup-step">
      <PageHeader title={copy.title} />
      <Transcript label={copy.conversation}>
        {state.messages.map((message, index) => (
          <Fragment key={`${index}-${message.role}`}>
            {panel?.index === index ? null : isCard(message) ? <ProposalCard proposal={message.card!}
              amountRequired={amountRequired === message.card!.proposal_id}
              failed={decisionFailed?.proposal_id === message.card!.proposal_id}
              onRetry={() => { if (decisionFailed) void decide(decisionFailed); }}
              live={state.step === 'questions' && state.pending_card === message.card!.proposal_id && message.card!.state === 'proposed'}
              busyAction={deciding?.proposal_id === message.card!.proposal_id ? deciding.action : null}
              disabled={blocked || failed !== null}
              onDecision={(decision) => void decide(decision)}
            /> : <Line message={message} />}
          </Fragment>
        ))}
        {sending !== null ? <VisitorMessage text={sending} /> : null}
        {sending !== null || busy || deciding !== null || suggesting ? <WritingIndicator language="en" /> : null}
        {consentBusy ? (
          <p className="cd-setup-step__line cd-type-meta">{copy.putting}</p>
        ) : null}
      </Transcript>
      {work.gaveUp ? (
        <Notice
          tone="error"
          action={
            <Button variant="secondary" busy={work.retrying} onClick={() => void work.retry()}>
              {copy.tryAgain}
            </Button>
          }
        >
          {stillCheckingLine()}
        </Notice>
      ) : null}
      </div></div>
      <div className="cd-setup-dock"><div className="cd-setup-dock__column">
      {panel ? <SetupChoices key={panel.index} question={state.messages[panel.index]!.text} choices={panel.choices}
        maxLength={ANSWER_MAX} disabled={blocked || failed !== null} onDismiss={dismissPanel}
        onChoose={(text) => { returnFocus.current = true; returnToTextarea.current = false; send(text); }} /> : null}
      {closing ? <div className="cd-setup-step__actions"><Button variant="primary" size="main" onClick={onContinue}>{SETUP_COPY.tools.continue}</Button></div> : asking && !busy ? (
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
            disabled={blocked}
            onSend={send}
            {...(failed === null ? {} : { failed: { text: failed.text, line: copy.failed, onRetry: () => void retry() } })}
          />
        </div>
      )}
      {!closing && !asking ? <div className="cd-setup-suggestions">
        <Button variant="ghost" busy={suggesting} waiting={!suggesting && (blocked || failed !== null)} onClick={() => void suggestions()}>{copy.suggestions}</Button>
        <p className="cd-setup-suggestions__line cd-type-meta">{copy.suggestionsLine}</p>
      </div> : null}
      {suggestionsError ? <Notice tone="error">{suggestionsError}</Notice> : null}
      <ConceptFooter />
      </div></div>
    </div>
  );
}
