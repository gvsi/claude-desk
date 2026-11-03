import { Fragment, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

import type { HoursWindow } from '../api/contracts.ts';
import { ApiError, isUncertain, newIdempotencyKey, ownerErrorCopy, request } from '../api/http.ts';
import type { Choice, SetupAnswerBody, SetupMessage, SetupQuestion, SetupState } from '../api/views.ts';
import { Button, ClaudeMessage, Composer, ConceptFooter, Notice, PageHeader, ToolLabel, Transcript, VisitorMessage, WritingIndicator } from '../ds/index.ts';
import { fillComposer } from '../lib/composer.ts';
import { useFocusOnArrival } from '../lib/useFocusOnArrival.ts';
import { GrowingReply } from '../lib/GrowingReply.tsx';
import { useTopFade } from '../lib/useTopFade.ts';
import { SETUP_COPY, stillCheckingLine } from './copy.ts';
import { ProposalCard, type CardDecision } from './ProposalCard.tsx';
import { isCard, liveChoices, pickedAnswer } from './conversation.ts';
import { SetupChoices } from './SetupChoices.tsx';
import { StartedOpening, type StartedOpeningProps } from './SetupStartTransition.tsx';
import './SetupConversation.css';
import { hasWords, useSetupStream } from './setupStream.ts';
import { useChangeSomething } from './shared.ts';
import { useSetupWork } from './useSetupWork.ts';

/** Plan 02's limit on an answer. */
const ANSWER_MAX = 2000;

const copy = SETUP_COPY.questions;
/** The memory question's two answers, docked as every question's choices are. */
const CONSENT_CHOICES: Choice[] = [{ text: copy.allow, recommended: false }, { text: copy.decline, recommended: false }];
const ACTIVE_CHOICE = '.cd-setup-q3__list button[aria-current="true"]:not(:disabled), .cd-setup-q3__row.is-active input:not(:disabled)';

export interface QuestionsStepProps {
  state: SetupState;
  hours?: HoursWindow | null;
  onContinue: () => void;
  /** The API answered with the interview as it stands. */
  onState: (state: SetupState) => void;
  /** Reads the interview again after a write whose answer was lost; null when it can't be read. */
  reread: () => Promise<SetupState | null>;
  /**
   * "Change something": the chat over a step after the questions, its message box focused. What the
   * owner sends goes to the API's reopen (`setupReopen`), which takes the interview back to its
   * questions; `onContinue` goes back to the step without sending.
   */
  changing?: boolean;
  /**
   * The owner's own description, when the start on this page made the interview: their first
   * message and Claude's read of it, where setup's chat showed them while the interview was made.
   */
  opening?: StartedOpeningProps | null;
}

/** The owner hasn't answered whether Claude may read their memory and website. */
function awaitsConsent(state: SetupState): boolean {
  return state.consent === null;
}

/**
 * An answer as sent: the question it answers, the words, and how many messages the interview held
 * when it was sent, so a read can tell what came after. A change sent from a later step ("Change
 * something") answers no question: it carries its idempotency key (`reopen`) instead, sent again
 * as it is by "Try again". Picks from a question that takes several are sent as picks with the
 * typed words (`picks`, `typed`); `text` is then the message the API writes from them.
 */
type Answer = { text: string } & ({ question: SetupQuestion; card?: never } | { question: null; card: string }) & {
  seen: number;
  /** The API refused it (a 409 to its first send): final, whatever a later read holds. */
  refused?: true;
  reopen?: string;
  picks?: string[];
  typed?: string;
}

/** At least one pick. */
const somePicked = (picks: string[] | undefined): picks is [string, ...string[]] => picks !== undefined && picks.length > 0;

/** What the API is sent for an answer: its words, or its picks with any typed words. */
function bodyOf(answer: Answer): SetupAnswerBody {
  if (answer.question === null) return { question: null, card: answer.card, text: answer.text };
  if (somePicked(answer.picks)) return { question: answer.question, picks: answer.picks, ...(answer.typed ? { text: answer.typed } : {}) };
  return { question: answer.question, text: answer.text };
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
  // A change reopens a later step: back at the questions without these words, something else took it.
  if (answer.reopen !== undefined) return since.length > 0 || now.step === 'questions' ? 'refused' : 'unknown';
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
 * "Let's set up your Desk": the setup conversation in order, Claude's words in its serif, the owner's as
 * theirs and each read of their memory or website as its label. First Claude asks to read the
 * owner's Claude memory, docked with its two answers ("Yes, use it" or "No, I'll type it"), and
 * words typed in the message box, which Esc brings back under them, are "No, I'll type it"; then
 * each answer goes to the API, which asks the next question, docked with its choices while the
 * message box is hidden. An answer that didn't go through stays in the composer.
 */
export function QuestionsStep({ state, hours, onState, reread, onContinue, changing: changingHere = false, opening = null }: QuestionsStepProps) {
  const step = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  // Messages fade where they scroll under the bar, once the conversation is scrolled from its top.
  useTopFade(scroll, '.cd-setup-chat__scroll');
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
  /** A decision's request is out: a decision stays `deciding` while its turn runs busy after it. */
  const [decisionOut, setDecisionOut] = useState(false);
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(() => new Set());
  const id = state.interview_id;
  const asking = awaitsConsent(state);
  // "Change something" over a later step: the message box, until the API has the questions again.
  const changing = changingHere && state.step !== 'questions';
  // The questions are done: under the plan, "Change something" and "Continue".
  const closing = state.step !== 'questions' && !changing;
  const changeSomething = useChangeSomething(id);
  const live = liveChoices(state);
  const busy = state.busy === true;
  const consentBusy = busy && !asking && state.question === null && !state.pending_card && state.messages.filter(({ role }) => role === 'claude').length === 1;
  // A turn is on its way: an answer, the memory answer, a card's decision or suggestions went out, or
  // the interview runs one. The owner can type the next answer meanwhile; it sends once the turn ends.
  const replying = busy || sending !== null || deciding !== null || suggesting || consenting !== null;
  const blocked = replying || retrying;
  // A turn's request is out, and the turn is followed as it is written from then until the
  // interview is no longer busy.
  const inFlight = sending !== null || consenting !== null || suggesting || decisionOut;
  const stream = useSetupStream(id, !closing && (busy || inFlight), inFlight, reread, state.messages.length);
  const growing = stream.growing;
  // The question panel and its choices show once the turn is saved, never while its reply is written.
  const panel = live && !closing && !asking && !dismissed.has(live.index) && growing === null ? live : null;
  const closePanel = () => {
    if (live) setDismissed((previous) => new Set([...previous, live.index]));
  };
  const toComposer = () => composer.current?.querySelector('textarea')?.focus({ preventScroll: true });
  // The memory question docks like every question, its ask moved into the panel, until it is answered.
  const askAt = asking && !busy && consenting === null ? state.messages.findLastIndex((message) => message.role === 'claude' && !isCard(message)) : -1;
  const consentPanel = askAt >= 0 ? askAt : null;
  /** Esc on the memory question brought the message box back under it. */
  const [consentTyping, setConsentTyping] = useState(false);
  /** The message box holds words the owner typed, or that were given back to them. */
  const [boxWords, setBoxWords] = useState(false);
  /** The docked question whose message box stays shown: it held words while the question was docked. */
  const [boxKept, setBoxKept] = useState<number | null>(null);
  useEffect(() => {
    if (panel && boxWords) setBoxKept(panel.index);
  }, [panel?.index, boxWords]);
  // The message box is hidden while a question docks. Esc brings it back: a question goes back to the
  // chat as Claude's line, while the memory question stays docked, since its answers are the only way
  // to say yes; "No, I'll type it" brings it back too. Words in the box are never hidden: a question
  // that docks while the owner has words there docks above the box, as the owner typed them for it.
  // Nor is an answer that didn't go through, with its "Try again".
  const boxHidden = failed === null && !boxWords
    && ((panel !== null && boxKept !== panel.index) || (consentPanel !== null && !consentTyping));
  /** The box takes focus once it shows again. */
  const focusBox = useRef(false);
  const revealBox = () => {
    if (boxHidden) focusBox.current = true;
    else toComposer();
  };
  useEffect(() => {
    if (boxHidden || !focusBox.current) return;
    focusBox.current = false;
    toComposer();
  }, [boxHidden]);
  /** Esc or Dismiss: the question goes back to the chat, and words typed in "Something else…" go on in the box. */
  const dismissPanel = (words: string) => {
    closePanel();
    if (words.trim() !== '') setRefill({ text: words.trim() });
    revealBox();
  };
  useEffect(() => { if (!busy) setDeciding(null); }, [busy]);
  const work = useSetupWork(state, reread, stream.progress);
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && asking) setConsentError(stillCheckingLine());
    wasBusy.current = busy;
  }, [busy, asking]);
  // The memory question takes focus on its panel once, as it first docks, so its number keys work
  // at once; never from the message box, nor from anywhere else the owner has gone.
  const consentDocked = useRef(false);
  useEffect(() => {
    if (consentPanel === null || consentDocked.current) return;
    consentDocked.current = true;
    const focus = document.activeElement;
    if (composer.current?.contains(focus) || (focus !== document.body && !step.current?.contains(focus))) return;
    step.current?.querySelector<HTMLElement>(ACTIVE_CHOICE)?.focus({ preventScroll: true });
  }, [consentPanel]);
  const waitingForFirstQuestion = useRef(asking || consentBusy);

  useEffect(() => {
    if (asking || consentBusy) waitingForFirstQuestion.current = true;
    if (asking || blocked) return;
    if (!waitingForFirstQuestion.current || state.question === null) return;
    waitingForFirstQuestion.current = false;
    const target = panel ? step.current?.querySelector<HTMLElement>(ACTIVE_CHOICE)
      : window.matchMedia('(pointer: fine)').matches ? composer.current?.querySelector('textarea') : null;
    const focus = document.activeElement;
    // An owner typing in the message box keeps it.
    if (!target || composer.current?.contains(focus) || (focus !== document.body && !step.current?.contains(focus))) return;
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
   * been taken; when nothing came since, the words go back in the composer. Words a read shows
   * stored are never sent again or put back.
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
      const next = answer.reopen !== undefined
        ? await request('setupReopen', { params: { id }, body: { text: answer.text, idempotency_key: answer.reopen } })
        : await request('setupAnswer', { params: { id }, body: bodyOf(answer) });
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
      // Refused (409) with nothing stored since: the interview wasn't free yet, a moment after a turn
      // ended or failed. The words go back to send again, and nothing says it failed.
      if (outcome === 'refused' || refused) setRefill({ text: answer.text });
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
    returnFocus.current = true;
    returnToTextarea.current = false;
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
      returnFocus.current = false;
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
    setDecisionOut(true);
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
      setDecisionOut(false);
      if (!background) setDeciding(null);
    }
  };

  /**
   * The picks from a question that takes several, with any typed words: one answer, which the API
   * writes as one message. Typed words alone are a typed answer.
   */
  const sendPicks = (picks: string[], typed: string) => {
    if (picks.length === 0) {
      send(typed);
      return;
    }
    if (failed !== null || retrying || !live || state.question === null) return;
    closePanel();
    void submit({ question: state.question, text: pickedAnswer(live.choices, picks, typed), picks, typed, seen: state.messages.length });
  };

  /** The composer's words: the answer to the question the page shows. */
  const send = (text: string) => {
    // While an answer is unsettled the composer shows it with "Try again", which reads first; nothing posts blind.
    if (failed !== null || retrying) return;
    if (changing) {
      // A change from a later step: the API takes the interview back to its questions with these words.
      void submit({ question: null, card: '', text, seen: state.messages.length, reopen: newIdempotencyKey() });
      return;
    }
    if (asking) {
      // Typing is "No, I'll type it": nothing is read, and the words wait for the question they answer.
      setRefill({ text });
      void consent(false);
      return;
    }
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
    // Words typed while the turn ran stay, after the ones given back.
    fillComposer(box, box.value.trim() === '' ? refill.text : `${refill.text}\n${box.value}`, { focus: false });
    setRefill(null);
  }, [refill, sending, retrying, failed, busy, consenting]);

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
    // The message box takes typing while a turn runs, so an owner who stayed in it keeps it.
    if (field && document.activeElement === field) return;
    const pending = state.messages.find(({ card }) => card?.proposal_id === state.pending_card)?.card;
    const config = pending?.job?.config;
    const unpriced = pending?.job?.job === 'payment'
      && (config?.block !== 'purpose_payment' || config.amount_cents === null || config.amount_cents <= 0);
    const cardTarget = pending ? unpriced
      ? step.current?.querySelector<HTMLElement>('.cd-setup-c3__amount input:not(:disabled):not([readonly])')
      : step.current?.querySelector<HTMLElement>('.cd-setup-c3__actions button:not(:disabled)') : null;
    const target = failed ? composer.current?.querySelector<HTMLElement>('button:not(:disabled)')
      : decisionFailed ? step.current?.querySelector<HTMLElement>('.cd-setup-c3__failed button:not(:disabled)')
      : panel || consentPanel !== null ? step.current?.querySelector<HTMLElement>(ACTIVE_CHOICE)
      : closing ? step.current?.querySelector<HTMLElement>('.cd-setup-dock .cd-button--primary')
      : returnToTextarea.current ? field
      : cardTarget ?? (window.matchMedia('(pointer: fine)').matches ? field : null);
    target?.focus({ preventScroll: true });
  }, [blocked, failed, decisionFailed, closing, panel?.index, consentPanel, state.pending_card, state.messages]);

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
        {opening === null ? null : <StartedOpening {...opening} />}
        {state.messages.map((message, index) => (
          <Fragment key={`${index}-${message.role}`}>
            {panel?.index === index || consentPanel === index ? null : isCard(message) ? <ProposalCard proposal={message.card!} hours={hours}
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
        {/* The memory question's answer shows the moment it is pressed, with Claude writing under it. */}
        {consenting === null ? null : <VisitorMessage text={consenting ? copy.allowAnswer : copy.decline} />}
        {/* The running turn as it is written: its reads' labels, then Claude's reply, which the saved
            turn replaces. Screen readers hear "Claude is writing" until the saved turn, then it once. */}
        {growing?.labels.map((label, index) =>
          label.text === null ? null : (
            <div key={index} aria-hidden="true">
              <ToolLabel text={label.text} />
            </div>
          ),
        )}
        {growing !== null && hasWords(growing) ? (
          <div className="cd-claude-message cd-setup-growing" lang="en" aria-hidden="true">
            <GrowingReply text={growing.text} streaming={!growing.final} />
          </div>
        ) : null}
        {sending !== null || consenting !== null || busy || deciding !== null || suggesting ? <WritingIndicator language="en" /> : null}
        {/* While the reads stream, they say what is happening; only a step that can't follow them says it waits. */}
        {consentBusy && growing === null && stream.fellBack ? (
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
      {panel ? <SetupChoices key={panel.index} question={state.messages[panel.index]!.text} choices={panel.choices} several={panel.several}
        maxLength={ANSWER_MAX} disabled={blocked || failed !== null} onDismiss={dismissPanel}
        onChoose={(text) => { returnFocus.current = true; returnToTextarea.current = false; send(text); }}
        onPicks={(picks, typed) => { returnFocus.current = true; returnToTextarea.current = false; sendPicks(picks, typed); }} /> : null}
      {asking && !busy && consentError !== null ? <Notice tone="error">{consentError}</Notice> : null}
      {consentPanel === null ? null : <SetupChoices key="consent" kind="consent" question={state.messages[consentPanel]!.text} choices={CONSENT_CHOICES}
        maxLength={ANSWER_MAX} disabled={blocked} onDismiss={() => { setConsentTyping(true); revealBox(); }}
        onChoose={(text) => { returnFocus.current = true; returnToTextarea.current = false; void consent(text === copy.allow); }} />}
      {closing ? (
        <div className="cd-setup-step__actions">
          <Button variant="secondary" size="main" onClick={changeSomething}>{SETUP_COPY.changeSomething}</Button>
          <Button variant="primary" size="main" onClick={onContinue}>{SETUP_COPY.tools.continue}</Button>
        </div>
      ) : (
        <div ref={composer} hidden={boxHidden}
          onInput={(event) => { if (event.target instanceof HTMLTextAreaElement) setBoxWords(event.target.value.trim() !== ''); }}>
          <Composer
            variant="owner"
            label={copy.composerLabel}
            placeholder={copy.placeholder}
            maxLength={ANSWER_MAX}
            // Only "Try again" waits on the turn; the message box holds Send instead.
            disabled={failed !== null ? blocked : retrying}
            sendHeld={replying}
            onSend={(text) => { setBoxWords(false); send(text); }}
            {...(failed === null ? {} : { failed: { text: failed.text, line: copy.failed, onRetry: () => void retry() } })}
          />
        </div>
      )}
      {changing ? <FocusOnArrival composer={composer} /> : null}
      {/* "Change something" goes back to the step without sending; not once a change is on its way. */}
      {changing && !replying ? <div className="cd-setup-suggestions">
        <Button variant="ghost" onClick={onContinue}>{SETUP_COPY.tools.continue}</Button>
      </div> : null}
      {/* Not while the memory question's turn runs, from the press until Claude's opening is saved. */}
      {!closing && !changing && !asking && consenting === null && !consentBusy ? <div className="cd-setup-suggestions">
        <Button variant="ghost" busy={suggesting} waiting={!suggesting && (blocked || failed !== null)} onClick={() => void suggestions()}>{copy.suggestions}</Button>
        <p className="cd-setup-suggestions__line cd-type-meta">{copy.suggestionsLine}</p>
      </div> : null}
      {suggestionsError ? <Notice tone="error">{suggestionsError}</Notice> : null}
      <ConceptFooter />
      </div></div>
    </div>
  );
}

/** The message box takes focus when "Change something" opens it, as setup's text boxes do on arrival. */
function FocusOnArrival({ composer }: { composer: RefObject<HTMLDivElement | null> }) {
  useFocusOnArrival(composer, 'textarea');
  return null;
}
