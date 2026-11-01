import { useId, type Ref } from 'react';

import type { ConversationSummary } from '../../api/views.ts';
import { ConversationListItem, SectionHeader } from '../../ds/index.ts';
import { formatClock } from '../../lib/format.ts';
import { attentionStatus, conversationPath, conversationStatus, whoLabel, type ConversationStatus } from '../conversations/status.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';

export interface LiveNowProps {
  /** Today's live conversations: activity in the last five minutes, newest first. */
  live: readonly ConversationSummary[];
  /** The section, which takes focus when dismissing Needs you's last request takes Needs you away. */
  sectionRef?: Ref<HTMLElement>;
  /** The chats with a handoff open (Needs you's handoff items), which say "Wants you". */
  openHandoffs?: ReadonlySet<string>;
}

/**
 * The status a Live now row shows: one that asks for the owner always ("Needs you", "Paused after
 * blocked attempts", "Wants you", "You're in this chat"), and what the person is ("Visitor",
 * "Verified customer") only while they've written nothing, so what they're asking takes its place
 * (owner decision, 2026-11-01). The Conversations list keeps every status.
 */
function liveStatus(s: ConversationSummary, openHandoff: boolean): ConversationStatus | undefined {
  const held = s.outcome_counts.held ?? 0;
  const quoted = (s.latest_visitor_text ?? '').trim() !== '';
  const status = quoted ? attentionStatus(s, held, openHandoff) : conversationStatus(s, held, openHandoff);
  return status ?? undefined;
}

/**
 * Today's "Live now": each conversation with activity in the last five minutes, a link to watch
 * it, quoting what its visitor wrote last unless the row has a status that asks for the owner
 * (`liveStatus`). Today's poll brings their newest words. The owner's own chat as a customer is
 * among them, as "Your preview".
 */
export function LiveNow({ live, sectionRef, openHandoffs }: LiveNowProps) {
  const { business, desk } = useOwnerDesk();
  const titleId = useId();
  const n = live.length;
  return (
    <section ref={sectionRef} className="cd-today__section" aria-labelledby={titleId} tabIndex={-1}>
      <SectionHeader
        id={titleId}
        title="Live now"
        count={{ n, label: `${n} live ${n === 1 ? 'conversation' : 'conversations'}` }}
        caption="Shows while someone is chatting"
      />
      <ul className="cd-live">
        {live.map((s) => (
          <li key={s.session_id}>
            <ConversationListItem
              name={whoLabel(s)}
              time={formatClock(s.last_activity, business.timezone)}
              status={liveStatus(s, openHandoffs?.has(s.session_id) ?? false)}
              href={conversationPath(desk.desk_id, s.session_id)}
              quote={s.latest_visitor_text ?? undefined}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
