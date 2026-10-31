import type { CardBlock, ClauseTemplate } from '../../../api/contracts.ts';
import { Icon, type IconName } from '../../icons/index.tsx';
import { Button } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { cardView } from './cardView.ts';
import { cardChrome, withOwner } from './chrome.ts';

import './ReplyCard.css';

/** Each template's 16 px icon on the top line; `outcome` is the sage check that draws once. */
const TEMPLATE_ICONS = {
  quote: 'document',
  booking_options: 'calendar',
  booking_confirmed: 'outcome',
  payment_link: 'card',
  document_link: 'document',
  hours: 'clock',
  policy: 'rules',
  contact: 'conversations',
  handoff: 'person',
  verify_prompt: 'lock',
  owner_said: 'person',
  charges: 'card',
  refund_issued: 'card',
  charge_confirmed: 'card',
  callback_confirmed: 'calendar',
  payment_confirmed: 'outcome',
} as const satisfies Record<ClauseTemplate, IconName | 'outcome'>;

/**
 * Templates whose card data is the owner's own words, which the kernel renders verbatim. They are
 * marked as user text, so the voice rules for interface copy don't apply to them.
 */
const OWNER_WORDS: ReadonlySet<string> = new Set<ClauseTemplate>(['owner_said', 'policy', 'contact']);

export interface ReplyCardProps {
  /** The kernel's rendered card block, shown exactly as it arrives. */
  block: CardBlock;
  /** The language of the card's chrome: the event's language, or the public page's `?lang=`. */
  language: CopyLanguage;
  /** The owner's display name (`owner_display_name`), for the "{owner} said" label. */
  ownerName: string;
  /**
   * Vision pages only, which make no requests: a document card draws its Download as a plain
   * `<button type="button">` with no destination, whatever `href` the block carries, and draws it
   * even without one. Never on a real card, whose Download comes only from the kernel's `/api/d/` path.
   */
  inertDownload?: boolean;
}

/**
 * A typed reply card: the kernel's checked fields under a fixed label in the visitor's language.
 * Nothing on it is computed. A template this build doesn't know shows its text in a plain card.
 */
export function ReplyCard({ block, language, ownerName, inertDownload = false }: ReplyCardProps) {
  const { headline, details, options, href } = cardView(block);
  const chrome = cardChrome(block.template, language);
  const label = chrome === null ? undefined : withOwner(chrome.label, ownerName);
  // The kernel writes each open time as a line (for the block's plain text) and as an option; the
  // card lists it once.
  const optionLabels = new Set(options.map((option) => option.label));
  const shownDetails = details.filter((line) => !optionLabels.has(line));
  // cardView keeps an href only on payment and document cards, whose chrome names the button.
  const action = href !== null ? chrome?.action : undefined;
  // A vision page's document card: the same Download, going nowhere.
  const inertAction = inertDownload && block.template === 'document_link' ? chrome?.action : undefined;

  return (
    <div className="cd-reply-card" lang={language}>
      <Card as={label === undefined ? 'div' : 'article'} label={label} padding={16}>
        {label === undefined ? null : (
          <p className="cd-reply-card__label cd-type-caption">
            <TemplateIcon template={block.template} />
            <span>{label}</span>
          </p>
        )}
        <div className="cd-reply-card__data" data-copy={OWNER_WORDS.has(block.template) ? 'user' : undefined}>
          {headline === null ? null : <p className="cd-reply-card__headline cd-type-section">{headline}</p>}
          {shownDetails.map((line, index) => (
            <p key={index} className="cd-reply-card__detail cd-type-meta">
              {line}
            </p>
          ))}
          {options.length === 0 ? null : (
            <ul role="list" className="cd-reply-card__options cd-type-body">
              {options.map((option, index) => (
                <li key={index}>{option.label}</li>
              ))}
            </ul>
          )}
        </div>
        {chrome?.note === undefined ? null : <p className="cd-reply-card__note cd-type-caption">{chrome.note}</p>}
        {inertAction !== undefined ? (
          <div className="cd-reply-card__action">
            <Button variant="primary">{inertAction}</Button>
          </div>
        ) : href === null || action === undefined ? null : (
          <div className="cd-reply-card__action">
            <Button variant={block.template === 'document_link' ? 'primary' : 'secondary'} href={href}>
              {action}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function TemplateIcon({ template }: { template: ClauseTemplate }) {
  const icon = TEMPLATE_ICONS[template];
  if (icon === 'outcome') return <Icon name="check" size={16} className="cd-reply-card__check" />;
  return <Icon name={icon} size={16} />;
}
