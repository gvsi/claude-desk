import { useId } from 'react';

import './Switch.css';

export interface SwitchProps {
  /** What the switch turns on or off: "Answering", "Customers can see this". */
  label: string;
  /** One line under the label saying what "on" means: "Claude answers under your rules". */
  description?: string;
  checked: boolean;
  /** Called with the new value; the switch shows whatever `checked` the screen passes back. */
  onChange: (checked: boolean) => void;
}

/**
 * An on/off setting as one row: the label and its description, then the track. The whole row is
 * the control, a `button` with `role="switch"`, named by the label and described by the description.
 */
export function Switch({ label, description, checked, onChange }: SwitchProps) {
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
      className="cd-switch"
      onClick={() => onChange(!checked)}
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
