/**
 * Watchers a screen test starts before an action, to tell afterwards what the page drew on the way,
 * even for a moment: each stops when the test ends.
 */
import { onTestFinished } from 'vitest';

import { rivera } from '../ds/fixtures/index.ts';

/** What the not-found page says. */
const NOT_FOUND = "This page doesn't exist";

/**
 * The page drawn now, by name: the preview behind the intro dialog; the owner's loading page or its
 * error; the not-found page, or another page outside the app's frame (an error); Today, named for
 * what it lacks until it holds Rivera's held request and its briefing; any other page; or nothing.
 */
export function pageNow(): string {
  const held = `article[aria-label="Held for you: ${rivera.decisions.held.reason_plain}"]`;
  const state = document.querySelector('.cd-owner-state');
  if (state !== null) return state.querySelector('[role="alert"]') === null ? 'loading' : 'error';
  const standalone = document.querySelector('.cd-standalone-page');
  if (standalone !== null) return standalone.textContent?.includes(NOT_FOUND) ? 'not found' : 'an error page';
  if (document.querySelector('.cd-today-preview') !== null) return 'preview';
  if (document.querySelector('.cd-today') !== null) {
    if (document.querySelector(held) === null) return 'today without its held request';
    if (document.querySelector('.cd-today__loading') !== null) return 'today still reading its briefing';
    return 'today';
  }
  return document.body.textContent.trim() ? 'a page it can’t name' : 'nothing';
}

/**
 * Every page the browser draws from now until the test ends, in order and named as `pageNow` names
 * it, a page drawn many times in a row named once. Nothing drawn before the first page isn't a step.
 */
export function watchPages(): () => string[] {
  const seen: string[] = [];
  const look = () => {
    const page = pageNow();
    if (seen.length === 0 && page === 'nothing') return;
    if (seen.at(-1) !== page) seen.push(page);
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
