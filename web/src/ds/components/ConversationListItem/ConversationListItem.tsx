import { RecordedTag } from '../RecordedTag/RecordedTag.tsx';
import { StatusDot, type StatusTone } from '../StatusDot/StatusDot.tsx';

import './ConversationListItem.css';

export interface ConversationListItemProps {
  /** Who the conversation is with, as the owner's screen names them: "Dana Whitfield", "Visitor". */
  name: string;
  /** When it started or last moved, as the screen writes it: "12:04 pm". */
  time: string;
  /**
   * The conversation's state: a tone for the dot and the words that say the same, "Needs you".
   * Left out when the name already says all there is ("Visitor"), so the row doesn't say it twice.
   */
  status?: { tone: StatusTone; text: string };
  /** The conversation's page. */
  href: string;
  /** The conversation open beside the list: marked `aria-current` on the selected fill. */
  current?: boolean;
  /** Recorded history replayed into this copy: the Recorded tag at the end of the status line. */
  recorded?: boolean;
  /**
   * What the person last wrote, in their own words (untrusted, shown as text): quoted on the second
   * line when the row has no status line. A status or the Recorded tag keeps that line, and the
   * quote doesn't show.
   */
  quote?: string;
}

/**
 * One conversation in a list: who it is with and when on the first line, its status as a dot and
 * words on the second, with the Recorded tag at its end when the conversation was replayed. With
 * no status and no tag, the second line quotes what the person last wrote, when the consumer gives
 * it, or there is none. The whole row is one link to the conversation. Put each in a list item.
 */
export function ConversationListItem({ name, time, status, href, current = false, recorded = false, quote }: ConversationListItemProps) {
  const statusLine = status !== undefined || recorded;
  const quoted = !statusLine && quote !== undefined && quote.trim() !== '';
  return (
    <a href={href} className="cd-conversation-item" aria-current={current || undefined}>
      <span className="cd-conversation-item__top">
        <span className="cd-conversation-item__name cd-type-control" data-copy="user">
          {name}
        </span>
        <span className="cd-conversation-item__time cd-type-caption">{time}</span>
      </span>
      {statusLine ? (
        <span className="cd-conversation-item__status cd-type-caption">
          {status !== undefined ? (
            <>
              <StatusDot tone={status.tone} />
              <span className="cd-conversation-item__status-text">{status.text}</span>
            </>
          ) : null}
          {recorded ? <RecordedTag className="cd-conversation-item__recorded" /> : null}
        </span>
      ) : null}
      {quoted ? (
        <span className="cd-conversation-item__quote cd-type-meta" data-copy="user">
          {`“${quote}”`}
        </span>
      ) : null}
    </a>
  );
}
