import { useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { UNSAFE_DataRouterContext, useLocation, useNavigate } from 'react-router';

import { ApiError, isUncertain, newIdempotencyKey, ownerErrorCopy, request } from '../api/http.ts';
import type { StartSetupBody } from '../api/views.ts';
import { retryAfterMs, sleep } from '../app/poll.ts';
import { Button, Notice, PageHeader, SuggestionChips, TextField } from '../ds/index.ts';
import { useFocusOnArrival } from '../lib/useFocusOnArrival.ts';
import { SETUP_COPY, SETUP_LANGUAGE, START_EXAMPLES, setupStartLostLine, setupStartSlowLine, setupStartSpentLine } from './copy.ts';

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
interface Attempt {
  body: Omit<StartSetupBody, 'idempotency_key'>;
  key: string;
}

/**
 * A start the page can't yet call done or not done: its answer was `lost` (no answer, a timeout or
 * a 5xx), or the API still said it was `under_way` after the page's own retries.
 */
interface Unresolved {
  attempt: Attempt;
  why: 'lost' | 'under_way';
}

/**
 * "Tell me about your business": a few sentences in the owner's own words, from which the API
 * takes the business's name and the owner's, and makes the new Desk with Answering off. Under the
 * box, four examples to start from: a chip puts its description in the box, focused, for the owner
 * to change, and sends nothing; while a start is being settled they are off, as the box is.
 *
 * Each press of "Start" sends a new idempotency key, and its retries send it again, so the API
 * answers the interview that press made rather than making a second Desk. A start the API says is
 * under way is sent again after its `retry_after`, a few times. One whose outcome is still unknown
 * keeps "Start" off and offers "Try again", the same start with the same key; a clear refusal shows
 * its line, and the next press is a new start with a new key.
 */
export function StartStep() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [description, setDescription] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const [unresolved, setUnresolved] = useState<Unresolved | null>(null);
  // Aborted when the owner leaves the page, which ends a wait between tries and stops anything after
  // it: the moment the router moves elsewhere, which is before React takes the page away (the router
  // draws a navigation in a transition, so the page stays on screen until the next one has drawn).
  const leaving = useRef<AbortController | null>(null);
  // The start being sent, until the page settles it. One the owner left stays, unsettled, for the
  // page to offer again if they come back before it has gone.
  const sending = useRef<Attempt | null>(null);
  const router = useContext(UNSAFE_DataRouterContext)?.router;
  const { pathname } = useLocation();
  // Where focus goes when "Try again" goes with its line.
  const titleRef = useRef<HTMLHeadingElement>(null);
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
  useEffect(() => {
    let controller = new AbortController();
    leaving.current = controller;
    const stop = router?.subscribe((state) => {
      if (state.location.pathname !== pathname) {
        controller.abort();
        return;
      }
      if (!controller.signal.aborted) return;
      // The owner is back (with Back, say) before the page went. What is sent from now on stops when
      // they leave again, and a start they left, its outcome unknown here, is theirs to try again
      // with its key, which makes no second Desk.
      controller = new AbortController();
      leaving.current = controller;
      const left = sending.current;
      sending.current = null;
      if (left === null) return;
      setPending(false);
      setUnresolved({ attempt: left, why: 'lost' });
    });
    return () => {
      stop?.();
      controller.abort();
    };
  }, [router, pathname]);
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
  // A start in flight or unresolved is sent again with the words as they were: nothing changes them.
  const locked = pending || unresolved !== null;

  /** An example's chip: its description goes in the box for the owner to change. Nothing is sent. */
  const pick = (chip: string) => {
    const example = examples.examples.find((each) => each.chip === chip);
    if (locked || example === undefined) return;
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

  const send = async (attempt: Attempt) => {
    const signal = leaving.current?.signal;
    // Nothing is sent once the owner has left, even while this page is still on screen.
    if (signal === undefined || signal.aborted) return;
    sending.current = attempt;
    setPending(true);
    setError(null);
    setUnresolved(null);
    try {
      await sendUntilSettled(attempt, signal);
    } finally {
      // A start the owner left isn't settled.
      if (!signal.aborted) sending.current = null;
    }
  };

  const sendUntilSettled = async (attempt: Attempt, signal: AbortSignal) => {
    for (let retries = 0; ; retries += 1) {
      try {
        const state = await request('startSetup', { body: { ...attempt.body, idempotency_key: attempt.key } });
        // The owner left meanwhile: the interview is theirs to open from their Desks, not to be taken back to.
        if (signal.aborted) return;
        queryClient.setQueryData(['setup', state.interview_id], state);
        void navigate(`/app/setup/${encodeURIComponent(state.interview_id)}`);
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
        setPending(false);
        if (underWay) setUnresolved({ attempt, why: 'under_way' });
        else if (isUncertain(err)) setUnresolved({ attempt, why: 'lost' });
        // The key can't start anything again: setup didn't start, and the next press is a new start.
        else if (err instanceof ApiError && err.code === 'key_spent') setError(setupStartSpentLine());
        else setError(ownerErrorCopy(err));
        return;
      }
    }
  };

  const start = async (event: FormEvent) => {
    event.preventDefault();
    const text = description.trim();
    if (pending || unresolved !== null) return;
    setEmpty(text === '');
    if (text === '') return;
    await send({ body: { description: text, timezone: browserTimeZone() }, key: newIdempotencyKey() });
  };

  const tryAgain = unresolved === null ? null : (
    <Button
      variant="secondary"
      onClick={() => {
        titleRef.current?.focus({ preventScroll: true });
        void send(unresolved.attempt);
      }}
    >
      {SETUP_COPY.questions.tryAgain}
    </Button>
  );

  return (
    <form className="cd-setup-step" noValidate onSubmit={(event) => void start(event)}>
      <PageHeader title={copy.title} subtitle={copy.subtitle} titleRef={titleRef} />
      <div className={`cd-setup-start__field${picks > 0 ? ' cd-setup-start__field--filled' : ''}`}>
        <TextField
          label={copy.field}
          multiline
          value={description}
          onChange={(next) => {
            setDescription(next);
            if (next.trim() !== '') setEmpty(false);
          }}
          hint={copy.hint}
          maxLength={DESCRIPTION_MAX}
          readOnly={locked}
          fieldRef={boxRef}
          {...(empty ? { error: copy.empty } : {})}
        />
        <div className="cd-setup-start__examples">
          <p className="cd-setup-start__line cd-type-meta">{examples.line}</p>
          <SuggestionChips label={examples.label} suggestions={examples.examples.map((example) => example.chip)} max={4} onPick={pick} disabled={locked} />
        </div>
      </div>
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      {unresolved === null ? null : (
        <Notice tone="error" action={tryAgain}>
          {unresolved.why === 'lost' ? setupStartLostLine() : setupStartSlowLine()}
        </Notice>
      )}
      <div className="cd-setup-step__actions">
        {unresolved !== null ? (
          <Button variant="primary" size="main" type="submit" disabled>
            {copy.action}
          </Button>
        ) : (
          <Button variant="primary" size="main" type="submit" busy={pending}>
            {copy.action}
          </Button>
        )}
      </div>
    </form>
  );
}
