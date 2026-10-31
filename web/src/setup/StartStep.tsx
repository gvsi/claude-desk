import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';

import { ApiError, isUncertain, newIdempotencyKey, ownerErrorCopy, request } from '../api/http.ts';
import type { StartSetupBody } from '../api/views.ts';
import { retryAfterMs, sleep } from '../app/poll.ts';
import { Button, Notice, PageHeader, SuggestionChips, TextField } from '../ds/index.ts';
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
 * box, three examples to start from: a chip puts its description in the box, focused, for the owner
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
  // Aborted when the page goes away, which ends a wait between tries and stops anything after it.
  const leaving = useRef<AbortController | null>(null);
  // Where focus goes when "Try again" goes with its line.
  const titleRef = useRef<HTMLHeadingElement>(null);
  // The box, which takes focus once an example is put in it.
  const boxRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  // Each example put in the box, counted, so the box takes focus after each, the same one again too.
  const [picks, setPicks] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    leaving.current = controller;
    return () => controller.abort();
  }, []);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (picks === 0 || box === null) return;
    box.focus();
    // The caret at the start, where the business's name is to change, and the box scrolled to it.
    box.setSelectionRange(0, 0);
    box.scrollTop = 0;
  }, [picks]);
  const copy = SETUP_COPY.start;
  const examples = START_EXAMPLES[SETUP_LANGUAGE];
  // A start in flight or unresolved is sent again with the words as they were: nothing changes them.
  const locked = pending || unresolved !== null;

  /** An example's chip: its description goes in the box for the owner to change. Nothing is sent. */
  const pick = (chip: string) => {
    const example = examples.examples.find((each) => each.chip === chip);
    if (locked || example === undefined) return;
    setDescription(example.description);
    setEmpty(false);
    setPicks((n) => n + 1);
  };

  const send = async (attempt: Attempt) => {
    const signal = leaving.current?.signal;
    if (signal === undefined) return;
    setPending(true);
    setError(null);
    setUnresolved(null);
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
      <div className="cd-setup-start__field">
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
          <p className="cd-setup-start__line cd-type-body">{examples.line}</p>
          <SuggestionChips label={examples.label} suggestions={examples.examples.map((example) => example.chip)} onPick={pick} disabled={locked} />
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
