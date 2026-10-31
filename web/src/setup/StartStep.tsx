import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';

import { ApiError, isUncertain, ownerErrorCopy, request } from '../api/http.ts';
import { Button, Notice, PageHeader, TextField, UNREACHABLE_COPY } from '../ds/index.ts';
import { SETUP_COPY } from './copy.ts';

/** Plan 02's limit on the business's description. */
const DESCRIPTION_MAX = 1500;

/** The browser's own time zone, by its IANA name, which the business's times are kept in. */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * What a start whose answer was lost says: it may have made the Desk, so it isn't called not done.
 * stopgap: the design system's setup-start-lost line.
 */
function lostStartLine(): string {
  return UNREACHABLE_COPY.en;
}

/**
 * "Tell me about your business": a few sentences in the owner's own words, from which the API
 * takes the business's name and the owner's, and makes the new Desk with Answering off.
 */
export function StartStep() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [description, setDescription] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  /**
   * A start whose answer was lost may have made a Desk, and the API can't yet say which (its
   * idempotency key is to come), so "Start" stays off on this page rather than make a second one.
   */
  const [lost, setLost] = useState(false);
  const copy = SETUP_COPY.start;

  const start = async (event: FormEvent) => {
    event.preventDefault();
    const text = description.trim();
    if (pending || lost) return;
    setEmpty(text === '');
    if (text === '') return;
    setPending(true);
    setError(null);
    try {
      const state = await request('startSetup', { body: { description: text, timezone: browserTimeZone() } });
      queryClient.setQueryData(['setup', state.interview_id], state);
      void navigate(`/app/setup/${encodeURIComponent(state.interview_id)}`);
    } catch (err) {
      // The session ended: the app goes back to the start, and there is nothing to say here.
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      if (isUncertain(err)) setLost(true);
      else setError(ownerErrorCopy(err));
      setPending(false);
    }
  };

  return (
    <form className="cd-setup-step" noValidate onSubmit={(event) => void start(event)}>
      <PageHeader title={copy.title} subtitle={copy.subtitle} />
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
        {...(empty ? { error: copy.empty } : {})}
      />
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      {lost ? <Notice tone="error">{lostStartLine()}</Notice> : null}
      <div className="cd-setup-step__actions">
        {lost ? (
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
