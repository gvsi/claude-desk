/**
 * Source guards for the design system. They scan only code that runs in a browser: component
 * sources, icons, the package index, base styles and the artifact's own files. Stories, tests,
 * fixtures, references, foundations, the token sources and contrast tables are exempt, because
 * they are where raw values and sample data are meant to live.
 *
 * Each guard first proves its matcher on a known-bad sample, so it can't pass by matching nothing.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ARROW_CHARACTERS } from './test/copy.ts';

const DS = path.dirname(fileURLToPath(import.meta.url));

interface Source {
  /** Path relative to `src/ds/`, with forward slashes. */
  file: string;
  text: string;
}

function isScanned(file: string): boolean {
  if (file.endsWith('.md') || /\.(stories|test)\./.test(file)) return false;
  return (
    /^components\/.+\.(ts|tsx|css)$/.test(file) ||
    /^icons\/.+\.[a-z]+$/.test(file) ||
    file === 'index.ts' ||
    file === 'base.css' ||
    /^artifact\/[^/]+\.(ts|html)$/.test(file)
  );
}

function scannedSources(): Source[] {
  return readdirSync(DS, { recursive: true, encoding: 'utf8' })
    .map((file) => file.split(path.sep).join('/'))
    .filter(isScanned)
    .sort()
    .map((file) => ({ file, text: readFileSync(path.join(DS, file), 'utf8') }));
}

/** Everything `find` reports in each source, as "file: hit". */
function findAll(sources: Source[], find: (text: string, file: string) => string[]): string[] {
  return sources.flatMap(({ file, text }) => find(text, file).map((hit) => `${file}: ${hit}`));
}

function matches(pattern: RegExp): (text: string) => string[] {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  return (text) => [...text.matchAll(global)].map((m) => m[0]);
}

// Raw color syntax: hex colors and the CSS color functions.
const RAW_COLOR = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;

// CSS named colors (CSS Color 4), matched only inside CSS declaration values.
const NAMED_COLORS = [
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black', 'blanchedalmond', 'blue',
  'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk',
  'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki',
  'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
  'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue',
  'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite',
  'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory',
  'khaki', 'lavender', 'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan',
  'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon', 'lightseagreen',
  'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime', 'limegreen', 'linen',
  'magenta', 'maroon', 'mediumaquamarine', 'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen',
  'mediumslateblue', 'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream',
  'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange', 'orangered', 'orchid',
  'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink', 'plum',
  'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown',
  'seagreen', 'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen',
  'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow',
  'yellowgreen',
];
const NAMED_COLOR = new RegExp(`\\b(?:${NAMED_COLORS.join('|')})\\b(?!\\s*\\()`, 'gi');

/** Named colors in CSS declaration values (`prop: value;`), ignoring custom property names. */
function namedColorsInCss(text: string): string[] {
  const hits: string[] = [];
  for (const [, prop, value] of text.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/gi)) {
    const bare = (value ?? '').replace(/--[\w-]+/g, '');
    for (const m of bare.matchAll(NAMED_COLOR)) hits.push(`${prop}: ${m[0]}`);
  }
  return hits;
}

function rawColors(text: string, file: string): string[] {
  return [...matches(RAW_COLOR)(text), ...(file.endsWith('.css') ? namedColorsInCss(text) : [])];
}

// The clay of the Claude Desk mark: its token, its hex and its RGB triplet.
const CLAY = /--clay\b|#e08968\b|224\s*,\s*137\s*,\s*104/gi;

// A number with a time unit ("200ms", ".2s", "0s", "-200ms"), not part of a name like "space-2s".
const RAW_DURATION = /(?<![\w.])(?<!\w-)\d*\.?\d+(?:ms|s)\b/g;

