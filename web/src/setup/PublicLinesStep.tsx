import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { ApiError, ownerErrorCopy, request } from '../api/http.ts';
import type { SetupPublicLine, SetupPublicLines, SetupState, SetupStep } from '../api/views.ts';
import { Button, Card, CHANGED_REFRESHED, Notice, PageHeader, SkeletonScreen, StatusDot } from '../ds/index.ts';
import { PUBLIC_LINE_KEYS, SETUP_COPY } from './copy.ts';
import { publicLineLimit } from './publicLineLimit.ts';
import { formatPublicHours, formatPublicPrice, publicLineLabel } from './publicLinesFormat.ts';
import { PublicLinesSkeleton } from './StepSkeletons.tsx';

import './PublicLinesStep.css';

const copy = SETUP_COPY.publicLines;
const labelOf = (line: SetupPublicLine) => publicLineLabel(line.key);

const DAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

function validLine(line: SetupPublicLine): boolean {
  return Boolean(line && typeof line.key === 'string' && typeof line.text === 'string' && line.text.trim()
    && typeof line.editable === 'boolean' && ['owner', 'suggested'].includes(line.source)
    && (line.held === undefined || typeof line.held === 'boolean'));
}

function validHours(hours: SetupPublicLines['hours']): boolean {
  return hours === null || Boolean(hours && ['owner', 'suggested'].includes(hours.source)
    && Array.isArray(hours.windows) && hours.windows.every((window) => window
      && Array.isArray(window.days) && window.days.length > 0 && window.days.every((day) => DAYS.has(day))
      && CLOCK_PATTERN.test(window.start) && CLOCK_PATTERN.test(window.end)));
}

function validPrices(prices: SetupPublicLines['prices']): boolean {
  return prices === null || Boolean(prices && ['owner', 'suggested'].includes(prices.source)
    && Array.isArray(prices.items) && prices.items.every((item) => item
      && typeof item.item_id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.item_id) && item.item_id.length <= 40
      && typeof item.title === 'string' && item.title.trim() && Array.from(item.title).length <= 80
      && Number.isSafeInteger(item.unit_cents) && item.unit_cents >= 0)
    && new Set(prices.items.map((item) => item.item_id)).size === prices.items.length);
}

/** A malformed answer holds this step, including a 200 that cannot confirm what was checked. */
function checkedLines(value: SetupPublicLines): SetupPublicLines {
  if (!value || typeof value.revision !== 'string' || value.revision.trim() === ''
    || !Array.isArray(value.lines) || !value.lines.every(validLine)
    || new Set(value.lines.map((line) => line.key)).size !== value.lines.length
    || !validHours(value.hours) || !validPrices(value.prices)) throw new Error('invalid public lines');
  return value;
}

const knownKey = (key: string) => PUBLIC_LINE_KEYS.some((known) => known === key);

const canEdit = (line: SetupPublicLine) => line.editable && line.key !== 'policy:how_we_help';

export interface PublicLinesStepProps {
  state: SetupState;
  onNext: (step: SetupStep) => void;
  reread: () => Promise<SetupState | null>;
}

