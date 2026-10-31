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
  /** The row's place in the list, from 0: a live row lands `motion-stagger` after the one before it. */
  index: number;
  /**
   * The row came with results that just arrived: it lands `index` × `motion-stagger` after the
   * first, rising `space-4` as it fades in, its dot scaling in with it. Without it the row is drawn
   * still, as results the owner didn't just ask for are. The screen clears it once the rows have
   * landed, so nothing replays them.
   */
  live?: boolean;
}

/**
 * One trick the setup safety check tried on the draft rules: what kind it is, the words it tried in
 * quotes and the checkpoint that stopped it at the left; at the right "Blocked" or "Not blocked"
 * beside its dot, and the kernel's reason under it. Live rows land one by one, `motion-stagger`
 * apart, and appear at once under reduced motion. Hairlines are drawn only between rows; put
 * each in a list item.
 */
export function SafetyCheckRow({ label, attempt, blocked, stoppedBy, reason, index, live = false }: SafetyCheckRowProps) {
  const style = { '--cd-safety-check-index': Math.max(0, Math.floor(index)) } as CSSProperties;
  return (
    <div className={live ? 'cd-safety-check-row cd-safety-check-row--live' : 'cd-safety-check-row'} style={style}>
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
