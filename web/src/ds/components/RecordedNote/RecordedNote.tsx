import { Icon } from '../../icons/index.tsx';

import './RecordedNote.css';

/** The line, word for word: the ledger's explanation is titled with its first sentence. */
export const RECORDED_NOTE = 'Recorded history, replayed into your copy. It happened before you arrived.';

/** It takes no props: the line is fixed English, as the owner app is English only. */
export type RecordedNoteProps = Record<string, never>;

/**
 * The line at the top of a replayed conversation or attempt, once it is open: a small history icon
 * and the words that say it is recorded history, replayed into this copy before the owner arrived.
 */
export function RecordedNote() {
  return (
    <p className="cd-recorded-note cd-type-caption">
      <Icon name="history" size={14} />
      <span className="cd-recorded-note__text">{RECORDED_NOTE}</span>
    </p>
  );
}
