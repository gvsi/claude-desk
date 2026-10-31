import { useId } from 'react';

import type { SetupStep } from '../../api/views.ts';
import { Button, Card, StatusLabel, Steps } from '../../ds/index.ts';
import { STEP_INDEX, STEP_NAMES } from '../../setup/copy.ts';
import { CONTINUE_SETUP_COPY, CONTINUE_SETUP_LINES } from './copy.ts';

export interface ContinueSetupProps {
  /** The business's name: the owner's own words. */
  business: string;
  /** The Desk's setup interview, which `/app/setup/{id}` reopens at its step. */
  interviewId: string;
  /** The step it stopped at; a Desk that is live has no card. */
  step: Exclude<SetupStep, 'live'>;
}

/**
 * Today's card for a Desk whose setup isn't finished, at the top of the page's column: "Not live
 * yet", whose setup it is, where the owner picks up and that Answering stays off until then,
 * "Continue setup" back into the interview, and the setup steps at the one it stopped at. The
 * button sits at the words' right, and under them on a phone.
 */
export function ContinueSetup({ business, interviewId, step }: ContinueSetupProps) {
  const titleId = useId();
  return (
    <section className="cd-continue-setup" aria-labelledby={titleId}>
      <Card padding={20}>
        <div className="cd-continue-setup__body">
          <div className="cd-continue-setup__head">
            <div className="cd-continue-setup__words">
              <p className="cd-continue-setup__status cd-type-meta">
                <StatusLabel tone="held">{CONTINUE_SETUP_COPY.notLive}</StatusLabel>
              </p>
              <h2 id={titleId} className="cd-continue-setup__title cd-type-section">
                {CONTINUE_SETUP_COPY.title}
                <span data-copy="user">{business}</span>
              </h2>
              <p className="cd-continue-setup__line cd-type-body">{CONTINUE_SETUP_LINES[step]}</p>
            </div>
            <div className="cd-continue-setup__action">
              <Button variant="primary" href={`/app/setup/${encodeURIComponent(interviewId)}`}>
                {CONTINUE_SETUP_COPY.action}
              </Button>
            </div>
          </div>
          <Steps label={CONTINUE_SETUP_COPY.stepsLabel} steps={STEP_NAMES} current={STEP_INDEX[step]} />
        </div>
      </Card>
    </section>
  );
}
