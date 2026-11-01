import { Icon } from '../../icons/index.tsx';
import { StatusDot, type StatusTone } from '../StatusDot/StatusDot.tsx';

import './MarginReceipt.css';

export interface MarginLineProps {
  /** `receipt` for a checkpoint result, `note` for an owner note that isn't one. */
  kind: 'receipt' | 'note';
  tone: StatusTone;
  /** The line, shown exactly as given; after `lead` when there is one, and may then be empty. */
  text: string;
  /** Words that lead the line in primary ink, such as a decision's state ("Stopped."). */
  lead?: string;
  /** Adds the sage check that draws once after the line. */
  check?: boolean;
  /** Makes the line a button that opens the full trace. */
  onOpen?: () => void;
  /** The line was on screen before its row arrived: under a row that lands, it shows at once. */
  shownBefore?: boolean;
  /**
   * The line lands on its own as it is drawn, outside a conversation's rows (which land their own
   * lines): it rises space-4 as it fades in on motion-base, its dot growing from half size.
   */
  lands?: boolean;
}

/**
 * One line attached under a message: a 6 px status dot and a secondary caption, led by `lead` in
 * primary ink when given. With `onOpen` (owner screens) it is a button named "{lead} {text} Open
 * the full trace."; without it, plain text. Shared by `MarginReceipt` and `MarginNote`.
 */
export function MarginLine({ kind, tone, text, lead, check = false, onOpen, shownBefore = false, lands = false }: MarginLineProps) {
  const className = `cd-margin-line cd-margin-${kind} cd-type-caption${shownBefore ? ' cd-margin-line--shown' : ''}${lands ? ' cd-margin-line--lands' : ''}`;
  const hasLead = lead !== undefined && lead !== '';
  const content = (
    <>
      <span className="cd-margin-line__dot">
        <StatusDot tone={tone} />
      </span>
      <span className="cd-margin-line__text">
        {hasLead ? <span className="cd-margin-line__lead">{lead}</span> : null}
        {hasLead && text !== '' ? ' ' : null}
        {text}
        {check ? <Icon name="check" size={14} className="cd-margin-line__check" /> : null}
        {onOpen === undefined ? null : <span className="cd-sr-only"> Open the full trace.</span>}
      </span>
    </>
  );

  if (onOpen === undefined) return <p className={className}>{content}</p>;
  return (
    <button type="button" className={`${className} cd-margin-line--button`} onClick={onOpen}>
      {content}
    </button>
  );
}
