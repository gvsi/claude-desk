import { Card } from '../Card/Card.tsx';

import './LimitChange.css';

export interface LimitChangeProps {
  /** The new payment limit, in the screen's words: "New limit: no payment over $1,000 without asking you." */
  now: string;
  /** What it was, in the screen's words: "Was $500". */
  was: string;
}

/**
 * A change to the payment limit, above the change review: the new limit in Claude's serif and what
 * it was at the right. The screen words both amounts; nothing here reads or formats them.
 */
export function LimitChange({ now, was }: LimitChangeProps) {
  return (
    <Card as="section" label="Payment limit">
      <div className="cd-limit-change">
        <p className="cd-limit-change__now cd-type-summary">{now}</p>
        <p className="cd-limit-change__was cd-type-meta">{was}</p>
      </div>
    </Card>
  );
}
