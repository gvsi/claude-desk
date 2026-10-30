import { Icon } from '../../icons/index.tsx';

import './Steps.css';

export interface StepsProps {
  /** What the steps are of, which names the list: "Connect Google Calendar", "Set up your Desk". */
  label: string;
  /** Each step's name, in order: "Choose", "Sign in", "Review tools", "Confirm". */
  steps: readonly string[];
  /** The step the person is on, counted from 0. Steps before it are done. */
  current: number;
}

/**
 * Where a person is in a flow of a few steps: an ordered list in a row, joined by hairlines. Done
 * steps show a check and read "{name}, done"; the current one is a filled circle with its number
 * and `aria-current="step"`; later ones are quiet numbered circles.
 */
export function Steps({ label, steps, current }: StepsProps) {
  return (
    <ol className="cd-steps cd-type-meta" aria-label={label}>
      {steps.map((step, index) => {
        const state = index < current ? 'done' : index === current ? 'current' : 'later';
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
  );
}
