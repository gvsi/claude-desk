import { RecordedTag } from '../RecordedTag/RecordedTag.tsx';
import { StatusDot, type StatusTone } from '../StatusDot/StatusDot.tsx';

import './ConversationListItem.css';

export interface ConversationListItemProps {
  /** Who the conversation is with, as the owner's screen names them: "Dana Whitfield", "Visitor". */
  name: string;
  /** When it started or last moved, as the screen writes it: "12:04 pm". */
  time: string;
  /** The conversation's state: a tone for the dot and the words that say the same, "Needs you". */
  status: { tone: StatusTone; text: string };
  /** The conversation's page. */
  href: string;
  /** The conversation open beside the list: marked `aria-current` on the selected fill. */
  current?: boolean;
  /** Recorded history replayed into this copy: the Recorded tag at the end of the status line. */
  recorded?: boolean;
}

/**
 * One conversation in a list: who it is with and when on the first line, its status as a dot and
 * words on the second, with the Recorded tag at its end when the conversation was replayed. The
 * whole row is one link to the conversation. Put each in a list item.
 */
export function ConversationListItem({ name, time, status, href, current = false, recorded = false }: ConversationListItemProps) {
  return (
    <a href={href} className="cd-conversation-item" aria-current={current || undefined}>
      <span className="cd-conversation-item__top">
        <span className="cd-conversation-item__name cd-type-control" data-copy="user">
          {name}
        </span>
        <span className="cd-conversation-item__time cd-type-caption">{time}</span>
      </span>
      <span className="cd-conversation-item__status cd-type-caption">
        <StatusDot tone={status.tone} />
        <span className="cd-conversation-item__status-text">{status.text}</span>
        {recorded ? <RecordedTag className="cd-conversation-item__recorded" /> : null}
      </span>
    </a>
  );
}
