import { useEffect, useId, useRef, useState, type ClipboardEvent, type FormEvent } from 'react';

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
 * digits, which some keyboards type, count as the digits they are.
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

  const change = (next: string) => {
    sent.current = false;
    setCode(digitsOf(next));
  };

  // The browser would cut a paste at six characters before dropping what isn't a digit, so
  // "482 913" would lose its last digit. The form takes the digits of the paste itself, in place of
  // whatever was selected.
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const input = event.currentTarget;
    const start = input.selectionStart ?? code.length;
    const end = input.selectionEnd ?? code.length;
    change(code.slice(0, start) + event.clipboardData.getData('text') + code.slice(end));
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
            maxLength={CODE_LENGTH}
            value={code}
            aria-invalid={failed || undefined}
            aria-describedby={failed ? failedId : undefined}
            onChange={(event) => change(event.target.value)}
            onPaste={paste}
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
