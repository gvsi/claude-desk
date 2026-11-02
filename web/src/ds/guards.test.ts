/**
 * Source guards for the design system. They scan only code that runs in a browser: component
 * sources, icons, the package index, base styles and the artifact's own files. Stories, tests,
 * fixtures, references, foundations, the token sources and contrast tables are exempt, because
 * they are where raw values and sample data are meant to live. Some guards read further:
 * `no_invisible_characters_in_any_file` reads every text file, `danger_only_for_refusing_answers`
 * every file but the docs, so a story or fixture can't show the red look on anything but a refusal,
 * `caps_badge_only_in_the_lockup` every file but the docs too, so nothing but the lockup's badge
 * draws capitals, the clay and mark guards the canvas boards too, `no_positive_dash_offsets`
 * every stylesheet, and the two focus guards every stylesheet in the web app.
 *
 * Each guard first proves its matcher on a known-bad sample, so it can't pass by matching nothing.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { pairContrast } from './contrast.ts';
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

/**
 * The files under `dir`, at any depth, as paths relative to it with "/" between parts. Folders are
 * left out whatever their names, such as the `__traces__/X.browser.test.tsx/` folders Vitest's trace
 * viewer leaves behind, so a guard never tries to read one as a file.
 */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
}

function scannedSources(): Source[] {
  return filesUnder(DS)
    .filter(isScanned)
    .sort()
    .map((file) => ({ file, text: readFileSync(path.join(DS, file), 'utf8') }));
}

