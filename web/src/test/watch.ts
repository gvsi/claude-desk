/**
 * Watchers a screen test starts before an action, to tell afterwards what the page drew on the way,
 * even for a moment: each stops when the test ends.
 */
import { onTestFinished } from 'vitest';

import { rivera } from '../ds/fixtures/index.ts';

/**
 * Every page the browser draws from now until the test ends, in order, a page drawn many times in a
 * row named once: the preview behind the intro dialog, the owner's loading page or its error, and
 * Today, which is named for what it lacks until it holds Rivera's held request and its briefing.
 */
export function watchPages(): () => string[] {
  const held = `article[aria-label="Held for you: ${rivera.decisions.held.reason_plain}"]`;
  const seen: string[] = [];
  const pageNow = (): string | null => {
    const state = document.querySelector('.cd-owner-state');
    const preview = document.querySelector('.cd-today-preview') !== null;
    if (state !== null) return state.querySelector('[role="alert"]') === null ? 'loading' : 'error';
    if (!preview && document.querySelector('.cd-today') !== null) {
      if (document.querySelector(held) === null) return 'today without its held request';
      if (document.querySelector('.cd-today__loading') !== null) return 'today still reading its briefing';
      return 'today';
    }
    return preview ? 'preview' : null;
  };
  const look = () => {
    const page = pageNow();
    if (page !== null && seen.at(-1) !== page) seen.push(page);
  };
  look();
  const watch = new MutationObserver(look);
  watch.observe(document.body, { childList: true, subtree: true });
  onTestFinished(() => watch.disconnect());
  return () => [...seen];
}

/** Whether `text` showed anywhere on the page, even for a moment, from now until the test ends. */
export function watchFor(text: string): () => boolean {
  let seen = false;
  const observer = new MutationObserver(() => {
    if (document.body.textContent.includes(text)) seen = true;
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  onTestFinished(() => observer.disconnect());
  return () => seen;
}
