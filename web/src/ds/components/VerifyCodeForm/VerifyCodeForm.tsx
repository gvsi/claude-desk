import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { Button } from '../Button/Button.tsx';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { Notice } from '../Notice/Notice.tsx';
import { VERIFY_COPY } from './verifyCopy.ts';

import './VerifyCodeForm.css';

/** The length of a verification code, in digits. */
const CODE_LENGTH = 6;

/** A whole code: exactly six ASCII digits. */
const WHOLE_CODE = /^[0-9]{6}$/;

/**
 * The digits in some text, at most six: letters, spaces and dashes are dropped, and full-width
 * digits, which some keyboards type, count as the digits they are. This is the field's only limit:
 * a `maxlength` would let the browser cut a code at six characters before its spaces or dash are
 * dropped, so "48 29 13" brought in by a keyboard's clipboard suggestion or a drop would keep
 * four digits.
 */
function digitsOf(text: string): string {
  return text.normalize('NFKC').replace(/[^0-9]/g, '').slice(0, CODE_LENGTH);
}

/** `idle` waiting for a code, `checking` while one is checked, `failed` after one didn't work. */
export type VerifyCodeState = 'idle' | 'checking' | 'failed';

export interface VerifyCodeFormProps {
  state: VerifyCodeState;
  /** Called with the six digits typed. */
  onSubmit: (code: string) => void;
  /** "I can't get the code": the visitor asks for the owner instead. */
  onAskForOwner: () => void;
  /** The visitor's language. */
  language: CopyLanguage;
}

/**
 * The six-digit code a visitor types under the verify card. The card carries the kernel's message,
 * so the form says nothing of its own beyond its label, its buttons and a failed try's line.
 */
export function VerifyCodeForm({ state, onSubmit, onAskForOwner, language }: VerifyCodeFormProps) {
  const copy = VERIFY_COPY[language];
  const id = useId();
  const fieldId = `${id}-code`;
  const failedId = `${id}-failed`;
  const fieldRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState('');
  // Set by a submit and cleared when the screen's state moves on or the code changes, so a second
  // Enter before the screen says it is checking can't spend another try on the same code.
  const sent = useRef(false);

  const checking = state === 'checking';
  const failed = state === 'failed';
  const whole = WHOLE_CODE.test(code);

  useEffect(() => {
    sent.current = false;
  }, [state]);

  // After a failed try the field takes focus with its code selected, ready to type over. The line
  // is gone while the next code is checked, so each failure is a new alert and is read out.
  useEffect(() => {
    if (!failed) return;
    fieldRef.current?.focus();
    fieldRef.current?.select();
  }, [failed]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (checking || !whole || sent.current) return;
    sent.current = true;
    onSubmit(code);
  };

  // Two rules before the field changes; everything else goes on to `change`. A native listener,
  // since React's `onBeforeInput` isn't the browser's `beforeinput`.
  // - Text that brings six digits or more of its own is a whole new code: its first six digits
  //   are the code, whatever the field held, so a visitor who pastes the newest code after a failed
  //   one sends that code, never the old one again.
  // - Typing into a whole code, with nothing selected, is refused, so the six digits and the caret
  //   stay as they were, as a length limit would keep them. Typing or pasting over a selection
  //   replaces it as usual.
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return undefined;
    const beforeInput = (event: InputEvent) => {
      if (!event.cancelable || !event.inputType.startsWith('insert')) return;
      const inserted = digitsOf(event.data ?? event.dataTransfer?.getData('text/plain') ?? '');
      if (inserted.length === CODE_LENGTH) {
        event.preventDefault();
        sent.current = false;
        setCode(inserted);
        return;
      }
      const collapsed = field.selectionStart === field.selectionEnd;
      if (event.inputType === 'insertText' && collapsed && WHOLE_CODE.test(field.value)) event.preventDefault();
    };
    field.addEventListener('beforeinput', beforeInput);
    return () => field.removeEventListener('beforeinput', beforeInput);
  }, []);

  const change = (next: string) => {
    sent.current = false;
    setCode(digitsOf(next));
  };

  return (
    <form className="cd-verify-code" lang={language} aria-busy={checking || undefined} noValidate onSubmit={submit}>
      <div className="cd-verify-code__entry">
        <label htmlFor={fieldId} className="cd-verify-code__label cd-type-control">
          {copy.label}
        </label>
        <div className="cd-verify-code__row">
          <input
            ref={fieldRef}
            id={fieldId}
            className="cd-verify-code__field cd-type-body"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            aria-invalid={failed || undefined}
            aria-describedby={failed ? failedId : undefined}
            onChange={(event) => change(event.target.value)}
          />
          {/* Busy keeps the words and the focus: the button stays focusable but inert. */}
          <Button variant="primary" size="main" type="submit" disabled={!whole && !checking} busy={checking}>
            {copy.confirm}
          </Button>
        </div>
      </div>
      {failed ? (
        <div id={failedId}>
          <Notice tone="error">{copy.failed}</Notice>
        </div>
      ) : null}
      <div className="cd-verify-code__help">
        <Button variant="ghost" onClick={onAskForOwner}>
          {copy.cantGetCode}
        </Button>
      </div>
    </form>
  );
}
