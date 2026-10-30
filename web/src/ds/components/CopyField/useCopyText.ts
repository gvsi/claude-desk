import { useState } from 'react';

import type { CopyLanguage } from '../Notice/errorCopy.ts';

/** What a copy control says after a press: nothing yet, that it copied, or that it couldn't. */
export type CopyState = 'idle' | 'copied' | 'failed';

/** The lines a copy control shows after a press, in the two languages a visitor reads. */
export const COPY_RESULT_COPY = {
  en: { copied: 'Copied.', failed: 'Couldn’t copy. The text is selected, so you can copy it yourself.' },
  es: { copied: 'Copiado.', failed: 'No se pudo copiar. El texto está seleccionado para que lo copies tú.' },
} as const satisfies Record<CopyLanguage, Record<Exclude<CopyState, 'idle'>, string>>;

/** Selects all of `el`'s text, so a person can copy it with the keyboard or the menu. */
function selectText(el: HTMLElement): void {
  const selection = el.ownerDocument.defaultView?.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.selectAllChildren(el);
}

/**
 * Copies through the screen's callback, which owns the clipboard, and remembers how it went. When
 * the callback fails (it throws or rejects), the text in `target` is selected instead, so it can
 * still be copied by hand.
 */
export function useCopyText(onCopy: (value: string) => Promise<void> | void): {
  state: CopyState;
  copy: (value: string, target: HTMLElement | null) => Promise<void>;
} {
  const [state, setState] = useState<CopyState>('idle');
  const copy = async (value: string, target: HTMLElement | null) => {
    try {
      await onCopy(value);
      setState('copied');
    } catch {
      if (target) selectText(target);
      setState('failed');
    }
  };
  return { state, copy };
}
