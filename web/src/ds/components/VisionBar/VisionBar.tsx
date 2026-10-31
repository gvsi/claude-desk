import { Pill } from '../Pill/Pill.tsx';
import { TextLink } from '../TextLink/TextLink.tsx';

import './VisionBar.css';

/** The bar's line, word for word, as every vision board writes it. */
export const VISION_LINE = 'Vision, not in the prototype. Nothing here is live.';

export interface VisionBarProps {
  /** Where "Back to your Desk" goes: the owner's Today on the Desk they came from. */
  backHref: string;
}

/**
 * The bar across the top of every vision page: the "Vision" pill, one line saying none of it is in
 * the prototype or live, and a way back to the owner's own Desk. It can't be hidden: a vision page
 * always says what it is.
 */
export function VisionBar({ backHref }: VisionBarProps) {
  return (
    <div className="cd-vision-bar cd-type-meta" role="note" aria-label="Vision">
      <Pill>Vision</Pill>
      <p className="cd-vision-bar__line">{VISION_LINE}</p>
      <span className="cd-vision-bar__back">
        <TextLink href={backHref}>Back to your Desk</TextLink>
      </span>
    </div>
  );
}
