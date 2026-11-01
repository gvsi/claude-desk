import { useId, type ReactNode } from 'react';

import { tokenHex } from '../../contrast.ts';
import { Button } from '../Button/Button.tsx';
import type { CopyLanguage } from '../Notice/errorCopy.ts';

import './ShareCard.css';

/** Who answers at the link, on every printed card: the AI disclosure, which can't be left off. */
const ANSWERED_BY = {
  en: (owner: ReactNode) => <>Answered by Claude, an AI. Ask for {owner} any time.</>,
  es: (owner: ReactNode) => <>Responde Claude, una IA. Puedes pedir hablar con {owner} cuando quieras.</>,
} as const satisfies Record<CopyLanguage, (owner: ReactNode) => ReactNode>;

/**
 * The colors the screen's QR code draws in on the card's sand tile: `qr-ink` modules on `qr-tile`,
 * the tile's own sand, as the code's light quiet zone. The code reads no CSS, so they are given as
 * hex values.
 */
export const SHARE_CARD_QR_COLORS: Readonly<{ dark: string; light: string }> = Object.freeze({ dark: tokenHex('qr-ink'), light: tokenHex('qr-tile') });

export interface ShareCardProps {
  /** The business's name (`business_name`). */
  name: string;
  /** The Desk's public link as people type it: "desk.example/rivera". */
  url: string;
  /** The owner's display name (`owner_display_name`), whom a customer can ask for. */
  ownerName: string;
  /** The card's language: who answers, and `lang` on the card. */
  language: CopyLanguage;
  /** The QR code for `url`, which the web app draws in `SHARE_CARD_QR_COLORS`. It fills the 128 px inside the card's 152 px sand tile. */
  qr: ReactNode;
  /** Prints the card. Without it, no Print card button. */
  onPrint?: () => void;
}

/**
 * The card an owner prints and puts where customers already look: the business, the QR code for its
 * Desk's link, the link written out, and who answers there, "Answered by Claude, an AI", in the
 * card's language. The QR code is the screen's; nothing here makes one, fetches or prints.
 */
export function ShareCard({ name, url, ownerName, language, qr, onPrint }: ShareCardProps) {
  const answeredBy = ANSWERED_BY[language] ?? ANSWERED_BY.en;
  const nameId = useId();
  // The card is named by the business's name as it is shown, marked as theirs, rather than by a
  // label of its own that would read the name as the card's words.
  return (
    <div className="cd-share-card">
      <figure className="cd-share-card__card" aria-labelledby={nameId} lang={language}>
        <p id={nameId} className="cd-share-card__name cd-type-section" data-copy="user">
          {name}
        </p>
        <div className="cd-share-card__qr">{qr}</div>
        <p className="cd-share-card__url cd-type-control" data-copy="user">
          {url}
        </p>
        <figcaption className="cd-share-card__answered cd-type-meta">
          {answeredBy(<bdi data-copy="user">{ownerName}</bdi>)}
        </figcaption>
      </figure>
      {onPrint === undefined ? null : (
        <div className="cd-share-card__print">
          <Button variant="secondary" size="main" onClick={onPrint}>
            Print card
          </Button>
        </div>
      )}
    </div>
  );
}
