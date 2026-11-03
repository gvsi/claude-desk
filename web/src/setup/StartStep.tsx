import { useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';

import { ApiError, isUncertain, newIdempotencyKey, ownerErrorCopy, request } from '../api/http.ts';
import type { StartSetupBody } from '../api/views.ts';
import { retryAfterMs, sleep } from '../app/poll.ts';
import { useLeavingSignal } from '../app/useLeavingSignal.ts';
import { Button, Notice, PageHeader, SuggestionChips, TextField } from '../ds/index.ts';
import { useFocusOnArrival } from '../lib/useFocusOnArrival.ts';
import { SETUP_COPY, SETUP_LANGUAGE, START_EXAMPLES } from './copy.ts';

/** Plan 02's limit on the business's description. */
const DESCRIPTION_MAX = 1500;

/** How many more times a start the API says is under way (409 `in_progress`) is sent before the page says so. */
const UNDER_WAY_RETRIES = 3;
/** The wait before sending it again when the answer names no `retry_after`: the API's 2 s. */
const UNDER_WAY_WAIT_S = 2;

/** The browser's own time zone, by its IANA name, which the business's times are kept in. */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** One press of "Start": its body and its idempotency key, sent again as they are by each retry. */
export interface Attempt {
  body: Omit<StartSetupBody, 'idempotency_key'>;
  key: string;
}

/**
 * Why a start in setup's chat isn't settled: its answer was `lost` (no answer, a timeout or a
 * 5xx), the API still said it was `under_way` after the page's own retries, or its key is `spent`
 * (the start ended with its Desk unknown, so setup didn't start and only a new key starts again).
 */
export type StartFailure = 'lost' | 'under_way' | 'spent';

/** Where setup's start stands, and what the start page and setup's chat can do with it. */
export interface SetupStart {
  /**
   * The start setup's chat shows, from the press of "Start" until its interview opens, or a clear
   * refusal gives its words back to the form; null on the form.
   */
  attempt: Attempt | null;
  /** What keeps the start in the chat from settling, said where Claude's writing dots were; null while it is sent. */
  failure: StartFailure | null;
  /** A clear refusal, on the form: its line, and the words that were sent, back in the box. */
  refusal: { line: string; words: string } | null;
  /** "Start": the owner's words as a new start, with a new idempotency key. */
  begin: (description: string) => void;
  /** "Try again": the same start with the same key, or a new start of the same words once its key is spent. */
  tryAgain: () => void;
}

/** What the start page hands the interview it opens: the owner's own words, their first message in setup's chat. */
interface StartedState {
  setupStartedWith: string;
}

/**
 * The owner's own description, when the page was opened by the start that made its interview
 * (`useSetupStart`); null otherwise. The API keeps the description but doesn't send it back, so an
 * interview opened any other way shows the conversation from Claude's first question.
 */
export function startedWith(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null;
  const words = (state as Partial<StartedState>).setupStartedWith;
  return typeof words === 'string' && words !== '' ? words : null;
}

/**
 * Setup's start, from the owner's words to its interview. "Start" puts the owner in setup's chat at
 * once (`attempt`), and the start runs underneath: once the API answers with the interview, it is
 * kept for the interview's page, which takes the start page's place in history, with the owner's
 * words as their first message (`startedWith`).
 *
 * Each press of "Start" sends a new idempotency key, and its retries send it again, so the API
 * answers the interview that press made rather than making a second Desk. A start the API says is
 * under way is sent again after its `retry_after`, a few times. One whose outcome is still unknown
 * stays in the chat with "Try again", the same start with the same key; one whose key is spent
 * stays there too, and "Try again" starts anew. A clear refusal gives the words back to the form
 * with its line, and the next press is a new start with a new key.
 *
 * Nothing is sent once the owner has left, even while the page is still on screen, and a start
 * that went through meanwhile is theirs to open from their Desks, not to be taken back to.
 */
export function useSetupStart(): SetupStart {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [failure, setFailure] = useState<StartFailure | null>(null);
  const [refusal, setRefusal] = useState<SetupStart['refusal']>(null);
  // The start being sent, until the page settles it. One the owner left stays, unsettled, for the
  // page to offer again if they come back before it has gone.
  const sending = useRef<Attempt | null>(null);
  // Aborted when the owner leaves the page, which ends a wait between tries and stops anything after
  // it: the moment the router moves elsewhere, which is before React takes the page away (the router
  // draws a navigation in a transition, so the page stays on screen until the next one has drawn).
  const leaving = useLeavingSignal(() => {
    // The owner is back (with Back, say) before the page went. What is sent from now on stops when
    // they leave again, and a start they left, its outcome unknown here, is theirs to try again
    // with its key, which makes no second Desk.
    const left = sending.current;
    sending.current = null;
    if (left === null) return;
    setAttempt(left);
    setFailure('lost');
  });

  const sendUntilSettled = async (sent: Attempt, signal: AbortSignal) => {
    for (let retries = 0; ; retries += 1) {
      try {
        const state = await request('startSetup', { body: { ...sent.body, idempotency_key: sent.key } });
        // The owner left meanwhile: the interview is theirs to open from their Desks, not to be taken back to.
        if (signal.aborted) return;
        queryClient.setQueryData(['setup', state.interview_id], state);
        const started: StartedState = { setupStartedWith: sent.body.description };
        void navigate(`/app/setup/${encodeURIComponent(state.interview_id)}`, { replace: true, state: started });
        return;
      } catch (err) {
        if (signal.aborted) return;
        // The session ended: the app goes back to the start, and there is nothing to say here.
        if (err instanceof ApiError && err.kind === 'unauthorized') return;
        const underWay = err instanceof ApiError && err.code === 'in_progress';
        if (underWay && retries < UNDER_WAY_RETRIES) {
          await sleep(retryAfterMs(err.retryAfter ?? UNDER_WAY_WAIT_S), signal);
          if (signal.aborted) return;
          continue;
        }
        if (underWay) setFailure('under_way');
        else if (isUncertain(err)) setFailure('lost');
        // The key can't start anything again: setup didn't start, and "Try again" is a new start.
        else if (err instanceof ApiError && err.code === 'key_spent') setFailure('spent');
        else {
          setAttempt(null);
          setRefusal({ line: ownerErrorCopy(err), words: sent.body.description });
        }
        return;
      }
    }
  };

  const send = async (next: Attempt) => {
    const signal = leaving();
    // Nothing is sent once the owner has left, even while this page is still on screen; nor a
    // second start while one is out.
    if (signal.aborted || sending.current !== null) return;
    sending.current = next;
    setAttempt(next);
    setFailure(null);
    setRefusal(null);
    try {
      await sendUntilSettled(next, signal);
    } finally {
      // A start the owner left isn't settled.
      if (!signal.aborted) sending.current = null;
    }
  };

  return {
    attempt,
    failure,
    refusal,
    begin: (description) => void send({ body: { description, timezone: browserTimeZone() }, key: newIdempotencyKey() }),
    tryAgain: () => {
      if (attempt === null || failure === null) return;
      void send(failure === 'spent' ? { body: attempt.body, key: newIdempotencyKey() } : attempt);
    },
  };
}

/**
 * "Tell me about your business": a few sentences in the owner's own words, from which the API
 * takes the business's name and the owner's, and makes the new Desk with Answering off. Under the
 * box, four examples to start from: a chip puts its description in the box, focused, for the owner
 * to change, and sends nothing. "Start" sends the words (`useSetupStart`), and setup's chat takes
 * the form's place; a clear refusal brings the form back with its line and the words as they were.
 */
export function StartStep({ start }: { start: SetupStart }) {
  const [description, setDescription] = useState(start.refusal?.words ?? '');
  const [empty, setEmpty] = useState(false);
  // The box, which takes focus as the page opens, and once an example is put in it.
  const boxRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  useFocusOnArrival(boxRef);
  // Each example put in the box, counted, so the box takes focus after each, the same one again too.
  const [picks, setPicks] = useState(0);
  // Older Safari fits the box here; CSS keeps the same four-line floor and ten-line cap.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box === null || CSS.supports('field-sizing', 'content')) return;
    const fit = () => {
      box.style.height = 'auto';
      box.style.height = `${box.scrollHeight + 2}px`;
    };
    fit();
    let width = box.getBoundingClientRect().width;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      const nextWidth = box.getBoundingClientRect().width;
      if (nextWidth === width) return;
      width = nextWidth;
      // Keep height writes outside observer delivery; height-only changes never schedule a fit.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(box);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [description, picks]);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (picks === 0 || box === null) return;
    box.focus();
    // The caret at the end, ready for more detail, with that end in view even at the line cap.
    box.setSelectionRange(box.value.length, box.value.length);
    box.scrollTop = box.scrollHeight;
    // The words fade in with each press: the fill's animation (SetupPage.css) starts over.
    box.style.animation = 'none';
    void box.offsetWidth;
    box.style.removeProperty('animation');
  }, [picks]);
  const copy = SETUP_COPY.start;
  const examples = START_EXAMPLES[SETUP_LANGUAGE];

  /** An example's chip: its description goes in the box for the owner to change. Nothing is sent. */
  const pick = (chip: string) => {
    const example = examples.examples.find((each) => each.chip === chip);
    if (example === undefined) return;
    setEmpty(false);
    setPicks((n) => n + 1);
    const box = boxRef.current;
    const ownWords = description.trim() !== '' && !examples.examples.some((each) => each.description === description);
    // Words the owner typed are replaced as an edit, through the box's own input (its change reaches
    // `onChange`), so undo brings them back. Where the browser can't, they are replaced as below.
    if (ownWords && box !== null) {
      box.focus();
      box.select();
      if (document.execCommand('insertText', false, example.description)) return;
    }
    setDescription(example.description);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = description.trim();
    setEmpty(text === '');
    if (text === '') return;
    start.begin(text);
  };

  return (
    <form className="cd-setup-step" noValidate onSubmit={submit}>
      <PageHeader title={copy.title} subtitle={copy.subtitle} />
      <div className={`cd-setup-start__field${picks > 0 ? ' cd-setup-start__field--filled' : ''}`}>
        <TextField
          label={copy.field}
          multiline
          placeholder={copy.placeholder}
          value={description}
          onChange={(next) => {
            setDescription(next);
            if (next.trim() !== '') setEmpty(false);
          }}
          hint={copy.hint}
          maxLength={DESCRIPTION_MAX}
          fieldRef={boxRef}
          {...(empty ? { error: copy.empty } : {})}
        />
        <div className="cd-setup-start__examples">
          <p className="cd-setup-start__line cd-type-meta">{examples.line}</p>
          <SuggestionChips label={examples.label} suggestions={examples.examples.map((example) => example.chip)} max={4} onPick={pick} />
        </div>
      </div>
      {start.refusal === null ? null : <Notice tone="error">{start.refusal.line}</Notice>}
      <div className="cd-setup-step__actions">
        <Button variant="primary" size="main" type="submit">
          {copy.action}
        </Button>
      </div>
    </form>
  );
}
