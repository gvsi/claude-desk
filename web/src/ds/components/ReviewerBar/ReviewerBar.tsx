import { Button } from '../Button/Button.tsx';

import './ReviewerBar.css';

export interface ReviewerBarProps {
  /** `owner_display_name`, the owner a reviewer plays in the demo: "Maria Rivera". */
  ownerName: string;
  /** Asks for a fresh copy of the demo; the screen confirms first. */
  onStartOver: () => void;
}

/**
 * One quiet line above the owner app in the demo: who the reviewer is playing, that this is a
 * concept prototype, and a way to start over with a fresh copy.
 */
export function ReviewerBar({ ownerName, onStartOver }: ReviewerBarProps) {
  return (
    <div className="cd-reviewer-bar cd-type-meta" role="note">
      <p className="cd-reviewer-bar__text">
        You&apos;re <span data-copy="user">{ownerName}</span> today.{' '}
        <span className="cd-reviewer-bar__quiet">This is a concept prototype.</span>
      </p>
      <Button variant="ghost" onClick={onStartOver}>
        Start over
      </Button>
    </div>
  );
}
