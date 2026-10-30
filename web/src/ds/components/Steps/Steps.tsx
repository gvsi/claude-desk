import { Icon } from '../../icons/index.tsx';

import './Steps.css';

export interface StepsProps {
  /** What the steps are of, which names the list: "Connect Google Calendar", "Set up your Desk". */
  label: string;
  /** Each step's name, in order: "Choose", "Sign in", "Review tools", "Confirm". */
  steps: readonly string[];
  /** The step the person is on, counted from 0. Steps before it are done; one past the last reads as the last. */
  current: number;
}

/**
 * Where a person is in a flow of a few steps: an ordered list in a row, joined by hairlines. Done
 * steps show a check and read "{name}, done"; the current one is a filled circle with its number
 * and `aria-current="step"`; later ones are quiet numbered circles. Under 480 px of its own width
 * the list is read but not drawn, and one line says where the person is: "Step 1 of 5: Questions".
 */
export function Steps({ label, steps, current }: StepsProps) {
  // The step the list marks and the line names: `current`, kept within the steps, so both say the same.
  const at = Math.min(Math.max(current, 0), steps.length - 1);
  return (
    <div className="cd-steps-frame">
      <ol role="list" className="cd-steps cd-type-meta" aria-label={label}>
        {steps.map((step, index) => {
          const state = index < at ? 'done' : index === at ? 'current' : 'later';
          return (
            <li
              key={`${index}-${step}`}
              className={`cd-steps__step cd-steps__step--${state}`}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              {index > 0 ? <span className="cd-steps__join" aria-hidden="true" /> : null}
              <span className="cd-steps__circle cd-type-caption" aria-hidden="true">
                {state === 'done' ? <Icon name="check" size={14} /> : index + 1}
              </span>
              <span className="cd-steps__name">
                {step}
                {state === 'done' ? <span className="cd-sr-only">, done</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
      {/* The list says the same to screen readers, so the line is drawn only. */}
      {steps.length > 0 ? (
        <p className="cd-steps__compact cd-type-meta" aria-hidden="true">
          {`Step ${at + 1} of ${steps.length}: `}
          <span className="cd-steps__compact-name">{steps[at]}</span>
        </p>
      ) : null}
    </div>
  );
}
