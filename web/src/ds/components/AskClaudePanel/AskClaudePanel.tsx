import {
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { AppShellPanelContext } from '../AppShell/AppShell.tsx';
import { Composer } from '../Composer/Composer.tsx';
import { keepTabInside } from '../Dialog/useModalDialog.ts';
import { IconButton } from '../IconButton/IconButton.tsx';
import { WritingIndicator } from '../WritingIndicator/WritingIndicator.tsx';
import { clickedControl } from './clickedControl.ts';

import './AskClaudePanel.css';

export interface AskClaudePanelProps {
  /** "Close" and Escape inside the panel. Beside the page, the screen returns focus to what opened it; as a sheet, the panel and the shell do. */
  onClose: () => void;
  /** Called with the owner's trimmed words from the panel's composer. */
  onSend: (text: string) => void;
  /**
   * Claude is writing: "Claude is writing" at the end of the conversation. The composer still takes
   * typing and keeps its focus, but Send and Enter wait until the answer has come in.
   */
  busy?: boolean;
  /** The conversation: the owner's words, Claude's serif replies and their cards, in order. */
  children: ReactNode;
}

/** The composer's example, in the empty box: a question about what the Desk does, not a rule change. */
export const ASK_CLAUDE_PLACEHOLDER = 'What happens if someone asks for a discount?';

/**
 * Below this width the panel is a modal sheet, as AskClaudePanel.css draws it (docked at the right
 * over the scrim, or the whole window on a phone): beside the sidebar's column (264 px) and the
 * panel (400 px), the page would have under 360 px.
 */
const NARROW = '(max-width: 1023.98px)';

function subscribeNarrow(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function isNarrow(): boolean {
  return window.matchMedia(NARROW).matches;
}

/**
 * Whether Ask Claude is a modal sheet over the page at this window's width, rather than a panel
 * beside it, kept up to date as the width crosses its breakpoint. A page uses it to wait for the
 * sheet to close before showing something the sheet would cover.
 */
export function useAskClaudeIsSheet(): boolean {
  return useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
}

/**
 * While `modal`, the panel is a modal sheet. In `AppShell`'s `panel`, it asks the shell to make
 * everything else inert; on entering, focus moves to its composer unless it is already inside.
 * Whatever else happens, focus stays inside: a focus that lands outside it, by Tab or by a script,
 * is pulled back to the last control inside it, so it holds with or without a shell. When the
 * panel is removed with focus inside it, focus returns to what opened it: the shell does that once
 * the page is live again. Widening to 1024 px with the panel still open lifts the inert page and
 * leaves focus where it is.
 */
function useModalSheet(panelRef: { current: HTMLElement | null }, modal: boolean): void {
  const setPageModal = useContext(AppShellPanelContext);
  // What opened the panel: what had focus, outside it, when it appeared, or else the control the
  // click that opened it landed on. Safari focuses no button a click presses, so after a click focus
  // is still on the page's body.
  const opener = useRef<HTMLElement | null>(null);
  const removing = useRef(false);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const doc = panel?.ownerDocument;
    const outside = (element: Element | null | undefined): element is HTMLElement =>
      element instanceof HTMLElement && element !== doc?.body && !panel?.contains(element);
    const active = doc?.activeElement;
    const clicked = clickedControl();
    opener.current = outside(active) ? active : outside(clicked) ? clicked : null;
    removing.current = false;
    return () => {
      removing.current = true;
    };
  }, [panelRef]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!modal || !panel) return undefined;
    const doc = panel.ownerDocument;
    const composer = () => panel.querySelector<HTMLElement>('.cd-ask-claude__composer textarea');

    // Focus stays inside: anything that takes focus outside hands it back to the last control
    // inside, or to the composer.
    let last: HTMLElement | null = panel.contains(doc.activeElement) ? (doc.activeElement as HTMLElement) : null;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && panel.contains(target)) {
        last = target;
        return;
      }
      (last?.isConnected && panel.contains(last) ? last : composer())?.focus();
    };
    doc.addEventListener('focusin', onFocusIn);

    const entering = panel.contains(doc.activeElement) ? null : composer();
    if (setPageModal) setPageModal(true, entering);
    else entering?.focus();
    return () => {
      doc.removeEventListener('focusin', onFocusIn);
      if (!removing.current) {
        setPageModal?.(false);
        return;
      }
      const active = panel.ownerDocument.activeElement;
      const focusInside = active === null || active === panel.ownerDocument.body || panel.contains(active);
      const returnTo = focusInside ? opener.current : null;
      if (setPageModal) setPageModal(false, returnTo);
      else if (returnTo?.isConnected) returnTo.focus();
    };
  }, [panelRef, modal, setPageModal]);
}

/**
 * The owner's conversation with Claude about rules and connectors: a header with "Close", the
 * conversation in a polite log, and a composer at the bottom. Beside the page it is a complementary
 * panel; under 1024 px, where the page beside it would be under 360 px wide, it is a modal sheet,
 * docked at the window's right edge over the scrim, or over the whole window under 640 px. Render it
 * as `AppShell`'s `panel`, so the shell can make the rest of the app inert while it is a sheet.
 * Nothing changes from here: Claude's cards lead into the same reviews as the page.
 */
export function AskClaudePanel({ onClose, onSend, busy = false, children }: AskClaudePanelProps) {
  const headingId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const modal = useAskClaudeIsSheet();
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

  // A press on the sheet itself, outside its content (the scrim, which is the sheet's own backdrop,
  // or its padding), changes nothing: the sheet stays open, keeping a half-written question, and
  // focus stays on the control that had it.
  const onMouseDown = (event: MouseEvent<HTMLElement>) => {
    if (modal && event.target === event.currentTarget) event.preventDefault();
  };

  // One element at every width, so crossing the breakpoint keeps the composer's draft; only its
  // role changes, from a complementary panel to a modal dialog.
  return (
    <div
      ref={panelRef}
      role={modal ? 'dialog' : 'complementary'}
      aria-modal={modal ? 'true' : undefined}
      aria-labelledby={headingId}
      // As a sheet it can take focus itself, so a press on text inside it (the heading, the
      // conversation) lands on it rather than on the page, and Escape and Tab still reach it.
      tabIndex={modal ? -1 : undefined}
      className={`cd-ask-claude${modal ? ' cd-ask-claude--sheet' : ''}`}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
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
        <Composer variant="owner" label="Ask Claude" placeholder={ASK_CLAUDE_PLACEHOLDER} sendHeld={busy} onSend={onSend} />
      </div>
    </div>
  );
}
