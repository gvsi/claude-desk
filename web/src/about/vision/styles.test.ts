/**
 * The Vision article's stylesheet keeps to itself: every rule sits under the article's root class, its palette is
 * declared on that root and nowhere else, its type uses the app's two families by their tokens, and nothing on the
 * page moves. The app's source guards hold its colors (only as custom properties on the root) and keep clay out.
 *
 * Each check first proves its matcher on known-bad samples, so it can't pass by matching nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const STYLES = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'VisionArticle.css'), 'utf8');
const ROOT = '.vision-article';

/** `css` without its comments. */
function code(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every selector in `css`, one per entry of a list, inside an at-rule's block too; at-rules themselves left out. */
function selectors(css: string): string[] {
  return [...code(css).matchAll(/(?<=^|[{};])\s*([^{};]+?)\s*\{/g)]
    .map((m) => (m[1] ?? '').trim())
    .filter((prelude) => !prelude.startsWith('@'))
    .flatMap((prelude) => prelude.split(',').map((selector) => selector.trim()));
}

/** The selectors in `css` that don't start with the article's root class. */
function outsideTheRoot(css: string): string[] {
  return selectors(css).filter((selector) => !/^\.vision-article(?![\w-])/.test(selector));
}

/** Each rule in `css` as its selector list and its declarations. */
function rules(css: string): { selector: string; body: string }[] {
  return [...code(css).matchAll(/(?<=^|[{};])\s*([^{};@]+?)\s*\{([^{}]*)\}/g)].map((m) => ({ selector: (m[1] ?? '').trim(), body: m[2] ?? '' }));
}

/** The custom properties `css` declares on a rule other than the root itself, as "selector: --name". */
function propertiesOffTheRoot(css: string): string[] {
  return rules(css)
    .filter(({ selector }) => selector !== ROOT)
    .flatMap(({ selector, body }) => [...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => `${selector}: ${m[1]}`));
}

/** Each `font-family` value in `css` that isn't one of the app's two family tokens. */
function otherFamilies(css: string): string[] {
  return [...code(css).matchAll(/font-family\s*:\s*([^;}]+)/g)]
    .map((m) => (m[1] ?? '').trim())
    .filter((value) => !['var(--font-serif)', 'var(--font-sans)'].includes(value));
}

// Anything that moves: an animation, a transition, or keyframes for one.
const MOTION = /@keyframes\b|(?<![\w-])(?:animation|transition)(?:-[a-z-]+)?\s*:/g;

describe('the Vision article stylesheet', () => {
  it('every_rule_sits_under_the_article_root', () => {
    const bad = [
      '.va-bar { color: var(--va-ink); }',
      '.vision-article .va-bar, .va-p { margin: 0; }',
      '@media (max-width: 720px) { .va-band { display: none; } }',
      '.vision-articles .va-bar { margin: 0; }',
      'body { background: var(--va-paper); }',
    ];
    expect(bad.map(outsideTheRoot)).toEqual([['.va-bar'], ['.va-p'], ['.va-band'], ['.vision-articles .va-bar'], ['body']]);
    expect(outsideTheRoot('/* .va-bar { } */ .vision-article :focus-visible { outline-color: var(--va-link); }')).toEqual([]);

    expect(selectors(STYLES).length).toBeGreaterThan(50);
    expect(outsideTheRoot(STYLES)).toEqual([]);
  });

  it('the_palette_is_declared_on_the_root_alone', () => {
    expect(propertiesOffTheRoot('.vision-article { --va-ink: #1c1b19; } .vision-article .va-bar { --va-ink: #000000; }')).toEqual([
      '.vision-article .va-bar: --va-ink',
    ]);
    expect(propertiesOffTheRoot('.vision-article .va-bar { color: var(--va-ink); }')).toEqual([]);

    expect(rules(STYLES).filter(({ selector }) => selector === ROOT)).toHaveLength(1);
    expect(propertiesOffTheRoot(STYLES)).toEqual([]);
  });

  it('the_type_uses_the_app_families', () => {
    expect(otherFamilies("a { font-family: 'Source Serif 4', Georgia, serif; } b { font-family: var(--font-sans); }")).toEqual([
      "'Source Serif 4', Georgia, serif",
    ]);
    expect(otherFamilies(STYLES)).toEqual([]);
  });

  it('nothing_moves', () => {
    expect('@keyframes fade {} a { transition: opacity; animation-name: x; } b { transition-duration: 0; }'.match(MOTION)).toHaveLength(4);
    expect('--va-transitional: 1; .va-animation-free {}'.match(MOTION)).toBeNull();
    expect(STYLES.match(MOTION)).toBeNull();
  });
});
