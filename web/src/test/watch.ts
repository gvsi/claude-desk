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
 * error; the not-found page, or another page outside the app's frame (an error); Today while its
 * own skeleton is mounted, then named for what it lacks until it holds Turner's held request
 * and its briefing; any other page; or nothing.
 */
export function pageNow(): string {
  const held = `article[aria-label="Held for you: ${rivera.decisions.held.reason_plain}"]`;
  if (document.querySelector('.cd-owner-opening > .cd-skeleton-screen__body > .cd-skeleton-screen__layer') !== null) return 'loading';
  const state = document.querySelector('.cd-owner-state');
  if (state !== null) return 'error';
  const standalone = document.querySelector('.cd-standalone-page');
  if (standalone !== null) return standalone.textContent?.includes(NOT_FOUND) ? 'not found' : 'an error page';
  if (document.querySelector('.cd-today-preview') !== null) return 'preview';
  if (document.querySelector('.cd-today-opening .cd-skeleton-screen__layer') !== null) return 'today opening';
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

/**
 * Every place the element `find` returns is drawn at, as its top in whole CSS px from the top of the
 * window, read each time the page changes from now until the test ends, a place held many times in
 * a row named once. While `find` returns nothing, there is no place to read.
 */
export function watchTop(find: () => Element | null): () => number[] {
  const tops: number[] = [];
  const look = () => {
    const element = find();
    if (element === null) return;
    const top = Math.round(element.getBoundingClientRect().top);
    if (tops.at(-1) !== top) tops.push(top);
  };
  look();
  const watch = new MutationObserver(look);
  watch.observe(document.body, { childList: true, subtree: true, characterData: true });
  onTestFinished(() => watch.disconnect());
  return () => [...tops];
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
