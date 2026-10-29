import { useId, type ChangeEvent } from 'react';

import { StatusDot } from '../StatusDot/StatusDot.tsx';

import './TextField.css';

export interface TextFieldProps {
  /** What to type, shown above the field and naming it: "Passcode", "Your business". */
  label: string;
  value: string;
  /** Called with the new text on every change; the field shows whatever `value` the form passes back. */
  onChange: (value: string) => void;
  /** `text` (the default) or `password`. Not used with `multiline`. */
  type?: 'text' | 'password';
  /** A text area of four lines, which Enter adds lines to. */
  multiline?: boolean;
  /** One line under the field that helps fill it in: "Include your first name as customers should see it." */
  hint?: string;
  /** What is wrong and how to fix it, never a code: "That passcode didn't work. Check it and try again." */
  error?: string;
  /** The browser's autofill hint: "current-password", "organization". */
  autoComplete?: string;
  /** The most characters the field takes; the browser stops typing and pasting there (1500 for a business description). */
  maxLength?: number;
}

/**
 * A labelled text input, or a text area with `multiline`: the label above, then the field, the hint
 * and any error under it. The hint and the error describe the field (`aria-describedby`), and an
 * error also marks it `aria-invalid`. The error line is announced when it appears.
 */
export function TextField({ label, value, onChange, type = 'text', multiline = false, hint, error, autoComplete, maxLength }: TextFieldProps) {
  const id = useId();
  const fieldId = `${id}-field`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const invalid = error !== undefined && error !== '';
  const describedBy = [invalid ? errorId : null, hint ? hintId : null].filter((part) => part !== null).join(' ') || undefined;

  const shared = {
    id: fieldId,
    className: 'cd-text-field__input cd-type-body',
    value,
    autoComplete,
    maxLength,
    'aria-invalid': invalid || undefined,
    'aria-describedby': describedBy,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
  };

  return (
    <div className={`cd-text-field${multiline ? ' cd-text-field--multiline' : ''}`}>
      <label htmlFor={fieldId} className="cd-text-field__label cd-type-control">
        {label}
      </label>
      {multiline ? <textarea {...shared} rows={4} /> : <input {...shared} type={type} />}
      {hint ? (
        <p id={hintId} className="cd-text-field__hint cd-type-meta">
          {hint}
        </p>
      ) : null}
      {/* Always present, so an error that appears after a submit is announced. */}
      <div className="cd-text-field__error-region" aria-live="polite">
        {invalid ? (
          <p id={errorId} className="cd-text-field__error cd-type-meta">
            <StatusDot tone="refused" />
            <span>{error}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