const MOVES = /\b(?:animation|transition)(?:-[a-z]+)*\s*:|@keyframes\b/;
const REDUCED_MOTION_BLOCK = /@media[^{]*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)[^{]*\{/;

/** True when a stylesheet moves something without saying what happens under reduced motion. */
function movesWithoutReducedMotion(css: string): boolean {
  return MOVES.test(css) && !REDUCED_MOTION_BLOCK.test(css);
}

// Capitals drawn by code: CSS transforms and small caps, JavaScript upper-casing, title case.
const UPPERCASE = /uppercase|small-caps|capitali[sz]e/gi;

// Arrows written as escapes: HTML entities by name or number, JavaScript and CSS escapes.
const ARROW_ENTITY = /&[a-z]*arr(?:ow[a-z]*)?;/gi;
const ESCAPED_CODE_POINT = /&#(\d+);|&#x([0-9a-f]+);|\\u\{([0-9a-f]+)\}|\\u([0-9a-f]{4})|\\([0-9a-f]{1,6})(?![0-9a-z])/gi;

/** Arrows in source, whether typed as characters or written as escapes. */
function arrowsInSource(text: string): string[] {
  const hits = [...matches(ARROW_CHARACTERS)(text), ...matches(ARROW_ENTITY)(text)];
  for (const m of text.matchAll(ESCAPED_CODE_POINT)) {
    const [, decimal, ...hex] = m;
    const code = decimal !== undefined ? Number(decimal) : parseInt(hex.find((h) => h !== undefined) ?? '', 16);
    if (code <= 0x10ffff && ARROW_CHARACTERS.test(String.fromCodePoint(code))) hits.push(m[0]);
  }
  return hits;
}

// Formatting or computing money, dates and discounts: the kernel renders those, never the client.
const FORMATS = /\bIntl\b|toLocale|\bnew\s+Date\b|(?<![\w.])Date\s*\(|\bDate\s*\.\s*(?:now|parse|UTC)\b|\bTemporal\s*\.|\bto(?:Fixed|Precision)\s*\(/g;

/** Component folders under `components/`, each named for its main export. */
function componentNames(): string[] {
  const dir = path.join(DS, 'components');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * What is wrong with a component README, or null: it starts with `# <Comp>`, and its first
 * paragraph is a summary sentence (prose ending in a full stop, not a heading, list, table or code).
 */
function readmeProblem(name: string, readme: string | undefined): string | null {
  if (readme === undefined) return `components/${name}/README.md is missing`;
  const lines = readme.split(/\r?\n/);
  if (lines[0] !== `# ${name}`) return `components/${name}/README.md starts "${lines[0] ?? ''}", not "# ${name}"`;
  const rest = lines.slice(1);
  const start = rest.findIndex((line) => line.trim() !== '');
  const end = rest.findIndex((line, i) => i > start && line.trim() === '');
  const summary = rest.slice(start, end === -1 ? undefined : end).join(' ').trim();
  if (start === -1 || /^(?:#|[-*+] |\d+\. |\||```|>)/.test(summary) || !summary.endsWith('.')) {
    return `components/${name}/README.md has no summary sentence after its heading`;
  }
  return null;
}

describe('design system source guards', () => {
  const sources = scannedSources();

  it('no_raw_colors_outside_tokens', () => {
    expect(rawColors('.a { color: #fff; background: rgba(0,0,0,.1); border-color: hsl(0 0% 0%) }', 'probe.css')).toHaveLength(3);
    expect(rawColors('.a { color: white; border: 1px solid var(--accent-blue); }', 'probe.css')).toEqual(['color: white']);
    expect(rawColors('.a:not(.red) { color: var(--text-primary); }', 'probe.css')).toEqual([]);
    expect(rawColors("const s = { color: '#E08968' };", 'probe.tsx')).toEqual(['#E08968']);
    expect(findAll(sources, rawColors)).toEqual([]);
  });

  it('clay_only_in_the_mark', () => {
    expect(matches(CLAY)('fill: var(--clay); color: #E08968; rgb(224, 137, 104)')).toHaveLength(3);
    // A token derived from clay ("--clay-soft") counts as clay; an unrelated name doesn't.
    expect(matches(CLAY)('color: var(--clay-soft)')).toEqual(['--clay']);
    expect(matches(CLAY)('--clayton: 1')).toEqual([]);
    const outsideTheMark = sources.filter(({ file }) => !file.startsWith('components/Mark/'));
    expect(findAll(outsideTheMark, matches(CLAY))).toEqual([]);
  });

  it('no_raw_durations', () => {
    expect(matches(RAW_DURATION)('transition: opacity 200ms ease-out, transform .2s; animation-delay: 0s')).toEqual([
      '200ms',
      '.2s',
      '0s',
    ]);
    // Negative delays, the usual way to offset looping dots, are raw durations too.
    expect(matches(RAW_DURATION)('animation-delay: -200ms; transition-delay: -.1s')).toEqual(['200ms', '.1s']);
    expect(matches(RAW_DURATION)('transition: opacity var(--motion-fast) var(--motion-ease); gap: var(--space-2)')).toEqual([]);
    expect(matches(RAW_DURATION)('gap: var(--space-2s); --delay-1s: 0; .x-3ms {}')).toEqual([]);
    // Scanned TypeScript too, so an inline style can't carry a duration past the tokens.
    expect(findAll(sources, matches(RAW_DURATION))).toEqual([]);
  });

  it('reduced_motion_covers_animation', () => {
    expect(movesWithoutReducedMotion('.a { transition: opacity var(--motion-fast) }')).toBe(true);
    expect(movesWithoutReducedMotion('@keyframes cd-breathe { to { opacity: 0.6 } }')).toBe(true);
    expect(movesWithoutReducedMotion('.a { animation-name: cd-breathe }')).toBe(true);
    expect(
      movesWithoutReducedMotion(
        '.a { transition: opacity var(--motion-fast) } @media (prefers-reduced-motion: reduce) { .a { transition: none } }',
      ),
    ).toBe(false);
    expect(movesWithoutReducedMotion('.a { color: var(--text-primary) }')).toBe(false);
    const stylesheets = sources.filter(({ file }) => file.endsWith('.css'));
    expect(stylesheets.map(({ file }) => file)).toContain('base.css');
    expect(stylesheets.filter(({ text }) => movesWithoutReducedMotion(text)).map(({ file }) => file)).toEqual([]);
  });

  it('no_uppercase_or_arrows_in_source', () => {
    expect(matches(UPPERCASE)('name.toUpperCase(); .a { text-transform: uppercase; font-variant-caps: all-small-caps }')).toHaveLength(3);
    expect(matches(UPPERCASE)("{ textTransform: 'capitalize' }")).toHaveLength(1);
    const bs = String.fromCharCode(92);
    const escapes = ['&rarr;', '&#8594;', '&#x2192;', `${bs}u2192`, `${bs}u{2192}`, `content: "${bs}2192"`, '&RightArrow;'];
    for (const escape of escapes) expect(arrowsInSource(escape), escape).toHaveLength(1);
    expect(arrowsInSource('Continue →')).toEqual(['→']);
    expect(arrowsInSource(`Next ${String.fromCodePoint(0x1f852)} and ${bs}u{1F852}`)).toHaveLength(2);
    // Escapes of other characters, and regex escapes such as a word boundary, are not arrows.
    expect(arrowsInSource(`&amp; &#8212; ${bs}u00a0 /${bs}bword${bs}d/ &#x2014;`)).toEqual([]);
    expect(findAll(sources, matches(UPPERCASE))).toEqual([]);
    expect(findAll(sources, arrowsInSource)).toEqual([]);
  });

  it('components_never_format_money_or_dates', () => {
    const probe =
      'new Intl.NumberFormat(); d.toLocaleDateString(); new Date(); Date.now(); Date.parse(s); n.toFixed(2); Date(); Temporal.Now; n.toPrecision(3); Date.UTC(1)';
    expect(matches(FORMATS)(probe)).toHaveLength(10);
    // Intl taken as a value, not only through a dot, is still Intl.
    expect(matches(FORMATS)('const { NumberFormat } = Intl; fmt(Intl)')).toEqual(['Intl', 'Intl']);
    expect(matches(FORMATS)('const updatedDate = block.text; isDateLike(x); props.date; IntlLabel')).toEqual([]);
    expect(findAll(sources, matches(FORMATS))).toEqual([]);
  });

  it('every_component_has_a_readme', () => {
    expect(readmeProblem('Button', '# Button\n\nThe one way to start an action.\n\n## Props\n')).toBeNull();
    expect(readmeProblem('Button', '# Button\n\n`Button` starts an action,\nin one of three weights.\n')).toBeNull();
    expect(readmeProblem('Button', undefined)).toMatch(/missing/);
    expect(readmeProblem('Button', '# Buttons\n\nStarts an action.\n')).toMatch(/not "# Button"/);
    expect(readmeProblem('Button', '# Button\n\n## Props\n')).toMatch(/no summary sentence/);
    expect(readmeProblem('Button', '# Button\n\n- primary\n')).toMatch(/no summary sentence/);
    expect(readmeProblem('Button', '# Button\n')).toMatch(/no summary sentence/);
    const problems = componentNames().map((name) => {
      const file = path.join(DS, 'components', name, 'README.md');
      return readmeProblem(name, existsSync(file) ? readFileSync(file, 'utf8') : undefined);
    });
    expect(problems.filter((problem) => problem !== null)).toEqual([]);
  });

  it('index_exports_every_component', async () => {
    expect(existsSync(path.join(DS, 'index.ts'))).toBe(true);
    const index: Record<string, unknown> = await import('./index.ts');
    const missing = componentNames().filter((name) => index[name] === undefined);
    expect(missing).toEqual([]);
  });
});
