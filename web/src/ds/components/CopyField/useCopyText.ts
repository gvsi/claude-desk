import { useCallback, useEffect, useRef, useState } from 'react';

import type { CopyLanguage } from '../Notice/errorCopy.ts';

/** What a copy control says after a press: nothing yet, that it copied, or that it couldn't. */
export type CopyState = 'idle' | 'copied' | 'failed';

/** What a copy control copies, which its failure line names: a link (the Desk's public link) or any other text. */
export type CopyWhat = 'link' | 'text';

/** How long a successful copy confirmation stays, shared with Today's link pill. */
export const COPIED_FOR_MS = 1_600;

// Copy controls share a clipboard, so a new success clears the previous control's confirmation.
let clearLastCopy: (() => void) | undefined;

/**
 * The lines a copy control shows after a press, in the two languages a visitor reads. A failed copy
 * says what is selected, as N-R2-Setup-15-Copy-Failed writes it for the link.
 */
export const COPY_RESULT_COPY = {
  en: {
    copied: 'Copied.',
    failed: {
      link: 'Copy didn’t work. The link is selected, so copy it yourself.',
      text: 'Copy didn’t work. The text is selected, so copy it yourself.',
    },
  },
  es: {
    copied: 'Copiado.',
    failed: {
      link: 'No se pudo copiar. El enlace está seleccionado para que lo copies tú.',
      text: 'No se pudo copiar. El texto está seleccionado para que lo copies tú.',
    },
  },
} as const satisfies Record<CopyLanguage, { copied: string; failed: Record<CopyWhat, string> }>;

/**
 * The line a copy control shows for `state`: no words before a press, so it takes no room; then
 * "Copied." or the failure line for `what` (`'text'` by default), in `language` (`'en'` by default).
 * The failure line says the link or the text "is selected": use it with `useCopyText` and a target.
 */
export function copyResultLine(state: CopyState, { language = 'en', what = 'text' }: { language?: CopyLanguage; what?: CopyWhat } = {}): string {
  if (state === 'idle') return '';
  const words = COPY_RESULT_COPY[language];
  return state === 'copied' ? words.copied : words.failed[what];
}

/**
 * Selects all of `el`'s text, so a person can copy it with the keyboard or the menu: a field's
 * value inside the field (an input or a text area), or any other element's text through the
 * document's selection.
 */
export function selectText(el: HTMLElement): void {
  const view = el.ownerDocument.defaultView;
  if (view && (el instanceof view.HTMLInputElement || el instanceof view.HTMLTextAreaElement)) {
    el.select();
    return;
  }
  const selection = view?.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.selectAllChildren(el);
}

/**
 * Copies through the screen's callback, which owns the clipboard, and remembers how it went. When
 * the callback fails (it throws or rejects), the text in `target` is selected instead (a field's
 * value, or an element's text), so it can still be copied by hand. Pass the target: the failure
 * line says the link or the text "is selected", which is only true when there is one.
 * Success clears the previous control's confirmation and expires after COPIED_FOR_MS. Key the
 * live region's contents by `announcement` so repeating a copy announces its result again.
 */
export function useCopyText(onCopy: (value: string) => Promise<void> | void): {
  state: CopyState;
  announcement: number;
  copy: (value: string, target: HTMLElement | null) => Promise<void>;
} {
  const [result, setResult] = useState({ state: 'idle' as CopyState, announcement: 0 });
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const mounted = useRef(true);
  const clear = useCallback(function clear() {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (clearLastCopy === clear) clearLastCopy = undefined;
    setResult((now) => now.state === 'copied' ? { ...now, state: 'idle' } : now);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      if (clearLastCopy === clear) clearLastCopy = undefined;
    };
  }, [clear]);
  const copy = async (value: string, target: HTMLElement | null) => {
    try {
      await onCopy(value);
      if (!mounted.current) return;
      clearLastCopy?.();
      clearLastCopy = clear;
      setResult((now) => ({ state: 'copied', announcement: now.announcement + 1 }));
      timer.current = setTimeout(clear, COPIED_FOR_MS);
    } catch {
      if (!mounted.current) return;
      clear();
      if (target) selectText(target);
      setResult((now) => ({ state: 'failed', announcement: now.announcement + 1 }));
    }
  };
  return { ...result, copy };
}
