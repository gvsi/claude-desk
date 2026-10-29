import type { ReactNode } from 'react';

import './EmptyState.css';

export interface EmptyStateProps {
  /** What isn't here yet: "No conversations yet". */
  title: ReactNode;
  /** What will appear, and when or how: "When someone writes to your Desk, it shows up here." */
  body: ReactNode;
  /** The next step, when there is one: a `Button` or a `TextLink`. */
  action?: ReactNode;
}

/** The space where a list will be: what will appear there, and what to do next. */
export function EmptyState({ title, body, action }: EmptyStateProps) {
  return (
    <div className="cd-empty-state">
      <p className="cd-empty-state__title cd-type-section">{title}</p>
      <p className="cd-empty-state__body cd-type-meta">{body}</p>
      {action ? <div className="cd-empty-state__action">{action}</div> : null}
    </div>
  );
}
