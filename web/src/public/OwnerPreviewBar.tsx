import type { MouseEvent } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '../ds/index.ts';

import './OwnerPreviewBar.css';

/** The bar's words, as the owner signed them: the long line on a wide window, the short one on a phone. */
export const OWNER_PREVIEW_COPY = {
  label: 'Owner preview',
  line: 'Your public page, as customers see it',
  lineShort: 'Your public page',
  back: 'Back to your Desk',
} as const;

export interface OwnerPreviewBarProps {
  /** The Desk's Today (`useOwnerPreviewBack`). */
  backHref: string;
}

/**
 * The slim bar above the brand header on the owner's own preview of their public page: what the page
 * is, and a way back to the Desk. Only the Desk's owner gets it (`useOwnerPreviewBack`); a visitor
 * never does. A plain click goes back through the router, so the app stays loaded; a modified one
 * is left to the browser.
 */
export function OwnerPreviewBar({ backHref }: OwnerPreviewBarProps) {
  const navigate = useNavigate();
  const goBack = (event: MouseEvent<HTMLButtonElement | HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void navigate(backHref);
  };
  return (
    <div className="cd-owner-preview-bar" role="region" aria-label={OWNER_PREVIEW_COPY.label}>
      <p className="cd-owner-preview-bar__line cd-type-meta">
        <span className="cd-owner-preview-bar__long">{OWNER_PREVIEW_COPY.line}</span>
        <span className="cd-owner-preview-bar__short">{OWNER_PREVIEW_COPY.lineShort}</span>
      </p>
      <Button variant="ghost" href={backHref} onClick={goBack}>
        {OWNER_PREVIEW_COPY.back}
      </Button>
    </div>
  );
}
