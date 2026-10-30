/**
 * What every screen test checks on a screen's default state: one concept footer word for word,
 * clean copy, zero axe violations at WCAG 2.2 AA, and on owner screens no technical words.
 */
import axe from 'axe-core';
import { expect } from 'vitest';

import { CONCEPT_FOOTER_TEXT, assertCleanCopy } from '../ds/test/copy.ts';

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

export async function expectScreenBasics(root: HTMLElement, { owner }: ScreenBasicsOptions): Promise<void> {
  const footers = root.querySelectorAll('[data-ds="concept-footer"]');
  expect(footers, 'one concept footer').toHaveLength(1);
  expect(footers[0]?.textContent?.replace(/\s+/g, ' ').trim()).toBe(CONCEPT_FOOTER_TEXT);
  assertCleanCopy(root);
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

/** The color a token computes to, read off a probe element. */
export function tokenColor(token: string): string {
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`;
  document.body.append(probe);
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
