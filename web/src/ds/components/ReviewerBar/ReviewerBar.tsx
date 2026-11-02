import type { ReactNode } from 'react';

import { Button } from '../Button/Button.tsx';

import './ReviewerBar.css';

/** The demo seed's `owner_display_name`, the owner a reviewer plays unless told otherwise. */
export const SEED_OWNER_NAME = 'Mike Turner';

/** Shared words for the visible bar and its loading shapes' measurement. */
export function reviewerBarWords(ownerName: string) {
  return { beforeName: "You're ", ownerName, afterName: ' today. ', disclosure: 'This is a concept prototype.', startOver: 'Reset demo' };
}

export interface ReviewerBarProps {
  /** `owner_display_name`, the owner a reviewer plays in the demo: "Mike Turner". */
  ownerName: string;
  /** Asks for a fresh copy of the demo; the screen confirms first. */
  onStartOver: () => void;
  /**
   * The screen's own controls, just before Reset demo and in its style, as TOD-04 drew the Demo inbox.
   * With them, on a phone the words take the first line and the controls the next.
   */
  actions?: ReactNode;
}

/**
 * One quiet line above the owner app in the demo: who the reviewer is playing, that this is a
 * concept prototype, the screen's own controls and a way to start over with a fresh copy.
 */
export function ReviewerBar({ ownerName, onStartOver, actions }: ReviewerBarProps) {
  const words = reviewerBarWords(ownerName);
  return (
    <div className={`cd-reviewer-bar cd-type-meta${actions ? ' cd-reviewer-bar--with-actions' : ''}`} role="note">
      <p className="cd-reviewer-bar__text">
        {words.beforeName}<span data-copy="user">{words.ownerName}</span>{words.afterName}
        <span className="cd-reviewer-bar__quiet">{words.disclosure}</span>
      </p>
      <div className="cd-reviewer-bar__actions">
        {actions}
        <Button variant="ghost" onClick={onStartOver}>
          {words.startOver}
        </Button>
      </div>
    </div>
  );
}
