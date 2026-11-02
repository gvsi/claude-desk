/**
 * What every screen test checks on a screen's default state: one concept footer word for word,
 * clean copy, zero axe violations at WCAG 2.2 AA, and on owner screens no technical words. From
 * that check on, the screen stays at rest until the test ends: nothing animates or transitions.
 * Beside it, the small checks and waits screen tests share, such as counting the reads a closed
 * Demo inbox sends.
 */
import axe from 'axe-core';
import { expect, onTestFinished, vi } from 'vitest';
import type { Locator } from 'vitest/browser';

import { ROUTES } from '../api/routes.ts';
import { pollMs } from '../app/poll.ts';
import { animationDeadline, animationLabel, animationWithin } from '../ds/test/animationWithin.ts';
import { CONCEPT_FOOTER_TEXT, assertCleanCopy } from '../ds/test/copy.ts';
import { framesWithin } from '../ds/test/framesWithin.ts';

/** The axe rule tags a screen must pass with zero violations. */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] as const;

/** Words the owner never reads, with their plurals (the full trace and quoted untrusted text excepted). */
export const OWNER_JARGON = ['policy', 'Cedar', 'MCP', 'SymCC', 'kernel', 'schema', 'JSON', 'API', 'token', 'proof', 'proven', 'hash'] as const;

const JARGON =
  /\b(?:polic(?:y|ies)|cedars?|mcps?|symcc|kernels?|schemas?|json|apis?|tokens?|proofs?|proven|hash(?:es)?)\b/gi;

/** Attributes whose text is read aloud or shown. */
const READ_ATTRIBUTES = ['aria-label', 'aria-description', 'aria-valuetext', 'title', 'placeholder', 'alt'];

/** Subtrees the jargon check skips: the full trace, someone's own words, what isn't read. */
function skipped(el: Element): boolean {
  return (
    el.classList.contains('cd-type-trace') ||
    el.getAttribute('data-copy') === 'user' ||
    el.getAttribute('aria-hidden') === 'true' ||
    ['script', 'style', 'template', 'noscript'].includes(el.localName)
  );
}

function jargonIn(text: string, where: string, found: string[]): void {
  for (const m of text.matchAll(JARGON)) found.push(`"${m[0]}" in ${where}: "${text.replace(/\s+/g, ' ').trim()}"`);
}

function visit(el: Element, found: string[]): void {
  if (skipped(el)) return;
  for (const name of READ_ATTRIBUTES) {
    const value = el.getAttribute(name);
    if (value) jargonIn(value, name, found);
  }
  for (const child of el.childNodes) {
    if (child.nodeType === child.TEXT_NODE) jargonIn(child.textContent ?? '', 'text', found);
    else if (child.nodeType === child.ELEMENT_NODE) visit(child as Element, found);
  }
}

/** Throws listing every technical word an owner would read under `root`. */
export function assertNoJargon(root: HTMLElement): void {
  const found: string[] = [];
  visit(root, found);
  if (found.length > 0) throw new Error(`Owner copy uses technical words:\n${found.map((f) => `- ${f}`).join('\n')}`);
}