/** The canvas boards' code and styles (`boards/`), which the clay and mark guards read too. */
function boardSources(): Source[] {
  return filesUnder(path.join(DS, 'boards'))
    .map((file) => `boards/${file}`)
    .filter((file) => /\.(ts|tsx|css)$/.test(file))
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

// Clay: its token, its hex and its RGB triplet. The mark's
// own clay is guarded with its other fixed colors (MARK_COLOR).
const CLAY = /--clay\b|#e08968\b|224\s*,\s*137\s*,\s*104/gi;

// The only folders that may use clay: the field behind the first-visit intro's illustration, and the
// field of the About pages' app icon in the mark's folder, which counts as part of the mark (owner,
// 2026-10-30).
const CLAY_FOLDERS = ['components/IntroDialog/', 'components/Mark/'] as const;
// Claude's writing dots use clay too, at the owner's request (2026-10-31).
const CLAY_FILES = ['components/WritingIndicator/WritingIndicator.css'];

function mayUseClay(file: string): boolean {
  return CLAY_FILES.includes(file) || CLAY_FOLDERS.some((folder) => file.startsWith(folder));
}

// The mark's fixed colors: its tokens by custom property, and its clay by hex or RGB triplet. Its
// white and black are plain colors, which no_raw_colors_outside_tokens already keeps out of sources.
const MARK_COLOR = /(?<![\w-])--mark-[a-z-]*[a-z]|#d97757\b|217\s*,\s*119\s*,\s*87/gi;

// The only folder that may use them: the mark's own.
function mayUseMarkColors(file: string): boolean {
  return file.startsWith('components/Mark/');
}

// The danger buttons' tokens, as custom properties or by name: "--button-danger-fill",
// 'button-danger-text'. The red look is only for answers that refuse.
const DANGER_TOKEN = /(?<![\w-])(?:--)?button-danger(?:-[a-z0-9]+)*(?!\w)/g;

// The only files that may name them: Button's styles, ApprovalCard's styles (the red words of Deny's
// menu items), the token sources, the contrast table and the token tests.
const DANGER_TOKEN_FILES: readonly string[] = [
  'components/Button/Button.css',
  'components/ApprovalCard/ApprovalCard.css',
  'tokens.json',
  'tokens.css',
  'contrast.ts',
  'tokens.test.ts',
];

// A danger button asked for as a `variant` prop or key, by the name only a Button variant has, or by its class.
const DANGER_VARIANT = /\bvariant\s*[:=]\s*\{?\s*(['"`])danger(?:-ghost)?\1|(['"`])danger-ghost\2|\bcd-button--danger(?:-ghost)?\b/g;
const DANGER_LITERAL = /(['"`])danger\1/g;

// The only folders that may ask for one: Button itself, and ApprovalCard's Deny.
const DANGER_VARIANT_FOLDERS = ['components/Button/', 'components/ApprovalCard/'] as const;

function mayUseDangerTokens(file: string): boolean {
  return DANGER_TOKEN_FILES.includes(file);
}

function mayUseDangerVariants(file: string): boolean {
  return DANGER_VARIANT_FOLDERS.some((folder) => file.startsWith(folder));
}

/**
 * Each place a source asks for a danger button. A file that types values as `ButtonVariant` can
 * also pick one through a map or a variable, so there a bare 'danger' counts too; elsewhere it is
 * another component's word, such as Dialog's danger tone, which keeps its buttons neutral.
 */
function dangerVariants(text: string): string[] {
  const asked = [...text.matchAll(DANGER_VARIANT)];
  const hits = asked.map((m) => m[0]);
  if (/\bButtonVariant\b/.test(text)) {
    const counted = (index: number) => asked.some((m) => index >= m.index && index < m.index + m[0].length);
    for (const m of text.matchAll(DANGER_LITERAL)) if (!counted(m.index)) hits.push(m[0]);
  }
  return hits;
}

// The lockup's Preview badge, the product's one all-caps label (owner, 2026-10-30): its type style,
// which draws capitals, and the marker the copy check allows capitals on.
const CAPS_BADGE_NAMES = /badge-caps|preview-badge/g;

// The only places that may name them: the Pill, which draws the badge; the Mark's folder, whose
// Wordmark asks for it; the token sources; the type specimens in Foundations; and the tests and
// their helpers, the copy check among them.
const CAPS_BADGE_FOLDERS = ['components/Pill/', 'components/Mark/', 'test/'] as const;
const CAPS_BADGE_FILES: readonly string[] = ['tokens.json', 'tokens.css', 'foundations/Foundations.stories.tsx'];

function mayNameTheCapsBadge(file: string): boolean {
  return CAPS_BADGE_FILES.includes(file) || CAPS_BADGE_FOLDERS.some((folder) => file.startsWith(folder)) || /\.test\.[a-z]+$/.test(file);
}

/** This file, as `everyTextFile` names it: its known-bad samples are not uses. */
const THIS_FILE = path.relative(DS, fileURLToPath(import.meta.url)).split(path.sep).join('/');

// A number with a time unit ("200ms", ".2s", "0s", "-200ms"), not part of a name like "space-2s".
const RAW_DURATION = /(?<![\w.])(?<!\w-)\d*\.?\d+(?:ms|s)\b/g;

const MOVES = /\b(?:animation|transition)(?:-[a-z]+)*\s*:|@keyframes\b/;
const REDUCED_MOTION_BLOCK = /@media[^{]*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)[^{]*\{/;

/** True when a stylesheet moves something without saying what happens under reduced motion. */
function movesWithoutReducedMotion(css: string): boolean {
  return MOVES.test(css) && !REDUCED_MOTION_BLOCK.test(css);
}

// A `stroke-dashoffset` declaration and its value, not a custom property that ends in the name.
const DASH_OFFSET = /(?<![\w-])stroke-dashoffset\s*:\s*([^;}]+)/g;

/** Every `stroke-dashoffset` declaration in a stylesheet, as "stroke-dashoffset: value". */
function dashOffsets(css: string): string[] {
  return [...css.matchAll(DASH_OFFSET)].map((m) => `stroke-dashoffset: ${(m[1] ?? '').trim()}`);
}

/**
 * The dash offsets that are neither 0 nor negative. The check icon's path starts at the long arm's
 * tip, so a draw from a positive offset goes long arm first.
 */
function positiveDashOffsets(css: string): string[] {
  return dashOffsets(css).filter((declaration) => !/^stroke-dashoffset: (?:0(?:px)?|-\S.*)$/.test(declaration));
}

/** Every stylesheet under `src/ds/`, the boards', tokens and base styles included. */
function allStylesheets(): Source[] {
  return filesUnder(DS)
    .filter((file) => file.endsWith('.css'))
    .map((file) => ({ file, text: readFileSync(path.join(DS, file), 'utf8') }));
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

// Characters that change or hide text without showing: soft hyphens, zero-width and joiner
// characters, direction marks, embeddings, overrides and isolates, and the byte order mark. Written
// as escapes, so this file holds none of them itself.
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;

/** Every text file under `src/ds/`, tests, stories and fixtures included. */
function everyTextFile(): Source[] {
  return filesUnder(DS)
    .filter((file) => /\.(ts|tsx|mjs|css|md|json|html)$/.test(file))
    .sort()
    .map((file) => ({ file, text: readFileSync(path.join(DS, file), 'utf8') }));
}

/** Every TypeScript file under `web/src/`, paths relative to it, so a guard can read the whole app. */
function webSources(): Source[] {
  const src = path.join(DS, '..');
  return filesUnder(src)
    .filter((file) => /\.tsx?$/.test(file))
    .sort()
    .map((file) => ({ file, text: readFileSync(path.join(src, file), 'utf8') }));
}

/** `text` without its comments, so a guard reads only code and the strings code holds. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** Every stylesheet under `web/src/`, paths relative to it: the app's, the About pages' and the design system's. */
function webStylesheets(): Source[] {
  const src = path.join(DS, '..');
  return filesUnder(src)
    .filter((file) => file.endsWith('.css'))
    .map((file) => ({ file, text: readFileSync(path.join(src, file), 'utf8') }));
}

/** An outline or shadow drawn in the link blue, with or without a fallback. */
const BLUE_EDGE = /\b(?:outline(?:-color)?|box-shadow)\s*:[^;{}]*var\(\s*--(?:accent-blue|va-link)\s*(?:,[^)]*)?\)/g;

function blueEdges(css: string): string[] {
  return matches(BLUE_EDGE)(withoutComments(css));
}

// A selector for a state the pointer or the keyboard puts a control in.
const FOCUS_OR_HOVER = /:(?:focus(?:-visible|-within)?|hover)(?![\w-])/;

/**
 * Each innermost rule of a stylesheet whose selector names focus or hover, with its declarations. A
 * rule inside an at-rule (`@media`) counts the same.
 */
function focusOrHoverRules(css: string): { selector: string; declarations: [string, string][] }[] {
  return [...withoutComments(css).matchAll(/([^{};]+)\{([^{}]*)\}/g)]
    .map(([, prelude = '', body = '']) => ({
      selector: prelude.trim().replace(/\s+/g, ' '),
      declarations: body
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.includes(':'))
        .map((part): [string, string] => [part.slice(0, part.indexOf(':')).trim().toLowerCase(), part.slice(part.indexOf(':') + 1).trim()]),
    }))
    .filter(({ selector }) => !selector.startsWith('@') && FOCUS_OR_HOVER.test(selector));
}

/** A value's top-level comma-separated parts, so a color's own commas stay inside it. */
function topLevelParts(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (const [i, char] of [...value].entries()) {
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  return [...parts, value.slice(start)].map((part) => part.trim());
}

/**
 * Each declaration in a focus or hover rule that draws outside the control: an outline that isn't off
 * (any `outline` or `outline-*` other than none or 0), or a shadow with a part that isn't inset.
 */
function ringsOnFocusOrHover(css: string): string[] {
  return focusOrHoverRules(css).flatMap(({ selector, declarations }) =>
    declarations
      .filter(([property, value]) => {
        if (/^outline(?:-[a-z]+)?$/.test(property)) return !/^(?:none|0(?:px)?)(?:\s*!important)?$/.test(value);
        if (property !== 'box-shadow') return false;
        if (/^none(?:\s*!important)?$/.test(value)) return false;
        return topLevelParts(value).some((shadow) => !/\binset\b/.test(shadow));
      })
      .map(([property, value]) => `${selector} { ${property}: ${value} }`),
  );
}

// A stylesheet that paints the selected row's ground, and a component that renders a Button.
const PAINTS_SELECTED = /\bbackground(?:-color)?\s*:[^;{}]*var\(\s*--bg-selected\s*\)/;
const RENDERS_BUTTON = /<Button\b/;

/** A source's component folder, "components/<Comp>/", or null outside the components. */
function componentFolder(file: string): string | null {
  return /^components\/[^/]+\//.exec(file)?.[0] ?? null;
}

/** The component folders whose styles paint `bg-selected`. */
function paintsTheSelectedGround(sources: Source[]): string[] {
  const folders = sources.filter(({ file, text }) => file.endsWith('.css') && PAINTS_SELECTED.test(text)).map(({ file }) => componentFolder(file));
  return [...new Set(folders.filter((folder) => folder !== null))].sort();
}

/** The component folders that paint `bg-selected` and render a Button. */
function buttonsOnTheSelectedGround(sources: Source[]): string[] {
  const renders = new Set(sources.filter(({ file, text }) => file.endsWith('.tsx') && RENDERS_BUTTON.test(text)).map(({ file }) => componentFolder(file)));
  return paintsTheSelectedGround(sources).filter((folder) => renders.has(folder));
}

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
  it('guards_read_files_only', () => {
    // Vitest's trace viewer leaves folders named like test files (`__traces__/X.browser.test.tsx/`):
    // the guards list files, never folders, whatever a folder is called.
    const dir = mkdtempSync(path.join(tmpdir(), 'ds-guards-'));
    try {
      writeFileSync(path.join(dir, 'a.ts'), '');
      mkdirSync(path.join(dir, '__traces__', 'b.browser.test.tsx'), { recursive: true });
      mkdirSync(path.join(dir, 'c.css'));
      writeFileSync(path.join(dir, 'c.css', 'd.css'), '');
      expect(filesUnder(dir)).toEqual(['a.ts', 'c.css/d.css']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const sources = scannedSources();

  it('no_raw_colors_outside_tokens', () => {
    expect(rawColors('.a { color: #fff; background: rgba(0,0,0,.1); border-color: hsl(0 0% 0%) }', 'probe.css')).toHaveLength(3);
    expect(rawColors('.a { color: white; border: 1px solid var(--accent-blue); }', 'probe.css')).toEqual(['color: white']);
    expect(rawColors('.a:not(.red) { color: var(--text-primary); }', 'probe.css')).toEqual([]);
    expect(rawColors("const s = { color: '#E08968' };", 'probe.tsx')).toEqual(['#E08968']);
    expect(findAll(sources, rawColors)).toEqual([]);
  });

  it('clay_only_in_the_intro_dialog_the_mark_and_claudes_writing_dots', () => {
    expect(matches(CLAY)('fill: var(--clay); color: #E08968; rgb(224, 137, 104)')).toHaveLength(3);
    // A token derived from clay ("--clay-soft") counts as clay; an unrelated name doesn't.
    expect(matches(CLAY)('color: var(--clay-soft)')).toEqual(['--clay']);
    expect(matches(CLAY)('--clayton: 1')).toEqual([]);
    // The allowlist is whole folders: a sibling whose name only starts the same way is outside it.
    expect(mayUseClay('components/IntroDialog/IntroDialog.css')).toBe(true);
    expect(mayUseClay('components/IntroDialogBanner/IntroDialogBanner.css')).toBe(false);
    // The mark's folder, for the app icon's field. The bell's dome keeps its own clay (mark-clay),
    // guarded with the mark's other colors.
    expect(mayUseClay('components/Mark/Mark.css')).toBe(true);
    expect(mayUseClay('components/MarkBanner/MarkBanner.css')).toBe(false);
    expect(mayUseClay('components/WritingIndicator/WritingIndicator.css')).toBe(true);
    expect(mayUseClay('components/WritingIndicator/Other.css')).toBe(false);
    expect(mayUseClay('components/WritingIndicatorBanner/WritingIndicator.css')).toBe(false);
    expect(mayUseClay('components/Sidebar/Sidebar.css')).toBe(false);
    const planted: Source[] = [
      { file: 'components/Sidebar/Sidebar.css', text: '.cd-sidebar__brand { background: var(--clay); }' },
      { file: 'boards/boards.css', text: '.board-hero { background: var(--clay); }' },
    ];
    expect(findAll(planted.filter(({ file }) => !mayUseClay(file)), matches(CLAY))).toEqual([
      'components/Sidebar/Sidebar.css: --clay',
      'boards/boards.css: --clay',
    ]);
    // The canvas boards are drawn screens, so they're held to it too.
    const scanned = [...sources, ...boardSources()];
    expect(scanned.some(({ file }) => file.startsWith('boards/'))).toBe(true);
    // Each allowed folder does use it, so the matcher reads the code as it is written.
    for (const folder of CLAY_FOLDERS) {
      expect(findAll(scanned.filter(({ file }) => file.startsWith(folder)), matches(CLAY)).length, folder).toBeGreaterThan(0);
    }
    for (const allowed of CLAY_FILES) {
      expect(findAll(scanned.filter(({ file }) => file === allowed), matches(CLAY)).length, allowed).toBeGreaterThan(0);
    }
    const outsideTheAllowlist = scanned.filter(({ file }) => !mayUseClay(file));
    expect(findAll(outsideTheAllowlist, matches(CLAY))).toEqual([]);
  });

  it('mark_colors_only_in_the_mark', () => {
    // The mark's tokens by custom property, and its clay by hex or RGB triplet.
    expect(
      matches(MARK_COLOR)('fill: var(--mark-tile); stroke: var(--mark-hairline); color: #D97757; rgb(217, 119, 87)'),
    ).toHaveLength(4);
    expect(matches(MARK_COLOR)('fill: var(--mark-clay); fill: var(--mark-ink)')).toEqual(['--mark-clay', '--mark-ink']);
    // A token derived from one counts; a longer name that only contains the word isn't the mark's.
    expect(matches(MARK_COLOR)('color: var(--mark-clay-soft)')).toEqual(['--mark-clay-soft']);
    expect(matches(MARK_COLOR)('--bookmark-tile: 1; --marked: 1')).toEqual([]);
    expect(mayUseMarkColors('components/Mark/Mark.css')).toBe(true);
    expect(mayUseMarkColors('components/IntroDialog/IntroDialog.css')).toBe(false);
    expect(mayUseMarkColors('components/MarkBanner/MarkBanner.css')).toBe(false);
    // The canvas boards are drawn screens, so they're held to it too.
    const scanned = [...sources, ...boardSources()];
    expect(scanned.some(({ file }) => file.startsWith('boards/'))).toBe(true);
    const outsideTheMark = scanned.filter(({ file }) => !mayUseMarkColors(file));
    expect(findAll(outsideTheMark, matches(MARK_COLOR))).toEqual([]);
  });

  it('danger_only_for_refusing_answers', () => {
    // The tokens by custom property or by name; Button's class and longer names that only contain the words aren't tokens.
    expect(matches(DANGER_TOKEN)('background: var(--button-danger-fill); color: var(--button-danger-text);')).toEqual([
      '--button-danger-fill',
      '--button-danger-text',
    ]);
    expect(matches(DANGER_TOKEN)("tokenValue('button-danger-fill-hover')")).toEqual(['button-danger-fill-hover']);
    expect(matches(DANGER_TOKEN)('.cd-button--danger {} --button-dangerous: 1; --my-button-danger: 1;')).toEqual([]);
    // A danger button however a source asks for one.
    expect(dangerVariants('<Button variant="danger">Delete</Button>')).toEqual(['variant="danger"']);
    expect(dangerVariants("args: { variant: 'danger-ghost', size: 'main' }")).toEqual(["variant: 'danger-ghost'"]);
    expect(dangerVariants("<Button variant={'danger'} />")).toEqual(["variant={'danger'"]);
    expect(dangerVariants('<a className="cd-button cd-button--danger-ghost">')).toEqual(['cd-button--danger-ghost']);
    expect(dangerVariants("const quiet = 'danger-ghost';")).toEqual(["'danger-ghost'"]);
    expect(dangerVariants("const look: ButtonVariant = 'danger';")).toEqual(["'danger'"]);
    expect(dangerVariants("const look: ButtonVariant = 'secondary'; <Button variant='danger' />")).toEqual(["variant='danger'"]);
    // Dialog's danger tone adds a refused dot and keeps its buttons neutral: not a danger button.
    expect(dangerVariants("tone?: 'default' | 'danger'; {tone === 'danger' ? <StatusDot tone=\"refused\" /> : null}")).toEqual([]);
    // The allowlists: two whole folders for the buttons, six files for the tokens.
    expect(mayUseDangerVariants('components/ApprovalCard/ApprovalCard.stories.tsx')).toBe(true);
    expect(mayUseDangerVariants('components/ButtonGroup/ButtonGroup.tsx')).toBe(false);
    expect(mayUseDangerVariants('components/Dialog/Dialog.tsx')).toBe(false);
    expect(mayUseDangerTokens('components/Button/Button.css')).toBe(true);
    expect(mayUseDangerTokens('components/Button/Button.tsx')).toBe(false);
    // ApprovalCard's styles name the red words for Deny's menu items, and nothing else of its may.
    expect(mayUseDangerTokens('components/ApprovalCard/ApprovalCard.css')).toBe(true);
    expect(mayUseDangerTokens('components/ApprovalCard/ApprovalCard.tsx')).toBe(false);
    expect(mayUseDangerTokens('components/Dialog/Dialog.css')).toBe(false);

    // Every file but the docs, which name the tokens and variants to explain them, and this file's samples.
    const code = everyTextFile().filter(({ file }) => !file.endsWith('.md') && file !== THIS_FILE);
    expect(code.map(({ file }) => file)).not.toContain('guards.test.ts');
    // The allowed files do use them, so the matchers read the code as it is written.
    expect(findAll(code.filter(({ file }) => mayUseDangerTokens(file)), matches(DANGER_TOKEN)).length).toBeGreaterThan(0);
    expect(findAll(code.filter(({ file }) => mayUseDangerVariants(file)), dangerVariants).length).toBeGreaterThan(0);
    expect(findAll(code.filter(({ file }) => !mayUseDangerTokens(file)), matches(DANGER_TOKEN))).toEqual([]);
    expect(findAll(code.filter(({ file }) => !mayUseDangerVariants(file)), dangerVariants)).toEqual([]);
  });

  it('no_button_on_the_selected_ground', () => {
    // Why: a busy button's label is a listed contrast pair only on the grounds a Button sits on. On
    // bg-selected a busy secondary label would read 4.45 and a busy danger one 3.98, under 4.5,
    // and no busy pair is listed there. To put a Button on it, list those pairs in contrast.ts
    // first, with colors that clear 4.5, and lift this guard.
    expect(pairContrast({ fg: 'text-secondary', ground: 'fill-secondary', over: 'bg-selected' })).toBeCloseTo(4.45, 2);
    expect(pairContrast({ fg: 'button-danger-text', ground: 'button-danger-fill-hover', over: 'bg-selected' })).toBeCloseTo(3.98, 2);
    const ground = (file: string, text: string): Source => ({ file, text });
    // A component that paints the selected ground and renders a Button, in either order of files.
    expect(
      buttonsOnTheSelectedGround([
        ground('components/Row/Row.css', ".cd-row[aria-current='page'] { background: var(--bg-selected); }"),
        ground('components/Row/Row.tsx', '<Button variant="ghost">Open</Button>'),
      ]),
    ).toEqual(['components/Row/']);
    expect(
      buttonsOnTheSelectedGround([
        ground('components/Row/Row.tsx', '<Button\n  variant="ghost">Open</Button>'),
        ground('components/Row/Row.css', '.cd-row { background-color: var( --bg-selected ) }'),
      ]),
    ).toEqual(['components/Row/']);
    // Not: a Button in another component, a comment naming the ground, an IconButton, or a sibling
    // folder whose name only starts the same way.
    expect(
      buttonsOnTheSelectedGround([
        ground('components/Row/Row.css', '/* the current row, on bg-selected */ .cd-row { background: var(--bg-panel); }'),
        ground('components/Row/Row.tsx', '<IconButton label="Open" icon="plus" />'),
        ground('components/RowGroup/RowGroup.tsx', '<Button variant="ghost">Open</Button>'),
        ground('components/Pill/Pill.css', '.cd-pill { background: var(--bg-selected); }'),
      ]),
    ).toEqual([]);
    // The scan reads the components that do paint it, and none of them renders a Button.
    expect(paintsTheSelectedGround(sources).length).toBeGreaterThan(5);
    expect(buttonsOnTheSelectedGround(sources)).toEqual([]);
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

  it('no_positive_dash_offsets', () => {
    // A drawn check goes short arm first: its dash offset runs from minus its dash length to 0, so
    // a stylesheet only ever sets 0 or a negative offset.
    expect(positiveDashOffsets('.a path { stroke-dashoffset: 24; } .b { stroke-dashoffset:12px }')).toEqual([
      'stroke-dashoffset: 24',
      'stroke-dashoffset: 12px',
    ]);
    expect(
      positiveDashOffsets(
        '.a { stroke-dashoffset: -24; } .b { stroke-dashoffset: 0 } @keyframes k { to { stroke-dashoffset: 0px } } .c { --stroke-dashoffset: 3 }',
      ),
    ).toEqual([]);
    const css = allStylesheets();
    // It reads the offsets the checks set, so it can't pass by finding none.
    expect(findAll(css, dashOffsets).length).toBeGreaterThanOrEqual(4);
    expect(findAll(css, positiveDashOffsets)).toEqual([]);
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

  it('caps_badge_only_in_the_lockup', () => {
    // The style and the marker, however a source writes them: a class, a data attribute, a selector.
    const planted: Source[] = [
      { file: 'components/Banner/Banner.tsx', text: '<span className="cd-pill cd-type-badge-caps" data-ds="preview-badge">New</span>' },
      { file: 'components/Sidebar/Sidebar.css', text: '.cd-sidebar__new { } .cd-type-badge-caps { margin: 0 }' },
      { file: 'boards/parts.tsx', text: "<span className={'cd-type-badge-caps'}>Soon</span>" },
    ];
    expect(findAll(planted.filter(({ file }) => !mayNameTheCapsBadge(file)), matches(CAPS_BADGE_NAMES))).toEqual([
      'components/Banner/Banner.tsx: badge-caps',
      'components/Banner/Banner.tsx: preview-badge',
      'components/Sidebar/Sidebar.css: badge-caps',
      'boards/parts.tsx: badge-caps',
    ]);
    expect(matches(CAPS_BADGE_NAMES)('.cd-type-badge { } data-ds="preview" badge-cap')).toEqual([]);
    // The allowlist: two component folders, the tests and their helpers, and three files. A sibling
    // folder whose name only starts the same way, another story or another foundation is outside it.
    for (const file of ['components/Pill/Pill.tsx', 'components/Mark/Mark.tsx', 'tokens.json', 'tokens.css', 'foundations/Foundations.stories.tsx', 'tokens.test.ts', 'test/copy.ts']) {
      expect(mayNameTheCapsBadge(file), file).toBe(true);
    }
    for (const file of ['components/PillGroup/PillGroup.tsx', 'components/Sidebar/Sidebar.stories.tsx', 'components/IntroDialog/IntroDialog.tsx', 'foundations/Type.stories.tsx', 'boards/parts.tsx', 'base.css']) {
      expect(mayNameTheCapsBadge(file), file).toBe(false);
    }

    // Every file but the docs, which name the style to explain it, and this file's samples.
    const code = everyTextFile().filter(({ file }) => !file.endsWith('.md') && file !== THIS_FILE);
    expect(code.map(({ file }) => file)).toContain('boards/parts.tsx');
    // The allowed files do name them, so the matcher reads the code as it is written.
    expect(findAll(code.filter(({ file }) => file === 'components/Pill/Pill.tsx'), matches(CAPS_BADGE_NAMES))).toEqual([
      'components/Pill/Pill.tsx: badge-caps',
      'components/Pill/Pill.tsx: badge-caps',
      'components/Pill/Pill.tsx: preview-badge',
    ]);
    expect(findAll(code.filter(({ file }) => !mayNameTheCapsBadge(file)), matches(CAPS_BADGE_NAMES))).toEqual([]);
  });

  it('no_invisible_characters_in_any_file', () => {
    // Text a reviewer can't see is text a reviewer can't check: a regex range typed as raw
    // zero-width characters reads as an empty class. Escapes written out in the source are fine.
    const hidden = [0x00ad, 0x200b, 0x200d, 0x200e, 0x202e, 0x2060, 0x2066, 0xfeff].map((code) => String.fromCharCode(code));
    for (const char of hidden) expect(matches(INVISIBLE)(`a${char}b`), char.codePointAt(0)?.toString(16)).toHaveLength(1);
    const bs = String.fromCharCode(92);
    expect(matches(INVISIBLE)(`replace(/[${bs}u200B-${bs}u200D${bs}u00AD]/g, '') d•••@example.com Lucía`)).toEqual([]);
    const files = everyTextFile();
    expect(files.length).toBeGreaterThan(100);
    expect(findAll(files, (text) => matches(INVISIBLE)(text).map((char) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}`))).toEqual([]);
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

  it('fact_card_only_on_the_vision_pages', () => {
    // FactCard shows a vision page's sample facts. A real conversation's facts reach a visitor only as
    // the kernel's rendered cards (ReplyCard), so nothing in the web app may name it but its own
    // folder, the index that exports it, the vision boards' page parts and the vision pages.
    const named = (text: string) => matches(/\bFactCard\b/)(withoutComments(text));
    // An import names it three times: the binding and the path's folder and file.
    expect(named("import { FactCard } from '../components/FactCard/FactCard.tsx';")).toHaveLength(3);
    expect(named('const card = <FactCard label="Job card" icon="calendar" title="Friday" />;')).toHaveLength(1);
    expect(named("const note = 'each fact in a FactCard';")).toHaveLength(1);
    expect(named('// A FactCard in a comment.\n/* and FactCard here */\nconst card = <Card />;')).toEqual([]);
    expect(named('import type { FactCardProps } from "../ds/index.ts";')).toEqual([]);
    const allowed = (file: string) =>
      file.startsWith('ds/components/FactCard/') || file === 'ds/index.ts' || file === 'ds/boards/vision.tsx' || file.startsWith('vision/');
    const files = webSources().filter(({ file }) => file !== `ds/${THIS_FILE}`);
    expect(files.filter(({ file, text }) => !allowed(file) && named(text).length > 0).map(({ file }) => file)).toEqual([]);
    // It is named where it is meant to be, so the check can't pass by finding nothing.
    expect(files.filter(({ file, text }) => file === 'ds/boards/vision.tsx' && named(text).length > 0)).toHaveLength(1);
  });

  it('inert_controls_only_on_the_vision_pages', () => {
    // The inert props make a control do nothing, for a vision page, which makes no requests. A real
    // page must send, answer, download, pick a suggestion and ask for the owner, so only the
    // components that take them, the vision boards' page parts, the vision pages and the module of
    // the line an inert control shows may name them.
    const named = (text: string) => matches(/\binert(?:Send|Answers|Download|Suggestions|Ask)\b/)(withoutComments(text));
    expect(named('<Composer variant="visitor" onSend={send} inertSend />')).toEqual(['inertSend']);
    expect(named('const props = { inertAnswers: true, inertDownload };')).toEqual(['inertAnswers', 'inertDownload']);
    expect(named('// inertSend in a comment\nconst inert = true; const inertSending = 1;')).toEqual([]);
    expect(named('<SuggestionChips label="Try asking" suggestions={chips} onPick={pick} inertSuggestions />')).toEqual(['inertSuggestions']);
    expect(named('<PublicShell inertAsk onAskForOwner={ask} />; const asked = inertAsking;')).toEqual(['inertAsk']);
    const allowed = (file: string) =>
      [
        'ds/components/ApprovalCard/',
        'ds/components/Composer/',
        'ds/components/ReplyCard/',
        'ds/components/ClaudeMessage/',
        'ds/components/SuggestionChips/',
        'ds/components/PublicShell/',
        'vision/',
      ].some((folder) => file.startsWith(folder)) ||
      file === 'ds/components/VisionBar/visionInert.tsx' ||
      file === 'ds/boards/vision.tsx';
    const files = webSources().filter(({ file }) => file !== `ds/${THIS_FILE}`);
    expect(files.filter(({ file, text }) => !allowed(file) && named(text).length > 0).map(({ file }) => file)).toEqual([]);
    // They are used where they are meant to be, so the check can't pass by finding nothing: the
    // phone's held quote and composer; the Claude account's invoice, composer and Ask; and the city
    // office's composer, Ask and suggestions.
    expect(named(files.find(({ file }) => file === 'ds/boards/vision.tsx')?.text ?? '').sort()).toEqual([
      'inertAnswers',
      'inertAsk',
      'inertAsk',
      'inertDownload',
      'inertSend',
      'inertSend',
      'inertSend',
      'inertSuggestions',
    ]);
  });

  it('only_delivered_replies_and_setup_questions_can_open_markdown_links', () => {
    // Default and explicit inert links stay available to stopped drafts. Any other links prop
    // (including a constant) or spread could open links, so only these consumers may use it:
    // delivered replies (ClaudeMessage), the owner chats' growing reply, which takes ClaudeMessage's
    // PROSE_LINKS so the saved reply replaces it without a jump, and setup's docked question.
    const canOpen = (text: string) =>
      matches(/<ChatMarkdown\b[\s\S]*?>/)(withoutComments(text)).filter(
        (tag) =>
          /\{\s*\.\.\./.test(tag) ||
          (/\blinks\s*=/.test(tag) && !/\blinks\s*=\s*(?:["']inert["']|\{\s*["']inert["']\s*\})/.test(tag)),
      );
    expect(canOpen('<ChatMarkdown text={text} links="open" />')).toHaveLength(1);
    expect(canOpen('<ChatMarkdown text={text} links="open"></ChatMarkdown>')).toHaveLength(1);
    expect(canOpen("<ChatMarkdown\n text={text}\n links={'open'}\n />")).toHaveLength(1);
    expect(canOpen('<ChatMarkdown text={text} links={PROSE_LINKS} />')).toHaveLength(1);
    expect(canOpen('<ChatMarkdown {...props} />')).toHaveLength(1);
    expect(canOpen('<ChatMarkdown text={text} />; <ChatMarkdown text={text} links="inert" />')).toEqual([]);
    expect(canOpen("// <ChatMarkdown links='open' />\n<ChatMarkdown text={text} links={'inert'} />")).toEqual([]);
    const allowed = ['ds/components/ClaudeMessage/ClaudeMessage.tsx', 'lib/GrowingReply.tsx', 'setup/SetupChoices.tsx'];
    const consumers = webSources()
      .filter(({ file }) => !/\.(?:stories|test)\./.test(file))
      .filter(({ text }) => canOpen(text).length > 0)
      .map(({ file }) => file);
    expect(consumers).toEqual(allowed);
  });

  it('plain_prose_only_on_the_vision_pages', () => {
    // Claude's prose renders as Markdown on every chat. The Vision pages aren't chats and show their
    // words as written, so only ClaudeMessage, the vision boards' page parts and the vision pages may
    // name `plainProse`.
    const named = (text: string) => matches(/\bplainProse\b/)(withoutComments(text));
    expect(named('<ClaudeMessage plainProse blocks={blocks} />')).toEqual(['plainProse']);
    expect(named('// plainProse in a comment\nconst plainProsey = 1;')).toEqual([]);
    const allowed = (file: string) => file.startsWith('ds/components/ClaudeMessage/') || file === 'ds/boards/vision.tsx' || file.startsWith('vision/');
    const files = webSources().filter(({ file }) => file !== `ds/${THIS_FILE}`);
    expect(files.filter(({ file, text }) => !allowed(file) && named(text).length > 0).map(({ file }) => file)).toEqual([]);
    // Every vision page with Claude's words passes it, so the check can't pass by finding nothing.
    expect(files.filter(({ file, text }) => file.startsWith('vision/') && named(text).length > 0).map(({ file }) => file)).toEqual([
      'vision/CityOfficePage.tsx',
      'vision/ClaudeAccountPage.tsx',
      'vision/PhonePage.tsx',
      'vision/VisionFrame.tsx',
    ]);
    // And every ClaudeMessage they draw passes it, however its props are laid out across lines.
    const withoutPlainProse = (text: string) =>
      matches(/<ClaudeMessage\b[\s\S]*?\/>/)(withoutComments(text)).filter((tag) => !/\bplainProse\b/.test(tag));
    expect(withoutPlainProse('<ClaudeMessage\n  blocks={blocks}\n  language="en"\n/>\n<ClaudeMessage\n  plainProse\n  blocks={blocks}\n/>')).toEqual([
      '<ClaudeMessage\n  blocks={blocks}\n  language="en"\n/>',
    ]);
    const visionTags = files.filter(({ file }) => file.startsWith('vision/') || file === 'ds/boards/vision.tsx');
    expect(visionTags.flatMap(({ file, text }) => withoutPlainProse(text).map((tag) => `${file}: ${tag}`))).toEqual([]);
    expect(visionTags.flatMap(({ text }) => matches(/<ClaudeMessage\b/)(withoutComments(text))).length).toBeGreaterThanOrEqual(14);
  });

  it('focus_edges_are_never_the_link_blue', () => {
    // The owner, 2026-11-01: no blue focus border anywhere. Focus is the warm `line-focus`, drawn as a
    // border or an inset shadow; no outline or shadow may use the link blue, with or without a fallback.
    expect(blueEdges('.a:focus-visible { box-shadow: inset 0 0 0 1px var(--accent-blue); } .b { outline-color: var( --va-link , #00f) }')).toEqual([
      'box-shadow: inset 0 0 0 1px var(--accent-blue)',
      'outline-color: var( --va-link , #00f)',
    ]);
    expect(blueEdges('.a:focus-visible { box-shadow: inset 0 0 0 1px var(--line-focus); color: var(--accent-blue); }')).toEqual([]);
    expect(findAll(webStylesheets(), blueEdges)).toEqual([]);
  });

  it('focus_and_hover_draw_no_ring_outside_a_control', () => {
    // The owner, 2026-11-01: "focus shouldn't add a new ring, just have it change the border color", and
    // no outer ring on hover either. A rule for focus or hover may turn an outline off, and may draw a
    // shadow only inset, inside the control's own box; never an outline, and never a shadow outside it.
    expect(
      ringsOnFocusOrHover(
        ':focus-visible { outline: 2px solid var(--line-focus); outline-offset: 2px; }\n' +
          '.a:hover { box-shadow: 0 0 0 2px var(--line-focus); }\n' +
          '.b:focus-within { box-shadow: inset 0 0 0 1px var(--line-focus), 0 1px 2px rgba(0, 0, 0, 0.2) !important; }\n' +
          '@media (min-width: 640px) { .c:focus::after { outline-color: var(--line-focus); } }',
      ),
    ).toEqual([
      ':focus-visible { outline: 2px solid var(--line-focus) }',
      ':focus-visible { outline-offset: 2px }',
      '.a:hover { box-shadow: 0 0 0 2px var(--line-focus) }',
      '.b:focus-within { box-shadow: inset 0 0 0 1px var(--line-focus), 0 1px 2px rgba(0, 0, 0, 0.2) !important }',
      '.c:focus::after { outline-color: var(--line-focus) }',
    ]);
    expect(
      ringsOnFocusOrHover(
        ':focus-visible { outline: none; box-shadow: inset 0 0 0 1px var(--line-focus); }\n' +
          '.a:focus:not(:focus-visible) { outline: none } .b:hover { outline: 0; box-shadow: none; background: var(--fill-hover) }\n' +
          '.c { outline: 2px solid; box-shadow: 0 0 0 4px var(--text-primary) } .d:focus-visible { outline-offset: 0 }\n' +
          '/* .e:hover { box-shadow: 0 0 0 2px red } */',
      ),
    ).toEqual([]);
    const css = webStylesheets();
    // The scan reads the app's focus rules, so it can't pass by finding none.
    expect(findAll(css, (text) => focusOrHoverRules(text).map(({ selector }) => selector)).length).toBeGreaterThan(20);
    expect(findAll(css, ringsOnFocusOrHover)).toEqual([]);
  });

  // Importing the index transforms every component on first use. When the whole suite runs, the
  // browser projects compete for the same CPU, so this import gets more than the default 5 s.
  it('index_exports_every_component', { timeout: 60_000 }, async () => {
    expect(existsSync(path.join(DS, 'index.ts'))).toBe(true);
    const index: Record<string, unknown> = await import('./index.ts');
    const missing = componentNames().filter((name) => index[name] === undefined);
    expect(missing).toEqual([]);
  });
});
