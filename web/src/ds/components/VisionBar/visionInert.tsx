import { forwardRef } from 'react';

import './visionInert.css';

/**
 * What an inert control on a vision page says on its first press: the composer's Send, a held
 * request's answers, a document card's Download, a suggestion and "Ask for {owner}". English only,
 * as the vision pages are.
 */
export const VISION_INERT_LINE = 'This is a vision page, so nothing is sent.';

export interface VisionInertLineProps {
  /** The control was pressed: the line shows from then on. */
  shown: boolean;
}

/**
 * The polite live region under an inert control on a vision page: there from the start, so its
 * change is announced, taking no room while empty, and filled with `VISION_INERT_LINE` on the
 * control's first press. Later presses change nothing, so nothing more is announced. Its ref is the
 * line, for a control that has to bring it into view.
 */
export const VisionInertLine = forwardRef<HTMLParagraphElement, VisionInertLineProps>(function VisionInertLine({ shown }, ref) {
  return (
    <p ref={ref} role="status" className="cd-vision-inert-line cd-type-caption">
      {shown ? VISION_INERT_LINE : null}
    </p>
  );
});