/** Runs axe on `root` with `AXE_TAGS`; resolves to one line per violation and node. */
async function axeViolations(root: HTMLElement): Promise<string[]> {
  const results = await axe.run(root, { runOnly: { type: 'tag', values: [...AXE_TAGS] } });
  return results.violations.flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact ?? 'unknown'}): ${v.help} at ${n.target.join(' ')}`));
}

export interface ScreenBasicsOptions {
  /** An owner screen: also no technical words. */
  owner: boolean;
}

/**
 * Waits for every animation on the page that ends (rows fading in one by one), so contrast is
 * checked on what settles, not mid-fade. Animations that loop (a spinner, the writing dots) are left.
 */
async function animationsSettled(root: HTMLElement): Promise<void> {
  const ending = root.ownerDocument
    .getAnimations()
    .filter((animation) => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity));
  await Promise.all(ending.map((animation) => animationWithin(animation.finished.catch(() => undefined), animationLabel(animation), animationDeadline(animation))));
}

/** The id of the style that holds the screen at rest. */
const AT_REST_ID = 'screen-test-at-rest';

/**
 * Puts the screen at rest for axe and keeps it there until the test ends: whatever is moving (a
 * reply landing, a line fading in) finishes at once, and nothing starts moving after, as under
 * reduced motion, so axe reads each line as it settles, even a reply that lands while axe is
 * reading. Lifting the hold would play every animation again and could catch a row at its first
 * frame, so it stays; screen tests don't check motion after their basics.
 */
function holdAtRest(): void {
  for (const animation of document.getAnimations()) {
    try {
      animation.finish();
    } catch {
      // One that never ends (a writing line's dots) can't finish: the hold below stops it.
    }
  }
  if (document.getElementById(AT_REST_ID) !== null) return;
  const still = document.createElement('style');
  still.id = AT_REST_ID;
  still.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
  document.head.append(still);
  onTestFinished(() => {
    still.remove();
  });
}

export async function expectScreenBasics(root: HTMLElement, { owner }: ScreenBasicsOptions): Promise<void> {
  await vi.waitFor(() => expect(root.ownerDocument.querySelector('.cd-skeleton-screen__layer')).toBeNull());
  await nextFrames();
  await animationsSettled(root);
  const footers = [...root.querySelectorAll('[data-ds="concept-footer"]')].filter((footer) => !footer.closest('.cd-skeleton-screen__layer'));
  expect(footers, 'one concept footer').toHaveLength(1);
  expect(footers[0]?.textContent?.replace(/\s+/g, ' ').trim()).toBe(CONCEPT_FOOTER_TEXT);
  assertCleanCopy(root);
  holdAtRest();
  const violations = await axeViolations(root);
  if (violations.length > 0) throw new Error(`axe found ${violations.length} violations:\n${violations.map((v) => `- ${v}`).join('\n')}`);
  if (owner) assertNoJargon(root);
}

/** The page is no wider than the window: nothing scrolls sideways. */
export function expectNoHorizontalScroll(): void {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

/** The window itself doesn't scroll: the app shell is the window's height, and only its own columns scroll. */
export function expectNoWindowScroll(): void {
  expect(document.documentElement.scrollHeight).toBe(window.innerHeight);
}

/**
 * The color a token computes to, read off a probe element: in the app's palette, or inside `within`, where a page
 * on a palette of its own (the About set's paper) points the token elsewhere.
 */
export function tokenColor(token: string, within: Element = document.body): string {
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`;
  within.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

/**
 * Whether keyboard focus is on `el`: on it or inside it, or on the element that holds it and
 * nothing else, such as a held request's focusable wrapper. Never the page itself, which holds
 * everything.
 */
export function focusIsOn(el: Element): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body || active === document.documentElement) return false;
  return el.contains(active) || (active.contains(el) && active.textContent === el.textContent);
}

/** Two animation frames: long enough for a change, such as a navigation's transition, to be drawn. */
export async function nextFrames(): Promise<void> {
  await framesWithin('screen redraw frames', 2);
}

/**
 * Counts the reads of the owner's notifications the app sends from now on while `shown` (the
 * Notifications page's heading) isn't on the page, each as it is sent: a read sent while the page
 * was open isn't one, however late the mock gets it.
 */
export function closedInboxReads(shown: Locator): () => number {
  const send = window.fetch;
  let count = 0;
  const sending = vi.spyOn(window, 'fetch').mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.pathname === ROUTES.ownerInbox.path && shown.elements().length === 0) count += 1;
    return send(input, init);
  });
  onTestFinished(() => sending.mockRestore());
  return () => count;
}

/** A whole poll of the notifications', then two frames: a page still polling would have read by then. */
export async function aPollPasses(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, pollMs('inbox')));
  await nextFrames();
}
