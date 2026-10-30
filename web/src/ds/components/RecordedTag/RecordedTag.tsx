import { Icon } from '../../icons/index.tsx';

import './RecordedTag.css';

export interface RecordedTagProps {
  /** Placement the consumer adds, such as pushing the tag to the end of its line. */
  className?: string;
}

/**
 * The quiet mark on a replayed row: a small history icon and the word "Recorded", in caption type
 * and secondary ink, on one line. It says the row is recorded history, replayed into this copy of
 * the demo, not something that happened since the owner arrived.
 */
export function RecordedTag({ className }: RecordedTagProps) {
  return (
    <span className={className ? `cd-recorded-tag cd-type-caption ${className}` : 'cd-recorded-tag cd-type-caption'}>
      <Icon name="history" size={14} />
      Recorded
    </span>
  );
}