/** The last Rules view: the public charter lines, with the public About panel's labels. */
export function PublicLinesStep({ state, onNext, reread }: PublicLinesStepProps) {
  const queryClient = useQueryClient();
  const id = state.interview_id;
  const queryKey = ['setupPublicLines', id] as const;
  const fieldId = useId();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'save' | 'confirm' | 'remove' | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error !== null) notice.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);
  const limit = publicLineLimit(editingKey ?? '');
  const invalid = text.trim() === '' || Array.from(text).length > limit;
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnFocus = useRef<string | null>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnRemoveFocus = useRef<{ revision: string; index: number } | null>(null);
  const suggestedHeading = useRef<HTMLDivElement>(null);
  const looksRightButton = useRef<HTMLButtonElement>(null);
  const openedHeldOnLoad = useRef(false);
  const firstReadHandled = useRef(false);
  useEffect(() => {
    if (editingKey === null && returnFocus.current !== null) {
      editButtons.current.get(returnFocus.current)?.focus();
      returnFocus.current = null;
    }
  }, [editingKey]);
  const lines = useQuery({
    queryKey,
    queryFn: async () => {
      try {
        return checkedLines(await request('setupPublicLines', { params: { id } }));
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) await reread();
        throw err;
      }
    },
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const shown = PUBLIC_LINE_KEYS.flatMap((key) => lines.data?.lines.filter((line) => line.key === key && line.text.trim() !== '') ?? []);
  const confirmable = shown.filter((line) => !line.held);
  const unknown = lines.data?.lines.some((line) => !knownKey(line.key)) ?? false;
  const suggested = shown.filter((line) => line.source === 'suggested');
  const owned = shown.filter((line) => line.source === 'owner');
  const hours = lines.data?.hours?.source === 'suggested' ? lines.data.hours.windows : [];
  const prices = lines.data?.prices?.source === 'suggested' ? lines.data.prices.items : [];
  const hasSuggestions = suggested.length > 0 || hours.length > 0 || prices.length > 0;
  const confirmKeys = [...confirmable.map((line) => line.key), ...(hours.length > 0 ? ['hours'] : []), ...(prices.length > 0 ? ['prices'] : [])];
  const empty = lines.data !== undefined && !lines.isError && shown.length === 0 && !hasSuggestions && !unknown;
  const removeRows = [...suggested.map((line) => line.key), ...(hours.length ? ['hours-0'] : []), ...prices.map((item) => `prices-${item.item_id}`)];
  useEffect(() => {
    const target = returnRemoveFocus.current;
    if (!target || busy !== null || lines.data?.revision !== target.revision) return;
    const row = removeRows[target.index];
    const button = row === undefined ? null : removeButtons.current.get(row);
    (button ?? suggestedHeading.current ?? looksRightButton.current)?.focus();
    returnRemoveFocus.current = null;
  }, [busy, lines.data, removeRows]);
  useEffect(() => {
    const current = lines.data;
    if (!current || openedHeldOnLoad.current) return;
    openedHeldOnLoad.current = true;
    const held = PUBLIC_LINE_KEYS.map((key) => current.lines.find((line) => line.key === key)).find((line) => line?.held && canEdit(line));
    if (held) {
      setEditingKey(held.key);
      setText(held.text);
      setRefused(true);
    }
  }, [lines.data]);
  useEffect(() => {
    if (!lines.data || lines.isError || firstReadHandled.current) return;
    firstReadHandled.current = true;
    if (empty) onNext('safety_check');
  }, [lines.data, lines.isError, empty, onNext]);

  const cancel = () => {
    returnFocus.current = editingKey;
    setEditingKey(null);
    setError(null);
    setRefused(false);
  };
  const edit = (line: SetupPublicLine) => {
    setText(line.text);
    setEditingKey(line.key);
    setError(null);
    setRefused(line.held === true);
  };
  const save = async () => {
    if (editingKey === null || busy !== null || invalid) return;
    setBusy('save');
    setError(null);
    setRefused(false);
    try {
      const saved = checkedLines(await request('setupPublicLine', { params: { id }, body: { key: editingKey, text } }));
      const savedLine = saved.lines.find((line) => line.key === editingKey);
      if (!savedLine || (!savedLine.held && savedLine.source !== 'owner')) throw new Error('unconfirmed edited line');
      queryClient.setQueryData(queryKey, saved);
      if (savedLine.held) setRefused(true);
      else cancel();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) await reread();
      if (err instanceof ApiError && err.status === 422 && err.code === 'line_refused') {
        if (err.lineKey === editingKey) setRefused(true);
        else setError(copy.refused);
      } else setError(ownerErrorCopy(err));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (key: string, row: string, itemId?: string) => {
    if (editingKey !== null || busy !== null) return;
    setBusy('remove');
    setRemoving(row);
    setError(null);
    try {
      const price = lines.data?.prices?.items.find((item) => item.item_id === itemId);
      if (key === 'prices' && price === undefined) throw new Error('missing price');
      const saved = checkedLines(price === undefined
        ? await request('removePublicLine', { params: { id, key } })
        : await request('removePublicPrice', {
          params: { id, item_id: price.item_id }, query: { title: price.title, unit_cents: price.unit_cents },
        }));
      let changed = false;
      if (itemId !== undefined) {
        const remaining = lines.data?.prices?.items.filter((item) => item.item_id !== itemId);
        changed = !remaining || remaining.length !== (saved.prices?.items.length ?? 0)
          || remaining.some((item, index) => item.title !== saved.prices?.items[index]?.title || item.unit_cents !== saved.prices?.items[index]?.unit_cents)
          || (remaining.length === 0 ? saved.prices !== null : saved.prices?.source !== 'suggested');
      } else changed = key === 'hours' ? saved.hours !== null : saved.lines.some((line) => line.key === key);
      queryClient.setQueryData(queryKey, saved);
      returnRemoveFocus.current = { revision: saved.revision, index: removeRows.indexOf(row) };
      if (changed) setError(CHANGED_REFRESHED.en);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || (err.status === 422 && err.code === 'not_suggested'))) {
        const current = await reread();
        if (current && (current.step === 'rules' || current.step === 'situations')) {
          const refreshed = await lines.refetch();
          if (refreshed.isSuccess) {
            returnRemoveFocus.current = { revision: refreshed.data.revision, index: removeRows.indexOf(row) };
            setError(CHANGED_REFRESHED.en);
          }
        }
        if (current === null) setError(ownerErrorCopy(err));
      } else setError(ownerErrorCopy(err));
    } finally {
      setBusy(null);
      setRemoving(null);
    }
  };
  const confirm = async () => {
    if (editingKey !== null || busy !== null || lines.data === undefined || unknown) return;
    if (confirmKeys.length === 0) {
      onNext('safety_check');
      return;
    }
    setBusy('confirm');
    setError(null);
    try {
      const confirmed = checkedLines(await request('setupPublicLinesConfirm', { params: { id }, body: { keys: confirmKeys, revision: lines.data.revision } }));
      queryClient.setQueryData(queryKey, confirmed);
      if (confirmed.lines.some((line) => !knownKey(line.key))) throw new Error('unknown public line');
      if (confirmable.some((line) => !confirmed.lines.some((saved) => saved.key === line.key && saved.source === 'owner' && !saved.held))
        || (hours.length > 0 && confirmed.hours?.source !== 'owner')
        || (prices.length > 0 && confirmed.prices?.source !== 'owner')) throw new Error('unconfirmed suggestions');
      onNext('safety_check');
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || (err.status === 422 && err.code === 'invalid'))) {
        const current = await reread();
        const stillHere = current?.step === 'rules' || current?.step === 'situations';
        if (stillHere) {
          const refreshed = await lines.refetch();
          if (refreshed.isSuccess) setError(CHANGED_REFRESHED.en);
          return;
        }
      }
      const line = err instanceof ApiError && err.status === 422 && err.code === 'line_refused'
        ? shown.find((line) => line.key === err.lineKey && canEdit(line)) : undefined;
      if (line) {
        setText(line.text);
        setEditingKey(line.key);
        setRefused(true);
      } else setError(err instanceof ApiError && err.status === 422 && err.code === 'line_refused' ? copy.refused : ownerErrorCopy(err));
    } finally {
      setBusy(null);
    }
  };

  const renderRemove = (key: string, row: string, describedBy: string, itemId?: string) => {
    const buttonRef = (button: HTMLButtonElement | null) => {
      if (button) removeButtons.current.set(row, button);
      else removeButtons.current.delete(row);
    };
    return editingKey !== null ? (
      <Button variant="ghost" disabled describedBy={describedBy} buttonRef={buttonRef}>{copy.remove}</Button>
    ) : (
      <Button variant="ghost" waiting={busy !== null} busy={removing === row} describedBy={describedBy} buttonRef={buttonRef}
        onClick={() => void remove(key, row, itemId)}>{copy.remove}</Button>
    );
  };

  const renderLine = (line: SetupPublicLine) => (
    <div className={`cd-public-lines__row${canEdit(line) || line.source === 'suggested' ? '' : ' cd-public-lines__row--readonly'}`} key={line.key}>
      <label id={`${fieldId}-${line.key}`} htmlFor={editingKey === line.key ? fieldId : undefined} className="cd-public-lines__label cd-type-meta">
        {labelOf(line)}
      </label>
      {editingKey === line.key ? (
        <div className="cd-public-lines__editor">
          <div className="cd-text-field cd-text-field--multiline">
            <textarea
              id={fieldId}
              className="cd-text-field__input cd-type-body"
              autoFocus
              rows={4}
              maxLength={limit}
              value={text}
              readOnly={busy !== null}
              aria-invalid={refused || undefined}
              aria-describedby={refused ? `${fieldId}-error` : undefined}
              onChange={(event) => setText(event.target.value)}
            />
            <div className="cd-text-field__error-region" aria-live="polite">
              {refused ? (
                <p id={`${fieldId}-error`} className="cd-text-field__error cd-type-meta">
                  <StatusDot tone="refused" /><span>{copy.refused}</span>
                </p>
              ) : null}
            </div>
          </div>
          <div className="cd-setup-step__actions">
            {invalid ? <Button variant="primary" disabled>{copy.save}</Button> : (
              <Button variant="primary" busy={busy === 'save'} onClick={() => void save()}>{copy.save}</Button>
            )}
            <Button variant="ghost" waiting={busy !== null} onClick={cancel}>{copy.cancel}</Button>
          </div>
        </div>
      ) : (
        <>
          <div className="cd-public-lines__text" data-copy="user">
            {line.text.split('\n').map((text, index) => <p key={index}>{text}</p>)}
          </div>
          {canEdit(line) || line.source === 'suggested' ? (
            <div className="cd-public-lines__actions">
              {canEdit(line) ? (
                <Button
                  variant="ghost"
                  disabled={editingKey !== null} waiting={busy !== null}
                  describedBy={`${fieldId}-${line.key}`}
                  buttonRef={(button) => {
                    if (button) editButtons.current.set(line.key, button);
                    else editButtons.current.delete(line.key);
                  }}
                  onClick={() => edit(line)}
                >
                  {copy.edit}
                </Button>
              ) : null}
              {line.source === 'suggested' ? renderRemove(line.key, line.key, `${fieldId}-${line.key}`) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
  const renderStructured = (key: 'hours' | 'prices', index: number, label: string, value: string | string[], itemId?: string) => {
    const row = key === 'prices' ? `prices-${itemId}` : `hours-${index}`;
    return (
      <div className={`cd-public-lines__row${label ? '' : ' cd-public-lines__row--continuation'}`} key={row}>
        <span className="cd-public-lines__label cd-type-meta">{label}</span>
        <div id={`${fieldId}-${row}`} className="cd-public-lines__text" data-copy="user">
          {Array.isArray(value) ? value.map((text, index) => <p key={index}>{text}</p>) : value}
        </div>
        <div className="cd-public-lines__actions">
          {renderRemove(key, row, `${fieldId}-${row}`, itemId)}
        </div>
      </div>
    );
  };

  if (empty && !firstReadHandled.current) return null;

  let body: ReactNode = null;
  if (lines.isError) {
    body = (
      <Notice tone="error" action={<Button variant="secondary" onClick={() => void lines.refetch()}>{SETUP_COPY.questions.tryAgain}</Button>}>
        {ownerErrorCopy(lines.error)}
      </Notice>
    );
  } else if (lines.data !== undefined) {
    body = (
      <>
        {hasSuggestions ? (
          <Card padding={16}>
            <div className="cd-public-lines-suggested">
              <div ref={suggestedHeading} tabIndex={-1} className="cd-public-lines-suggested__heading cd-type-control">
                <StatusDot tone="held" /><span>{copy.suggestedTitle}</span>
              </div>
              <p className="cd-public-lines-suggested__intro cd-type-meta">{copy.suggestedIntro}</p>
              <div className="cd-public-lines">
                {suggested.map(renderLine)}
                {hours.length > 0 ? renderStructured('hours', 0, copy.hours, hours.map(formatPublicHours)) : null}
                {prices.map((item, index) => renderStructured('prices', index, index === 0 ? copy.prices : '', formatPublicPrice(item), item.item_id))}
              </div>
            </div>
          </Card>
        ) : null}
        {owned.length > 0 ? (
          <Card padding={16}><div className="cd-public-lines cd-public-lines--owned">{owned.map(renderLine)}</div></Card>
        ) : null}
        <div className="cd-setup-step__actions">
          {editingKey !== null || unknown ? (
            <Button variant="primary" size="main" disabled buttonRef={looksRightButton}>{SETUP_COPY.situations.looksRight}</Button>
          ) : (
            <Button variant="primary" size="main" buttonRef={looksRightButton} waiting={busy !== null && busy !== 'confirm'} busy={busy === 'confirm'} onClick={() => void confirm()}>
              {SETUP_COPY.situations.looksRight}
            </Button>
          )}
        </div>
      </>
    );
  }

  return (
    <div className="cd-setup-step">
      <PageHeader title={copy.title} subtitle={copy.subtitle} />
      {error !== null || unknown ? (
        <div ref={notice}><Notice tone="error">{error ?? ownerErrorCopy(null)}</Notice></div>
      ) : null}
      {/* While the lines are read, they draw as their shapes, then land where the shapes were. */}
      <SkeletonScreen
        loading={lines.data === undefined && !lines.isError}
        status={SETUP_COPY.questions.loading}
        skeleton={<PublicLinesSkeleton />}
        className="cd-setup-step__region"
      >
        {body}
      </SkeletonScreen>
    </div>
  );
}
