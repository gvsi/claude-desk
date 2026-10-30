import { useId, useLayoutEffect, useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';

import { Composer } from '../Composer/Composer.tsx';
import { keepTabInside } from '../Dialog/useModalDialog.ts';
import { IconButton } from '../IconButton/IconButton.tsx';
import { WritingIndicator } from '../WritingIndicator/WritingIndicator.tsx';

import './AskClaudePanel.css';

export interface AskClaudePanelProps {
  /** "Close" and Escape inside the panel. Beside the page, the screen returns focus to what opened it; as a phone's sheet, the panel does. */
  onClose: () => void;
  /** Called with the owner's trimmed words from the panel's composer. */
  onSend: (text: string) => void;
  /** Claude is writing: "Claude is writing" at the end of the conversation. */
  busy?: boolean;
  /** The conversation: the owner's words, Claude's serif replies and their cards, in order. */
  children: ReactNode;
}

/** Below this width the panel is a modal sheet over the whole window, as AskClaudePanel.css draws it. */
const NARROW = '(max-width: 639.98px)';

function subscribeNarrow(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function isNarrow(): boolean {
  return window.matchMedia(NARROW).matches;
}

/**
 * While `modal`, the panel is a modal sheet: everything outside it is inert, focus moves to its
 * composer (unless it is already inside), and when it stops being modal (it closes, or the window
 * widens) everything comes back and focus returns to what opened it, unless focus has moved on.
 */
function useModalSheet(panelRef: { current: HTMLElement | null }, modal: boolean): void {
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!modal || !panel) return undefined;
    const doc = panel.ownerDocument;
    const active = doc.activeElement;
    const opener = active instanceof HTMLElement && active !== doc.body && !panel.contains(active) ? active : null;

    // The rest of the page goes inert: every sibling of the panel and of each element around it.
    const inerted: HTMLElement[] = [];
    for (let node: HTMLElement = panel; node.parentElement && node !== doc.body; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling === node || !(sibling instanceof HTMLElement) || sibling.inert) continue;
        sibling.inert = true;
        inerted.push(sibling);
      }
    }
    if (!panel.contains(doc.activeElement)) panel.querySelector<HTMLElement>('.cd-ask-claude__composer textarea')?.focus();

    return () => {
      for (const el of inerted) el.inert = false;
      const now = doc.activeElement;
      const focusInside = now === null || now === doc.body || panel.contains(now);
      if (focusInside && opener?.isConnected) opener.focus();
    };
  }, [panelRef, modal]);
}

/**
 * The owner's conversation with Claude about rules and connectors: a header with "Close", the
 * conversation in a polite log, and a composer at the bottom. Beside the page it is a complementary
 * panel; under 640 px it is a modal sheet over the whole window. Nothing changes from here: Claude's
 * cards lead into the same reviews as the page.
 */
export function AskClaudePanel({ onClose, onSend, busy = false, children }: AskClaudePanelProps) {
  const headingId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const modal = useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
  useModalSheet(panelRef, modal);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (modal && event.key === 'Tab') {
      keepTabInside(event, event.currentTarget);
      return;
    }
    // A menu or dialog inside the panel handles its own Escape first.
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };

  // One element at every width, so crossing the breakpoint keeps the composer's draft; only its
  // role changes, from a complementary panel to a modal dialog.
  return (
    <div
      ref={panelRef}
      role={modal ? 'dialog' : 'complementary'}
      aria-modal={modal ? 'true' : undefined}
      aria-labelledby={headingId}
      className={`cd-ask-claude${modal ? ' cd-ask-claude--sheet' : ''}`}
      onKeyDown={onKeyDown}
    >
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
    </div>
  );
}
