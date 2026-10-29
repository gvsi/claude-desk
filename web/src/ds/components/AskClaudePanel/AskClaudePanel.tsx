import { useId, type KeyboardEvent, type ReactNode } from 'react';

import { Composer } from '../Composer/Composer.tsx';
import { IconButton } from '../IconButton/IconButton.tsx';
import { WritingIndicator } from '../WritingIndicator/WritingIndicator.tsx';

import './AskClaudePanel.css';

export interface AskClaudePanelProps {
  /** "Close" and Escape inside the panel; the screen returns focus to what opened it. */
  onClose: () => void;
  /** Called with the owner's trimmed words from the panel's composer. */
  onSend: (text: string) => void;
  /** Claude is writing: "Claude is writing" at the end of the conversation. */
  busy?: boolean;
  /** The conversation: the owner's words, Claude's serif replies and their cards, in order. */
  children: ReactNode;
}

/**
 * The owner's conversation with Claude about rules and connectors, in a panel beside the page: a
 * header with "Close", the conversation in a polite log, and a composer at the bottom. Nothing
 * changes from here: Claude's cards lead into the same reviews as the page.
 */
export function AskClaudePanel({ onClose, onSend, busy = false, children }: AskClaudePanelProps) {
  const headingId = useId();
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // A menu or dialog inside the panel handles its own Escape first.
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };
  return (
    <aside className="cd-ask-claude" aria-labelledby={headingId} onKeyDown={onKeyDown}>
      <div className="cd-ask-claude__header">
        <h2 id={headingId} className="cd-ask-claude__title cd-type-section">
          Ask Claude
        </h2>
        <IconButton label="Close" icon="close" onClick={() => onClose()} />
      </div>
      <div className="cd-ask-claude__log" role="log" aria-live="polite" aria-label="Conversation">
        {children}
        {busy ? <WritingIndicator language="en" /> : null}
      </div>
      <div className="cd-ask-claude__composer">
        <Composer variant="owner" label="Ask Claude" placeholder="Ask Claude" onSend={onSend} />
      </div>
    </aside>
  );
}
