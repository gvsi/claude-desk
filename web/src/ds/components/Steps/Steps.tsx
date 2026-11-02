import { Icon } from '../../icons/index.tsx';

import './Steps.css';

export interface StepsProps {
  /** What the steps are of, which names the list: "Connect Google Calendar", "Set up your Desk". */
  label: string;
  /** Each step's name, in order: "Choose", "Sign in", "Review tools", "Confirm". */
  steps: readonly string[];
  /** The step the person is on, counted from 0; null until known. Steps before it are done; one past the last reads as the last. */
  current: number | null;
  /**
   * The flow is finished, as setup is once the Desk is live: the current step is done too. Its number
   * gives way to a check on the current step's fill, it reads "{name}, done", and it keeps
   * `aria-current="step"`.
   */
  finished?: boolean;
  /**
   * With `finished`, the current step's check draws once, as the person reaches it. Without it the
   * check is drawn from the start, as when the page opens on a finished flow. Static under reduced motion.
   */
  drawCheck?: boolean;
}

/**
 * Where a person is in a flow of a few steps: an ordered list in a row, joined by hairlines. Done
 * steps show a check and read "{name}, done"; the current one is a filled circle with its number
 * and `aria-current="step"`, or with a check once the flow is `finished`; later ones are quiet
 * numbered circles. Under 480 px of its own width the list is read but not drawn, and one line says
 * where the person is: "Step 1 of 5: Questions".
 */
export function Steps({ label, steps, current, finished = false, drawCheck = false }: StepsProps) {
  // The step the list marks and the line names: `current`, kept within the steps, so both say the same.
  const at = current === null ? null : Math.min(Math.max(current, 0), steps.length - 1);
  return (
    <div className="cd-steps-frame">
      <ol role="list" className="cd-steps cd-type-meta" aria-label={label}>
        {steps.map((step, index) => {
          const state = at === null ? 'later' : index < at ? 'done' : index === at ? 'current' : 'later';
          const done = state === 'done' || (state === 'current' && finished);
          return (
            <li
              key={`${index}-${step}`}
              className={`cd-steps__step cd-steps__step--${state}`}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              {index > 0 ? <span className="cd-steps__join" aria-hidden="true" /> : null}
              <span className="cd-steps__circle cd-type-caption" aria-hidden="true">
                {done ? (
                  <Icon name="check" size={14} className={state === 'current' && drawCheck ? 'cd-steps__check--draw' : undefined} />
                ) : (
                  index + 1
                )}
              </span>
              <span className="cd-steps__name">
                {step}
                {done ? <span className="cd-sr-only">, done</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
      {/* The list says the same to screen readers, so the line is drawn only. */}
      {at !== null && steps.length > 0 ? (
        <p className="cd-steps__compact cd-type-meta" aria-hidden="true">
          {`Step ${at + 1} of ${steps.length}: `}
          <span className="cd-steps__compact-name">{steps[at]}</span>
        </p>
      ) : null}
    </div>
  );
}
