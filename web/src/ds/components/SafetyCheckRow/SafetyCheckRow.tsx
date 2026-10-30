import type { CSSProperties } from 'react';

import { checkpointName, type Checkpoint } from '../AttemptRow/CheckpointMeter.tsx';
import { StatusDot } from '../StatusDot/StatusDot.tsx';

import './SafetyCheckRow.css';

export interface SafetyCheckRowProps {
  /** The kind of trick, as Safety names it: "Posing as you", "Money", "Codes". */
  label: string;
  /** The words the check tried, as a visitor would type them. Shown in quotes, as their words. */
  attempt: string;
  /** Whether the draft rules stopped it. */
  blocked: boolean;
  /** The checkpoint that stopped it, when it was stopped. */
  stoppedBy?: Checkpoint;
  /** The kernel's `reason_plain`, as written. */
  reason: string;
  /** The row's place in the list, from 0: it appears `motion-stagger` after the one before it. */
  index: number;
}

/**
 * One trick the setup safety check tried on the draft rules: what kind it is, the words it tried in
 * quotes and the checkpoint that stopped it at the left; at the right "Blocked" or "Not blocked"
 * beside its dot, and the kernel's reason under it. The rows arrive one by one, `motion-stagger`
 * apart, and appear at once under reduced motion. The row is drawn with a hairline over it; put
 * each in a list item.
 */
export function SafetyCheckRow({ label, attempt, blocked, stoppedBy, reason, index }: SafetyCheckRowProps) {
  const style = { '--cd-safety-check-index': Math.max(0, Math.floor(index)) } as CSSProperties;
  return (
    <div className="cd-safety-check-row" style={style}>
      <div className="cd-safety-check-row__grid">
        <div className="cd-safety-check-row__trick">
          <p className="cd-safety-check-row__label cd-type-control">{label}</p>
          <p className="cd-safety-check-row__attempt cd-type-meta">
            “<span data-copy="user">{attempt}</span>”
          </p>
          {blocked && stoppedBy !== undefined ? (
            <p className="cd-safety-check-row__checkpoint cd-type-caption">{checkpointName(stoppedBy)}</p>
          ) : null}
        </div>
        <div className="cd-safety-check-row__result">
          <p className="cd-safety-check-row__outcome cd-type-meta">
            <StatusDot tone={blocked ? 'refused' : 'held'} />
            <span>{blocked ? 'Blocked' : 'Not blocked'}</span>
          </p>
          <p className="cd-safety-check-row__reason cd-type-meta">{reason}</p>
        </div>
      </div>
    </div>
  );
}
