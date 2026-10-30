import { useId } from 'react';

import type { ConversationSummary } from '../../api/views.ts';
import { ConversationListItem, SectionHeader } from '../../ds/index.ts';
import { formatClock } from '../../lib/format.ts';
import { conversationPath, conversationStatus, whoLabel } from '../conversations/status.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';

export interface LiveNowProps {
  /** Today's live conversations: activity in the last five minutes, newest first. */
  live: readonly ConversationSummary[];
}

/**
 * Today's "Live now": each conversation with activity in the last five minutes, a link to watch
 * it. The owner's own chat as a customer is among them, as "Your preview".
 */
export function LiveNow({ live }: LiveNowProps) {
  const { business, desk } = useOwnerDesk();
  const titleId = useId();
  const n = live.length;
  return (
    <section className="cd-today__section" aria-labelledby={titleId}>
      <SectionHeader id={titleId} title="Live now" count={{ n, label: `${n} live ${n === 1 ? 'conversation' : 'conversations'}` }} />
      <ul className="cd-live">
        {live.map((s) => (
          <li key={s.session_id}>
            <ConversationListItem
              name={whoLabel(s)}
              time={formatClock(s.last_activity, business.timezone)}
              status={conversationStatus(s, s.outcome_counts.held ?? 0)}
              href={conversationPath(desk.desk_id, s.session_id)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
