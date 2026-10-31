import { Icon } from '../../icons/index.tsx';
import { Card } from '../Card/Card.tsx';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { CARD_CHROME } from './chrome.ts';

import './ReplyCard.css';

export interface LinkCancelledCardProps {
  /** The kernel's line for the cancelled link, its rendered `link_cancelled` block's `title`, shown as written. */
  line: string;
  /** The language of the card's label: the event's language, or the public page's `?lang=`. */
  language: CopyLanguage;
}

/**
 * The card for a payment link a confirmed rule change cancelled: a reply card with the payment
 * link's icon and "Payment link cancelled", then the kernel's one line. It has no link and no
 * button, since the link is gone, and no test-payment note, since no money moved.
 */
export function LinkCancelledCard({ line, language }: LinkCancelledCardProps) {
  const chrome = CARD_CHROME.link_cancelled[language] ?? CARD_CHROME.link_cancelled.en;
  return (
    <div className="cd-reply-card" lang={language}>
      <Card as="article" label={chrome.label} padding={16}>
        <p className="cd-reply-card__label cd-type-caption">
          <Icon name="card" size={16} />
          <span>{chrome.label}</span>
        </p>
        <div className="cd-reply-card__data">
          <p className="cd-reply-card__headline cd-type-section">{line}</p>
        </div>
      </Card>
    </div>
  );
}
