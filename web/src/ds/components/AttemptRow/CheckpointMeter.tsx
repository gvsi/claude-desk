import './CheckpointMeter.css';

/** The four checks a request passes, in the order they run. */
export type Checkpoint = 'who' | 'action' | 'review' | 'reply';

/** Each checkpoint's name, as the owner reads it. A missing checkpoint is a compile error. */
const CHECKPOINT_NAMES = {
  who: "Who's asking",
  action: 'Action checkpoint',
  review: 'Auto reviewer',
  reply: 'Reply checkpoint',
} as const satisfies Record<Checkpoint, string>;

const CHECKPOINT_ORDER = Object.keys(CHECKPOINT_NAMES) as readonly Checkpoint[];

export interface CheckpointMeterProps {
  /** The checkpoint that stopped the attempt. */
  stoppedBy: Checkpoint;
}

/**
 * Where an attempt was stopped: four segments in the order the checks run, the ones it passed
 * filled, the one that stopped it in the refused color and the rest hollow, then that
 * checkpoint's name in words. The segments are hidden from screen readers; the words carry it,
 * read as "Stopped by: Action checkpoint".
 */
export function CheckpointMeter({ stoppedBy }: CheckpointMeterProps) {
  const stop = CHECKPOINT_ORDER.indexOf(stoppedBy);
  return (
    <span className="cd-checkpoint-meter">
      <span className="cd-checkpoint-meter__segments" aria-hidden="true">
        {CHECKPOINT_ORDER.map((checkpoint, index) => {
          const state = index < stop ? 'passed' : index === stop ? 'stopped' : 'unreached';
          return <span key={checkpoint} className={`cd-checkpoint-meter__segment cd-checkpoint-meter__segment--${state}`} />;
        })}
      </span>
      <span className="cd-checkpoint-meter__name cd-type-caption">
        <span className="cd-sr-only">Stopped by: </span>
        {CHECKPOINT_NAMES[stoppedBy]}
      </span>
    </span>
  );
}
