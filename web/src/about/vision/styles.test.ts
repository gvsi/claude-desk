/**
 * The Vision article's stylesheet keeps to itself: every rule sits under the article's root class, its own palette
 * (its phones') is declared on that root and nowhere else, its type uses the app's two families by their tokens, and
 * nothing on the page moves. The page's palette is the About set's paper (`../paper.css`), which the two reading pages
 * share: two rules on its two classes and nothing else, the palette on the first, and on the second the app's color
 * tokens pointed at it, so nothing it declares reaches another page. The app's source guards hold the colors of both
 * stylesheets (only as custom properties on each root) and keep clay out.
 *
 * Each check first proves its matcher on known-bad samples, so it can't pass by matching nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STYLES = readFileSync(path.join(HERE, 'VisionArticle.css'), 'utf8');
const ROOT = '.vision-article';
const PAPER = readFileSync(path.join(HERE, '..', 'paper.css'), 'utf8');
const PAPER_ROOT = '.cd-about-paper';
const PAPER_APP = '.cd-about-paper--app';
const TOKENS = readFileSync(path.join(HERE, '..', '..', 'ds', 'tokens.css'), 'utf8');

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

// A selector that starts at the article's root, and one that then steps to the root's own siblings (`+`, `~`),
// which are outside the article.
const AT_THE_ROOT = /^\.vision-article(?![\w-])/;
const TO_A_SIBLING = /^\.vision-article(?![\w-])[^\s+~>]*\s*[+~]/;

/** The selectors in `css` that don't select the article's root or something inside it. */
function outsideTheRoot(css: string): string[] {
  return selectors(css).filter((selector) => !AT_THE_ROOT.test(selector) || TO_A_SIBLING.test(selector));
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
      // The root's siblings, after it, are outside the article.
      '.vision-article + .cd-about-page { font-size: 12px; }',
      '.vision-article ~ .cd-owner { font-family: var(--font-serif); }',
      '.vision-article:not(.x)~.cd-owner { margin: 0; }',
    ];
    expect(bad.map(outsideTheRoot)).toEqual([
      ['.va-bar'],
      ['.va-p'],
      ['.va-band'],
      ['.vision-articles .va-bar'],
      ['body'],
      ['.vision-article + .cd-about-page'],
      ['.vision-article ~ .cd-owner'],
      ['.vision-article:not(.x)~.cd-owner'],
    ]);
    // Inside it: a descendant or a child, and a sibling of something inside it.
    expect(
      outsideTheRoot('/* .va-bar { } */ .vision-article :focus-visible, .vision-article > main, .vision-article .va-p + .va-p { margin: 0; }'),
    ).toEqual([]);

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

/** The custom properties a rule declares, by name, with their values, for each rule on `selector` in `css`. */
function declared(css: string, selector: string): Map<string, string> {
  return new Map(
    rules(css)
      .filter((rule) => rule.selector === selector)
      .flatMap(({ body }) => [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()] as const)),
  );
}

/** The plain (not custom) declarations of each rule on `selector` in `css`, as "name: value". */
function plain(css: string, selector: string): string[] {
  return rules(css)
    .filter((rule) => rule.selector === selector)
    .flatMap(({ body }) => body.split(';').map((d) => d.trim().replace(/\s+/g, ' ')))
    .filter((d) => d !== '' && !d.startsWith('--'));
}

/** Each `var(--va-…)` that `css` reads, by name. */
function reads(css: string): Set<string> {
  return new Set([...code(css).matchAll(/var\(\s*(--va-[\w-]+)/g)].map((m) => m[1] ?? ''));
}

/** The app's color tokens, by name, as tokens.css declares them. */
const APP_COLORS = new Set(
  [...(TOKENS.split(/\n\}\n/)[0] ?? '').matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] ?? '').filter((name) => name !== ''),
);

describe('the About set paper', () => {
  it('the_paper_is_its_two_classes_alone', () => {
    // Anything else, such as a rule on something inside a page, or on the page's own elements, would reach past
    // the palette.
    const only = (css: string) => selectors(css).filter((selector) => selector !== PAPER_ROOT && selector !== PAPER_APP);
    expect(only('.cd-about-paper { --va-ink: #000000; } .cd-about-paper .cd-card { color: red; } .cd-about-paper--app, body { margin: 0; }')).toEqual([
      '.cd-about-paper .cd-card',
      'body',
    ]);
    expect(only(PAPER)).toEqual([]);
    expect(selectors(PAPER).sort()).toEqual([PAPER_ROOT, PAPER_APP]);
  });

  it('the_paper_declares_the_vision_articles_palette', () => {
    // The palette's names keep the article's prefix: they are its colors. Nothing but the palette is on its root.
    const palette = declared(PAPER, PAPER_ROOT);
    expect([...palette.keys()]).toEqual(expect.arrayContaining(['--va-paper', '--va-ink', '--va-ink-2', '--va-line', '--va-link', '--va-bar']));
    expect([...palette.keys()].filter((name) => !name.startsWith('--va-'))).toEqual([]);
    expect(plain(PAPER, PAPER_ROOT)).toEqual([]);
    // The article declares the rest of its colors, its phones', on its root, and none of the paper's.
    const own = declared(STYLES, ROOT);
    expect([...own.keys()].filter((name) => palette.has(name))).toEqual([]);
    // And every color it reads is declared in one of the two.
    expect(reads('.vision-article .x { color: var(--va-ink); background: var(--va-nowhere); }')).toEqual(new Set(['--va-ink', '--va-nowhere']));
    expect([...reads(STYLES)].filter((name) => !own.has(name) && !palette.has(name))).toEqual([]);
  });

  it('the_app_tokens_point_at_the_paper', () => {
    // On a page drawn with the app's components, each app color token it points elsewhere is one tokens.css
    // declares, pointed at a color of the palette and at nothing else; its other declarations are the paper's
    // ground. A raw color, another app token or a misspelt name is caught.
    const palette = declared(PAPER, PAPER_ROOT);
    const misses = (css: string) =>
      [...declared(css, PAPER_APP)].filter(([name, value]) => {
        const to = /^var\((--va-[\w-]+)\)$/.exec(value)?.[1];
        return !APP_COLORS.has(name) || to === undefined || !palette.has(to);
      });
    expect(APP_COLORS.has('--bg-app') && APP_COLORS.has('--accent-blue') && !APP_COLORS.has('--space-2')).toBe(true);
    expect(
      misses('.cd-about-paper--app { --bg-app: var(--va-paper); --text-primary: #1c1b19; --bg-panle: var(--va-tile); --line-card: var(--line-hairline); --space-2: var(--va-ink); }'),
    ).toEqual([
      ['--text-primary', '#1c1b19'],
      ['--bg-panle', 'var(--va-tile)'],
      ['--line-card', 'var(--line-hairline)'],
      ['--space-2', 'var(--va-ink)'],
    ]);
    expect(declared(PAPER, PAPER_APP).size).toBeGreaterThan(10);
    expect(misses(PAPER)).toEqual([]);
    expect(plain(PAPER, PAPER_APP).sort()).toEqual([
      'background: var(--va-paper)',
      'color-scheme: light',
      'color: var(--va-ink)',
      'min-height: 100dvh',
    ]);
  });

  it('the_paper_uses_no_font_and_nothing_moves', () => {
    expect(otherFamilies(PAPER)).toEqual([]);
    expect(PAPER.match(MOTION)).toBeNull();
  });
});
