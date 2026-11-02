import { useId, type ChangeEvent, type Ref } from 'react';

import { StatusDot } from '../StatusDot/StatusDot.tsx';

import './TextField.css';

export interface TextFieldProps {
  /** What to type, shown above the field and naming it: "Passcode", "Your business". */
  label: string;
  value: string;
  /** An example shown while the field is empty. */
  placeholder?: string;
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
  /** Caps the text at this many characters (1500 for a business description), with a counter from 90% of it. */
  maxLength?: number;
  /** Shows the text but takes no typing, while what was sent from it is still being settled. */
  readOnly?: boolean;
  /** The field's element, for a screen to move focus to it: setup's box, once an example is put in it. */
  fieldRef?: Ref<HTMLInputElement | HTMLTextAreaElement>;
}

/** The share of `maxLength` from which the counter shows. */
const COUNTER_FROM = 0.9;

/**
 * A labelled text input, or a text area with `multiline`: the label above, then the field, the hint
 * (and, from 90% of `maxLength`, a counter) and any error under it. The error, the hint and the
 * counter describe the field (`aria-describedby`), and an error also marks it `aria-invalid`. The
 * error line is announced when it appears.
 */
export function TextField({ label, value, placeholder, onChange, type = 'text', multiline = false, hint, error, autoComplete, maxLength, readOnly, fieldRef }: TextFieldProps) {
  const id = useId();
  const fieldId = `${id}-field`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const counterId = `${id}-counter`;
  const invalid = error !== undefined && error !== '';
  const showCounter = maxLength !== undefined && value.length >= maxLength * COUNTER_FROM;
  const describedBy =
    [invalid ? errorId : null, hint ? hintId : null, showCounter ? counterId : null].filter((part) => part !== null).join(' ') ||
    undefined;

  const shared = {
    // The one element drawn, an input or a text area: the screen's ref takes either.
    ref: fieldRef as Ref<HTMLInputElement & HTMLTextAreaElement> | undefined,
    id: fieldId,
    className: 'cd-text-field__input cd-type-body',
    value,
    placeholder,
    autoComplete,
    maxLength,
    readOnly,
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
      {hint || showCounter ? (
        <div className="cd-text-field__meta">
          {hint ? (
            <p id={hintId} className="cd-text-field__hint cd-type-meta">
              {hint}
            </p>
          ) : null}
          {showCounter ? (
            <p id={counterId} className="cd-text-field__counter cd-type-caption">
              {value.length} / {maxLength}
            </p>
          ) : null}
        </div>
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
