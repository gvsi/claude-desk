import { useEffect, useRef, type FormEvent } from 'react';

import { Button } from '../Button/Button.tsx';
import { TextField } from '../TextField/TextField.tsx';

import './MoneyLimit.css';

export interface MoneyLimitProps {
  /**
   * The payment limit in the screen's words: "No payment over $500 goes through without asking
   * you, whatever the rules below say.", or "Every payment asks you first." when none is set.
   */
  line: string;
  /** The field is open. */
  editing: boolean;
  /** The field's label; "Most a payment can be without asking you, in dollars" by default. */
  label?: string;
  /** What the owner typed, as typed. */
  value: string;
  /** The line under the field, in the screen's words: "Whole dollars, from 0 to 10,000. Now $500." */
  hint: string;
  /** What is wrong with the value, from the screen's check: "No single payment can be above $10,000." */
  error?: string;
  /** "Change": the screen opens the field. */
  onEdit: () => void;
  /** Each change to the field, with the raw text. */
  onChange: (value: string) => void;
  /** "Review change", or Enter in the field: the screen checks the value it holds and drafts the change. */
  onReview: () => void;
  /** "Cancel": the screen closes the field. */
  onCancel: () => void;
  /** A draft is in flight: the buttons wait. */
  disabled?: boolean;
}

/**
 * The Desk's payment limit, the line at the top of a group of payment tools on the Rules page (its
 * `ConnectorSection`'s `aboveTools`): the limit in words with "Change", or, while editing, a field
 * with "Review change" and "Cancel". It never reads the value: the screen checks it, shows
 * `error`, and drafts the change, which applies only after its review.
 */
export function MoneyLimit({
  line,
  editing,
  label = 'Most a payment can be without asking you, in dollars',
  value,
  hint,
  error,
  onEdit,
  onChange,
  onReview,
  onCancel,
  disabled = false,
}: MoneyLimitProps) {
  const root = useRef<HTMLDivElement>(null);
  // Opening the field puts focus in it; closing it puts focus back on "Change". Only when the
  // screen switches it, never on first render, so a page that opens with the field steals no focus.
  const wasEditing = useRef(editing);
  useEffect(() => {
    if (wasEditing.current === editing) return;
    wasEditing.current = editing;
    const target = editing ? root.current?.querySelector('input') : root.current?.querySelector('button');
    target?.focus();
  }, [editing]);

  const review = (event?: FormEvent) => {
    event?.preventDefault();
    if (disabled) return;
    onReview();
  };

  return (
    <div ref={root} className={`cd-money-limit${editing ? ' cd-money-limit--editing' : ''}`}>
      {editing ? (
        <form className="cd-money-limit__form" noValidate onSubmit={review}>
          <div className="cd-money-limit__field">
            <TextField label={label} value={value} hint={hint} error={error} autoComplete="off" onChange={(next) => onChange(next)} />
          </div>
          <div className="cd-money-limit__controls">
            <Button variant="primary" type="submit" waiting={disabled}>
              Review change
            </Button>
            <Button variant="secondary" waiting={disabled} onClick={() => onCancel()}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="cd-money-limit__reading">
          <p className="cd-money-limit__line cd-type-body">{line}</p>
          <Button variant="secondary" waiting={disabled} onClick={() => onEdit()}>
            Change
          </Button>
        </div>
      )}
    </div>
  );
}
