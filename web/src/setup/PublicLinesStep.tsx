import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';

import { ApiError, ownerErrorCopy, request } from '../api/http.ts';
import type { PublicLine, PublicLines, SetupState, SetupStep } from '../api/views.ts';
import { Button, Card, LoadingLine, Notice, PageHeader, StatusDot } from '../ds/index.ts';
import { cardChrome } from '../ds/components/ReplyCard/chrome.ts';
import { PUBLIC_LINE_KEYS, SETUP_COPY } from './copy.ts';

import './PublicLinesStep.css';

const copy = SETUP_COPY.publicLines;

/** A malformed answer holds this step, including a 200 that cannot confirm what was checked. */
function checkedLines(value: PublicLines): PublicLines {
  if (
    !value || !Array.isArray(value.lines) || value.lines.some((line) =>
      !line || typeof line.key !== 'string' || typeof line.text !== 'string' || !line.text.trim()
      || typeof line.editable !== 'boolean' || (line.source !== 'owner' && line.source !== 'suggested'),
    ) || new Set(value.lines.map((line) => line.key)).size !== value.lines.length
  ) throw new Error('invalid public lines');
  return value;
}

const canEdit = (line: PublicLine) => line.editable && line.key !== 'policy:how_we_help';

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
  const [busy, setBusy] = useState<'save' | 'confirm' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnFocus = useRef<string | null>(null);
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
  const empty = lines.data !== undefined && shown.length === 0;
  useEffect(() => {
    if (empty) onNext('safety_check');
  }, [empty, onNext]);

  const cancel = () => {
    returnFocus.current = editingKey;
    setEditingKey(null);
    setError(null);
    setRefused(false);
  };
  const edit = (line: PublicLine) => {
    setText(line.text);
    setEditingKey(line.key);
    setError(null);
    setRefused(false);
  };
  const save = async () => {
    if (editingKey === null || busy !== null) return;
    setBusy('save');
    setError(null);
    setRefused(false);
    try {
      const saved = checkedLines(await request('setupPublicLine', { params: { id }, body: { key: editingKey, text } }));
      if (!saved.lines.some((line) => line.key === editingKey)) throw new Error('missing edited line');
      queryClient.setQueryData(queryKey, saved);
      cancel();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) await reread();
      if (err instanceof ApiError && err.status === 422 && err.code === 'line_refused' && err.lineKey === editingKey) setRefused(true);
      else setError(ownerErrorCopy(err));
    } finally {
      setBusy(null);
    }
  };
  const confirm = async () => {
    if (editingKey !== null || busy !== null || lines.data === undefined) return;
    setBusy('confirm');
    setError(null);
    try {
      checkedLines(await request('setupPublicLinesConfirm', { params: { id }, body: {} }));
      onNext('safety_check');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) await reread();
      const line = err instanceof ApiError && err.status === 422 && err.code === 'line_refused'
        ? shown.find((line) => line.key === err.lineKey && canEdit(line)) : undefined;
      if (line) {
        setText(line.text);
        setEditingKey(line.key);
        setRefused(true);
      } else setError(ownerErrorCopy(err));
    } finally {
      setBusy(null);
    }
  };

  if (empty) return null;

  return (
    <div className="cd-setup-step">
      <PageHeader title={copy.title} subtitle={copy.subtitle} />
      {error !== null ? <Notice tone="error">{error}</Notice> : null}
      {lines.data === undefined ? (
        lines.isError ? (
          <Notice tone="error" action={<Button variant="secondary" onClick={() => void lines.refetch()}>{SETUP_COPY.questions.tryAgain}</Button>}>
            {ownerErrorCopy(lines.error)}
          </Notice>
        ) : <LoadingLine>{SETUP_COPY.questions.loading}</LoadingLine>
      ) : (
        <>
          <Card padding={16}>
            <div className="cd-public-lines">
              {shown.map((line) => (
                <div className={`cd-public-lines__row${canEdit(line) ? '' : ' cd-public-lines__row--readonly'}`} key={line.key}>
                  <label id={`${fieldId}-${line.key}`} htmlFor={editingKey === line.key ? fieldId : undefined} className="cd-public-lines__label cd-type-meta">
                    {cardChrome('policy', 'en', `charter:${line.key}`)?.label}
                  </label>
                  {editingKey === line.key ? (
                    <div className="cd-public-lines__editor">
                      <div className="cd-text-field cd-text-field--multiline">
                        <textarea
                          id={fieldId}
                          className="cd-text-field__input cd-type-body"
                          autoFocus
                          rows={4}
                          maxLength={500}
                          value={text}
                          readOnly={busy !== null}
                          aria-invalid={refused || undefined}
                          aria-describedby={refused ? `${fieldId}-error` : undefined}
                          onChange={(event) => setText(event.target.value.slice(0, 500))}
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
                        <Button variant="primary" busy={busy === 'save'} onClick={() => void save()}>{copy.save}</Button>
                        <Button variant="ghost" disabled={busy !== null} onClick={cancel}>{copy.cancel}</Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="cd-public-lines__text" data-copy="user">
                        {line.text.split('\n').map((text, index) => <p key={index}>{text}</p>)}
                      </div>
                      {canEdit(line) ? (
                        <Button
                          variant="ghost"
                          disabled={editingKey !== null || busy !== null}
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
                    </>
                  )}
                </div>
              ))}
            </div>
          </Card>
          <div className="cd-setup-step__actions">
            <Button variant="primary" size="main" disabled={editingKey !== null} busy={busy === 'confirm'} onClick={() => void confirm()}>
              {SETUP_COPY.situations.looksRight}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
