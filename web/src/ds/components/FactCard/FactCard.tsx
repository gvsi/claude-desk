import { Icon, type IconName } from '../../icons/index.tsx';
import { Card } from '../Card/Card.tsx';
import type { CopyLanguage } from '../Notice/errorCopy.ts';

import './FactCard.css';

export interface FactCardProps {
  /** What kind of fact it is, on the top line: "Customer history", "Job card", "Your logged hours". */
  label: string;
  /** The 14 px line icon beside the label: `document` for a record, `clock` for a time. */
  icon: IconName;
  /** The fact itself, as its source wrote it: "Ana Ruiz, customer since 2023", "Friday, October 30, 10:30 am". */
  title: string;
  /** Any more lines of the fact, in order, each as its source wrote it. Empty lines are left out. */
  lines?: readonly string[];
  /** The fact's language, set as `lang` on the card: `en` (the default) or `es`. */
  language?: CopyLanguage;
}

/**
 * A typed card for one fact on a vision page: its label beside a small icon, then the fact and its
 * lines, each shown exactly as given. Prices, dates and statuses on a vision page sit here, never in
 * Claude's words; a booking is the kernel's booking card (`ReplyCard`). Nothing on the card is
 * computed or formatted. Only the vision pages use it (`fact_card_only_on_the_vision_pages`).
 */
export function FactCard({ label, icon, title, lines = [], language = 'en' }: FactCardProps) {
  const shown = lines.filter((line) => line.trim() !== '');
  return (
    <div className="cd-fact-card" lang={language}>
      <Card as="article" label={label} padding={0}>
        <div className="cd-fact-card__body">
          <p className="cd-fact-card__label cd-type-caption">
            <Icon name={icon} size={14} />
            <span>{label}</span>
          </p>
          <p className="cd-fact-card__title cd-type-body">{title}</p>
          {shown.map((line, index) => (
            <p key={index} className="cd-fact-card__line cd-type-meta">
              {line}
            </p>
          ))}
        </div>
      </Card>
    </div>
  );
}
