import type { ReactNode } from 'react';

import { Button } from '../Button/Button.tsx';

import './ReviewerBar.css';

/** The demo seed's `owner_display_name`, the owner a reviewer plays unless told otherwise. */
export const SEED_OWNER_NAME = 'Mike Turner';

/**
 * Shared words for the visible bar and its loading shapes' measurement. With no owner's name (null),
 * the bar says "the owner" in its place (owner, 2026-11-02).
 */
export function reviewerBarWords(ownerName: string | null) {
  return {
    beforeName: "You're ",
    ownerName,
    noOwner: 'the owner',
    afterName: ' today. ',
    disclosure: 'This is a concept prototype.',
    startOver: 'Start over',
  };
}

export interface ReviewerBarProps {
  /**
   * `owner_display_name`, the owner a reviewer plays in the demo: "Mike Turner"; null when the owner
   * gave no name, and the bar says "the owner".
   */
  ownerName: string | null;
  /** Asks for a fresh copy of the demo; the screen confirms first. */
  onStartOver: () => void;
  /**
   * The screen's own controls, just before Start over and in its style: the owner app's Demo inbox.
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
        {words.beforeName}
        {words.ownerName === null ? words.noOwner : <span data-copy="user">{words.ownerName}</span>}
        {words.afterName}
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
