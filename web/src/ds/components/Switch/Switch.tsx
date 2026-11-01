import { useId } from 'react';

import './Switch.css';

export interface SwitchProps {
  /** What the switch turns on or off: "Claude acts for you", "Customers can see this". */
  label: string;
  /** One line under the label saying what "on" means: "Within your rules". */
  description?: string;
  checked: boolean;
  /** Called with the new value; the switch shows whatever `checked` the screen passes back. */
  onChange: (checked: boolean) => void;
  /**
   * A change is being saved: the switch says so (`aria-busy`, `aria-disabled`), keeps focus, and
   * ignores presses until the screen passes the answer back.
   */
  waiting?: boolean;
  /** Another write prevents changes: aria-disabled without announcing this switch as busy. */
  disabled?: boolean;
}

/**
 * An on/off setting as one row: the label and its description, then the track. The whole row is
 * the control, a `button` with `role="switch"`, named by the label and described by the description.
 */
export function Switch({ label, description, checked, onChange, waiting = false, disabled = false }: SwitchProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={description ? descriptionId : undefined}
      aria-disabled={waiting || disabled || undefined}
      aria-busy={waiting || undefined}
      className="cd-switch"
      onClick={() => {
        if (!waiting && !disabled) onChange(!checked);
      }}
    >
      <span className="cd-switch__text">
        <span id={labelId} className="cd-type-control">
          {label}
        </span>
        {description ? (
          <span id={descriptionId} className="cd-switch__description cd-type-caption">
            {description}
          </span>
        ) : null}
      </span>
      <span className="cd-switch__track" aria-hidden="true">
        <span className="cd-switch__knob" />
      </span>
    </button>
  );
}
