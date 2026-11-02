import { Pill } from '../Pill/Pill.tsx';
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
  /** Visitor or visiting agent messages the owner hasn't seen yet. */
  unread?: boolean;
  /** Recorded history replayed into this copy: the Recorded tag at the end of the status line. */
  recorded?: boolean;
  /**
   * A demo visitor's chat, an AI the owner started to play a customer: a "Demo visitor" pill right
   * after the name on the first line, so the row is never taken for a real customer's.
   */
  demoVisitor?: boolean;
  /**
   * What the person last wrote, in their own words (untrusted, shown as text): quoted on the second
   * line, above any status line or Recorded tag.
   */
  quote?: string;
  /**
   * The app's own line in the quote's place, without quotes: what an agent did, "Paid $20 up
   * front.". The quote wins when both are given.
   */
  line?: string;
  /** Live now keeps its two-line layout: a status or Recorded tag takes the quote's place. */
  quoteWithStatus?: boolean;
}

/**
 * One conversation in a list: who it is with and when on the first line, with a demo visitor's pill
 * right after the name, its status as a dot and words below its optional preview (a visitor's quote,
 * or the app's line for an agent), with the Recorded tag at the status line's end when the
 * conversation was replayed. The whole row is one link to the conversation. Put each in a list item.
 */
export function ConversationListItem({
  name,
  time,
  status,
  href,
  current = false,
  unread = false,
  recorded = false,
  demoVisitor = false,
  quote,
  line,
  quoteWithStatus = true,
}: ConversationListItemProps) {
  const statusLine = status !== undefined || recorded;
  const previewed = quoteWithStatus || !statusLine;
  const quoted = previewed && quote !== undefined && quote.trim() !== '';
  const lined = previewed && !quoted && line !== undefined && line.trim() !== '';
  return (
    <a href={href} className={`cd-conversation-item${unread ? ' cd-conversation-item--unread' : ''}`} aria-current={current || undefined}>
      {unread ? <><span className="cd-conversation-item__unread-dot" aria-hidden="true" /><span className="cd-sr-only">Unread: </span></> : null}
      <span className="cd-conversation-item__top">
        <span className={demoVisitor ? 'cd-conversation-item__name cd-conversation-item__name--tagged cd-type-control' : 'cd-conversation-item__name cd-type-control'} data-copy="user">
          {name}
        </span>
        {demoVisitor ? <Pill>Demo visitor</Pill> : null}
        <span className="cd-conversation-item__time cd-type-caption">{time}</span>
      </span>
      {quoted ? (
        <span className="cd-conversation-item__quote cd-type-meta" data-copy="user">
          {`“${quote}”`}
        </span>
      ) : lined ? (
        <span className="cd-conversation-item__quote cd-type-meta">{line}</span>
      ) : null}
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
    </a>
  );
}
