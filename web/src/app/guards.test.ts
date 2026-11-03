/**
 * Source guards for the app: everything under `src/` that runs in a browser, except the design
 * system (it has its own guards), the mock API and tests; one guard, on the mark's and clay's colors,
 * reads every text file. Each guard first proves its matcher on a known-bad sample, so it can't pass
 * by matching nothing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

import { withoutComments, withoutCssComments } from '../test/withoutComments.ts';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Source {
  /** Path relative to `src/`, with forward slashes. */
  file: string;
  text: string;
}

function isScanned(file: string): boolean {
  if (!/\.(ts|tsx|css)$/.test(file)) return false;
  if (/^(ds|mocks|test)\//.test(file)) return false;
  return !/\.test\.tsx?$/.test(file);
}

const sources: Source[] = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .map((file) => file.split(path.sep).join('/'))
  .filter(isScanned)
  .sort()
  .map((file) => ({ file, text: readFileSync(path.join(SRC, file), 'utf8') }));

/** Every match of `pattern` in each source, as "file: match". */
function hits(pattern: RegExp, scanned: Source[] = sources): string[] {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  return scanned.flatMap(({ file, text }) => [...text.matchAll(global)].map((m) => `${file}: ${m[0]}`));
}

function sample(text: string): Source[] {
  return [{ file: 'sample.tsx', text }];
}

/**
 * The selectors of every rule inside a `prefers-color-scheme: light` media block, each one alone:
 * the text before each rule's opening brace, split at its commas.
 */
function systemLightSelectors(css: string): string[] {
  const found: string[] = [];
  for (const match of css.matchAll(/@media[^{]*prefers-color-scheme\s*:\s*light[^{]*\{/g)) {
    let depth = 1;
    let start = match.index + match[0].length;
    for (let i = start; i < css.length && depth > 0; i++) {
      if (css[i] === '{') {
        if (depth === 1) found.push(...css.slice(start, i).split(',').map((selector) => selector.trim()).filter(Boolean));
        depth++;
      } else if (css[i] === '}') {
        depth--;
        if (depth === 1) start = i + 1;
      }
    }
  }
  return found;
}

/** A selector that starts at a root not marked dark, so a system's light preference never overrides a chosen Dark. */
const NOT_DARK_ROOT = /^:root:not\(\[data-theme=(["'])dark\1\]\)/;

// HTML written from a string: React's escape hatch and the DOM's.
const RAW_HTML = /dangerouslySetInnerHTML|\.(?:inner|outer)HTML\b|insertAdjacentHTML|document\.write/;

// Reading or setting credentials by hand: cookies, and the headers that carry an identity.
const CREDENTIALS =
  /document\s*\.\s*cookie|\bcookieStore\b|\bx-owner-session\b|\bx-session-token\b|['"`](?:authorization|cookie|set-cookie)['"`]|\b(?:Authorization|Cookie)\s*:/i;

// A design system component imported from its folder instead of the package index.
const DS_DEEP_IMPORT = /\bfrom\s+['"][^'"]*\bds\/components\/[^'"]*['"]|\bimport\s*\(\s*['"][^'"]*\bds\/components\//;

// Raw colors and durations: hex, the CSS color functions, and milliseconds.
const RAW_COLOR = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|\b(?:rgba?|hsla?)\(/i;
const RAW_MS = /\b\d+(?:\.\d+)?ms\b/;
const RAW_CSS_SECONDS = /(?<![\w.-])\d*\.?\d+s\b/;

// The About set's light reading style is the named exception to design system v2: the Vision article and the two
// reading pages, on a light palette of their own. Two stylesheets hold its colors, each only on its root rule: the
// set's paper, which the article and the reading pages share, and the article's own (its phones).
const VISION_ARTICLE_STYLES = 'about/vision/VisionArticle.css';
const PAPER_STYLES = 'about/paper.css';
const PALETTE_ROOTS: Record<string, string> = { [VISION_ARTICLE_STYLES]: 'vision-article', [PAPER_STYLES]: 'cd-about-paper' };
// The owner's fixed header palette mirrors the kernel's table (signed 2026-11-01).
// Only that table may contain raw colors, including its Clay accent; screens still use tokens.
const HEADER_PALETTE_FILE = 'public/palette.ts';

function withoutHeaderPalette(source: Source): Source {
  if (source.file !== HEADER_PALETTE_FILE) return source;
  const tree = ts.createSourceFile(source.file, source.text, ts.ScriptTarget.Latest, true);
  const ranges: [number, number][] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'BRAND_PALETTE' && node.initializer) {
      let value = node.initializer;
      while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) value = value.expression;
      if (ts.isObjectLiteralExpression(value)) ranges.push([value.getStart(tree), value.end]);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  let text = source.text;
  for (const [start, end] of ranges.reverse()) text = text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
  return { ...source, text };
}
// A palette's root rule, its class alone as the selector (read with comments blanked); and a custom property's
// name, which is a declaration's whole name.
const rootRule = (root: string) => new RegExp(String.raw`(?<=^|[{};])\s*\.${root}\s*\{([^{}]*)\}`, 'g');
const CUSTOM_PROPERTY_NAME = /^--[\w-]+$/;

/** Where each declaration in a rule's body starts and ends: split at semicolons outside strings and brackets. */
function declarationRanges(body: string, offset: number): [number, number][] {
  const ranges: [number, number][] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote !== null) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '(' || c === '[') {
      depth += 1;
    } else if (c === ')' || c === ']') {
      depth = Math.max(0, depth - 1);
    } else if (c === ';' && depth === 0) {
      ranges.push([offset + start, offset + i + 1]);
      start = i + 1;
    }
  }
  ranges.push([offset + start, offset + body.length]);
  return ranges;
}

/**
 * A palette's stylesheet as the color scan reads it: each declaration on the rule for its root class alone whose
 * own name is a custom property is blanked, and everything else stays, comments included. Comments are blanked
 * only to find the rule and read its declarations' names, so a name in a comment or a string never passes for one.
 */
function withoutThePalette(text: string, root: string): string {
  const code = withoutCssComments(text);
  const read = text.split('');
  for (const rule of code.matchAll(rootRule(root))) {
    const bodyStart = rule.index + rule[0].indexOf('{') + 1;
    for (const [start, end] of declarationRanges(rule[1] ?? '', bodyStart)) {
      const declaration = code.slice(start, end);
      const colon = declaration.indexOf(':');
      if (colon < 0 || !CUSTOM_PROPERTY_NAME.test(declaration.slice(0, colon).trim())) continue;
      // Outside the comments, which still count, the declaration is the palette's.
      for (let i = start; i < end; i += 1) if (code[i] === text[i]) read[i] = ' ';
    }
  }
  return read.join('');
}

/**
 * Every raw color in `scanned`, as "file: match", but the custom properties on the root rule of each palette's
 * stylesheet: those files keep their palettes there, each on its own root, and any other color in them still counts.
 */
function rawColors(scanned: Source[] = sources): string[] {
  return hits(
    RAW_COLOR,
    scanned.map(withoutHeaderPalette).map((source) => {
      const root = PALETTE_ROOTS[source.file];
      return root === undefined ? source : { ...source, text: withoutThePalette(source.text, root) };
    }),
  );
}

// A label swapped for a waiting one ("Starting…", "Sending your answer..."): a busy button keeps its words and spins.
const BUSY_LABEL = /['"`>]\s*(?!(?:Something|Nothing|Anything|Everything)\b)[A-Z][a-z]+ing\b[^'"`<>{}\n]*(?:…|\.{3})\s*(?=['"`<])/;

// One part of a JSX opening tag: a character outside braces, or a braced expression (braces nest
// two deep), so an arrow's `>` inside `onClick={() => …}` doesn't end the tag.
const TAG_PART = String.raw`(?:[^<>{}]|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})`;
// A Button busy for its own request and disabled for another's. The buttons beside a busy one wait
// (`waiting`: words shown, clicks ignored, still in the tab order); `disabled` is only for an
// action that can't be taken at all, which a button that can be pressed and spin isn't.
const BUSY_AND_DISABLED = new RegExp(String.raw`<Button\b(?=${TAG_PART}*?\sbusy=)(?=${TAG_PART}*?\sdisabled=)${TAG_PART}*>`);

// The owner sidebar's look. AppShell has had no sidebar look since #26; this keeps any page from
// passing one, even in a spread.
const SIDEBAR_LOOK = /\bsidebarLook\b/;

// Formatting money or dates: the visitor's page shows only what the kernel rendered.
const FORMATS = /\blib\/format\b|\bIntl\.|\btoLocale\w*|\bnew\s+Date\b|\btoFixed\(/;

// The checkout's one exception: `formatMoneyExact`, imported alone, for the amount with its cents.
const CHECKOUT_MONEY_IMPORT = /\bimport\s*\{\s*formatMoneyExact\s*\}\s*from\s*['"](?:\.\.\/)+lib\/format(?:\.ts)?['"]/g;

/**
 * The visitor's sources as the format guard reads them: every file under `public/`, with the
 * checkout's one allowed import taken out of the checkout's files, so anything else there still
 * shows.
 */
function visitorFormatSources(scanned: Source[]): Source[] {
  return scanned
    .filter((s) => s.file.startsWith('public/'))
    .map((s) => (s.file.startsWith('public/checkout/') ? { ...s, text: s.text.replace(CHECKOUT_MONEY_IMPORT, '') } : s));
}

// The tab's title set by hand, in any form: assigned or compound-assigned (`+=`, `||=`, `??=`), by
// name or by string key, or copied onto the document with `Object.assign`. Every page names the tab
// through one hook, which keeps the pages naming it in order, so no page leaves its name on the next.
const SETS_THE_TITLE =
  /\bdocument\s*(?:\.\s*title|\[\s*(['"`])title\1\s*\])\s*(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=(?!=)|\bObject\s*\.\s*assign\s*\(\s*document\b/;
const TITLE_HOOK_FILE = 'lib/useDocumentTitle.ts';

// A card that holds cards: the design system's one exception to "never a card in a card", for the
// agents page's "Send an agent" card, which holds the agent's run and the Desk's reply cards.
const HOLDS_CARDS = /\bholdsCards\b/;
const HOLDS_CARDS_FILE = 'public/agents/SendAgentPanel.tsx';

// An owner's reason on a receipt: the decision's `reason_plain` and the receipt props that show it
// to the owner. The visitor's page shows each receipt's `visitor_plain` and nothing else.
const OWNER_REASON = /\breason_plain\b|\breason=|\bcardBelow\b|\bowner_plain\b|\bownerPlain\b/;
// Imported aliases still name the original export; renamed wrappers still import the owner path.
const OWNER_RECEIPT_PATH = /\bApprovalCard\b|\buseOwnerReceipt\b|\b(?:from\s*|import\s*(?:\(\s*)?)['"][^'"]*\bowner\//;

// The open status: the kernel's object, passed on as it came, and its times read in one place.
const SHELL_FILE = 'ds/components/PublicShell/PublicShell.tsx';
const FALLBACK_NAME = /PlainOpenStatus/;
const OPEN_STATUS_BINDING = /\bopenStatus=(\{(?:[^{}]|\{[^{}]*\})*\}|"[^"]*"|'[^']*')/g;
const FROM_THE_HOOK = /\bconst\s*\{[^}]*\bopenStatus\b[^}]*\}\s*=\s*useOpenStatus\(|\bconst\s+openStatus\s*=\s*useOpenStatus\(/;
const OTHER_DECLARATION = /\b(?:let|var)\s+openStatus\b|\bopenStatus\s*=(?![={>])|\bfunction\s+\w*\s*\([^)]*\bopenStatus\b/;
const HOOK_ASSIGNMENT = /\bopenStatus\s*(?::\s*[^=;]+)?=(?![=>{])\s*([^;]+);/g;
const FROM_AN_ANSWER = /^(?:null|[\w.]+\.open_status \?\? null)$/;
const OPEN_AND_TEXT = /\{[^{}]*\}/g;
const STATUS_TIME = /\.(?:until|opens_at|as_of|refresh_at)\b|\[\s*['"`](?:until|opens_at|as_of|refresh_at)['"`]\s*\]|\{[^{}]*\b(?:until|opens_at|as_of|refresh_at)\b[^{}]*\}\s*=/g;

// The owner line is sourced from the visitor chat, whose mode follows the kernel session.
const VISITOR_CHAT_FILE = 'public/PublicChatProvider.tsx';
const CHAT_REDUCER_FILE = 'public/chatReducer.ts';

// The first visit's dialog: the design system's, once its index exports it, with no stand-in left.
const DS_INDEX_FILE = 'ds/index.ts';
const ARRIVAL_FILE = 'owner/Arrival.tsx';
const INTRO_FALLBACK_NAME = /PlainIntroDialog/;
const EXPORTS_INTRO_DIALOG = /\bexport\s*\{[^}]*\bIntroDialog\b[^}]*\}\s*from\b/;
const IMPORTS_INTRO_FROM_THE_INDEX = /\bimport\s*\{[^}]*\bIntroDialog\b[^}]*\}\s*from\s*['"](?:\.\.\/)+ds\/index(?:\.ts)?['"]/;

// Resource hints and speculation rules, which have a browser fetch a link before anyone clicks it
// (React DOM's own forms among them), and the path of a card's single-use document link, which no
// screen fetches or writes out: the web opens one only from the card's own link, which the visitor
// clicks. As whole words, so React Query's `prefetchQuery`, which reads the app's own data, isn't one. Nor is a
// media player's `preload="metadata"` or `preload="none"`, which reads at most the length and size of the app's
// own film, never a link.
const LINK_HINT =
  /(?<![\w-])(?:dns-prefetch|prefetch|preload(?!=["'](?:metadata|none)["'])|prerender|modulepreload|prefetchDNS|preinit|preloadModule|preinitModule)(?![\w-])|speculationrules/i;
const DOCUMENT_LINK = /\/api\/d\//i;

// An API operation's name, "GET /api/d/{token}", in capitals as the API's document writes it, names
// the route for a check, never a link. It is passed over only in the two files that list operations
// for the route checks: the generated operation list and the routes' compile-time checks.
const OPERATION_NAME = /\b(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) \/api\/d\//g;
const OPERATION_LISTS: ReadonlySet<string> = new Set(['api/openapi.gen.ts', 'api/routes.typecheck.ts']);
const listsOperations = (file: string) => OPERATION_LISTS.has(file);

/** Every document link in `scanned`, but an operation's name in a file that lists operations. */
function documentLinks(scanned: Source[]): string[] {
  return hits(
    DOCUMENT_LINK,
    scanned.map((s) => (listsOperations(s.file) ? { ...s, text: s.text.replace(OPERATION_NAME, '') } : s)),
  );
}

/** The app's page, read as the browser first gets it. */
const INDEX_HTML: Source = { file: '../index.html', text: readFileSync(path.join(SRC, '..', 'index.html'), 'utf8') };

/** Every file under `src/` but this one, by path relative to `src/`. */
function everyFileButThisOne(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .map((file) => file.split(path.sep).join('/'))
    .filter((file) => file !== 'app/guards.test.ts');
}

// The Claude Desk mark's fixed colors and its parts' classes, only in the mark's folder; clay, the
// intro illustration's field, the About app icon's field and Claude's writing dots, only in their
// allowed folders and files. Unlike the guards above, this one reads every
// text file under `src/`, the design system included, but the token sources and the tables and tests
// that list every token or prove the design system's own guards.
const MARK_PARTS = /(?<![\w-])--mark-[a-z-]*[a-z]|\bcd-mark__[a-z-]*|#d97757\b|217\s*,\s*119\s*,\s*87/i;
// Clay's token, and its dark and light themes' colors as hex and as RGB.
const CLAY_PARTS = /(?<![\w-])--clay\b|#e08968\b|224\s*,\s*137\s*,\s*104|#c4673f\b|196\s*,\s*103\s*,\s*63/i;
const MARK_FOLDER = 'ds/components/Mark/';
// Clay is the intro illustration's field and the field of the About pages' app icon, which counts as
// part of the mark (owner, 2026-10-30), plus Claude's writing dots and their story's computed color check.
const CLAY_FOLDERS = ['ds/components/IntroDialog/', MARK_FOLDER] as const;
const CLAY_FILES = ['ds/components/WritingIndicator/WritingIndicator.css', 'ds/components/WritingIndicator/WritingIndicator.stories.tsx'];
const mayUseClay = (file: string) => CLAY_FOLDERS.some((folder) => file.startsWith(folder)) || CLAY_FILES.includes(file);
const COLOR_TABLES = ['ds/tokens.json', 'ds/tokens.css', 'ds/contrast.ts', 'ds/tokens.test.ts', 'ds/guards.test.ts'];

// A JavaScript name, and a reference to one of `names`: the name itself, or a namespace's member
// (`DS.Mark`, `ui.ds.Mark`).
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const anyOf = (names: Iterable<string>) => [...names].map((name) => name.replaceAll('$', String.raw`\$`)).join('|');
const reference = (names: Iterable<string>) => String.raw`(?:${IDENT}\s*\.\s*)*(?:${anyOf(names)})(?![\w$])`;

/**
 * The names `text` can write `component` under as a JSX tag: the component, the name an import gives
 * it (`Mark as Bell`), and a local name set to any of these or to a namespace's member
 * (`const Bell = Mark;`, `const Bell = DS.Mark;`, `const { Mark: Bell } = DS;`), followed to the end.
 * A tag may also reach any of them through a namespace (`<DS.Mark>`), which `jsxTagsPassing` allows.
 */
function jsxNames(text: string, component: string): string[] {
  const names = new Set([component]);
  for (let size = 0; size !== names.size; ) {
    size = names.size;
    const ref = reference(names);
    const given = [
      new RegExp(String.raw`(?<![\w$])(?:${anyOf(names)})\s+as\s+(${IDENT})`, 'g'),
      new RegExp(String.raw`\b(?:const|let|var)\s+(${IDENT})\s*(?::[^=;]*)?=\s*${ref}(?!\s*[.(\[])`, 'g'),
      new RegExp(String.raw`\{[^{}]*(?<![\w$])(?:${anyOf(names)})\s*:\s*(${IDENT})[^{}]*\}\s*=`, 'g'),
    ];
    for (const pattern of given) for (const m of text.matchAll(pattern)) if (m[1]) names.add(m[1]);
  }
  return [...names];
}

/**
 * Each JSX opening tag of `component` (under any name `jsxNames` finds, or as a namespace's member)
 * whose props match `attribute`, as "file: tag".
 */
function jsxTagsPassing(scanned: Source[], component: string, attribute: RegExp): string[] {
  return scanned.flatMap(({ file, text }) => {
    const tag = new RegExp(String.raw`<(${reference(jsxNames(text, component))})(?![.])(${TAG_PART}*)>`, 'g');
    return [...text.matchAll(tag)].filter((m) => attribute.test(m[2] ?? '')).map((m) => `${file}: ${m[0].replace(/\s+/g, ' ')}`);
  });
}

// The mark's white tile: only the About pages' app icon draws it (owner, 2026-10-30), `MarkAppIcon`
// in the mark's own file, and the design system's stories show it. A JSX `<Mark>`, under any name it
// is given, that passes `tile`, or a spread that could carry it, counts as a use.
const MARK_TILE_FILE = 'ds/components/Mark/Mark.tsx';
const MARK_TILE_COMPONENT = 'MarkAppIcon';
const TILE_ATTRIBUTE = /\stile\b|\{\s*\.\.\./;

/** Each `<Mark …>` opening tag in a source that passes `tile` or spreads its props, as "file: tag". */
function markTiles(scanned: Source[]): string[] {
  return jsxTagsPassing(scanned, 'Mark', TILE_ATTRIBUTE);
}

/** The files that may draw the mark's tile: the app icon's file, and the design system's stories. */
function mayDrawTheMarkTile(file: string): boolean {
  return file === MARK_TILE_FILE || (file.startsWith('ds/') && /\.stories\.tsx$/.test(file));
}

// The lockup's Preview badge, the product's one all-caps label (owner, 2026-10-30): a Pill with `caps`,
// which only the Wordmark draws. A JSX `<Pill>`, under any name it is given, that passes `caps`, or a
// spread that could carry it, counts as a use. Outside the design system, which guards its own files,
// only tests may name the badge's type style or the marker the copy check allows capitals on.
const WORDMARK_FILE = 'ds/components/Mark/Mark.tsx';
const CAPS_ATTRIBUTE = /\scaps\b|\{\s*\.\.\./;
const CAPS_BADGE_NAMES = /badge-caps|preview-badge/;

/** Each `<Pill …>` opening tag in a source that passes `caps` or spreads its props, as "file: tag". */
function pillCaps(scanned: Source[]): string[] {
  return jsxTagsPassing(scanned, 'Pill', CAPS_ATTRIBUTE);
}

/** Every text file under `src/` but this one and the color tables, read. */
function everyTextFile(): Source[] {
  return everyFileButThisOne()
    .filter((file) => /\.(tsx?|css|json|md|html|svg|mjs)$/.test(file) && !COLOR_TABLES.includes(file))
    .sort()
    .map((file) => ({ file, text: readFileSync(path.join(SRC, file), 'utf8') }));
}

/** Files under `src/` named after the stand-in, or whose code mentions it. */
function introFallbacks(files: string[], read: (file: string) => string): string[] {
  const named = files.filter((file) => INTRO_FALLBACK_NAME.test(file));
  const mentioned = files.filter((file) => /\.(tsx?|css)$/.test(file) && INTRO_FALLBACK_NAME.test(read(file)));
  return [...new Set([...named, ...mentioned])];
}

/** Whether PublicShell's props declare the `openStatus` slot. */
function declaresOpenStatus(shell: string): boolean {
  const props = /export interface PublicShellProps\s*\{([\s\S]*?)\n\}/.exec(shell)?.[1] ?? '';
  return /^\s*openStatus\??\s*:/m.test(props);
}

/** The [start, end) of `name`'s body in `text`, or null when it isn't declared there. */
function functionBody(text: string, name: string): [number, number] | null {
  const head = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(text);
  if (!head) return null;
  const open = text.indexOf('{', text.indexOf(')', head.index));
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && (depth -= 1) === 0) return [open, i + 1];
  }
  return null;
}

/** The two helpers that may read a time the kernel or the API sent: each schedules what the page does next. */
const TIME_HELPERS = ['openStatusDelayMs', 'ownerTypingDelayMs'] as const;

/** Reads of an open status's or a typing event's times outside `TIME_HELPERS`. */
function timeReadsOutsideTheHelper(scanned: Source[]): string[] {
  return scanned.flatMap(({ file, text }) => {
    const bodies = TIME_HELPERS.map((name) => functionBody(text, name)).filter((body) => body !== null);
    return [...text.matchAll(STATUS_TIME)]
      .filter((m) => !bodies.some(([start, end]) => m.index >= start && m.index < end))
      .map((m) => `${file}: ${m[0]}`);
  });
}

/** `lib/` modules the visitor's code imports, from any folder under `public/`: they run on the visitor's page too. */
const LIB_IMPORT = /\bfrom\s+['"](?:\.\.\/)+lib\/([\w.-]+)['"]/g;
function libModulesOf(visitor: Source[], all: Source[] = sources): Source[] {
  const files = new Set(visitor.flatMap(({ text }) => [...text.matchAll(LIB_IMPORT)].map((m) => `lib/${m[1]}`)));
  return all.filter((s) => files.has(s.file));
}

/** Owner annotations and owner-only rendering paths in visitor code and its library modules. */
function ownerReasonLeaks(scanned: Source[]): string[] {
  return [...hits(OWNER_REASON, scanned), ...hits(OWNER_RECEIPT_PATH, scanned)];
}

/** Object literals (or types) that pair `open:` with `text:`: an open status the page made itself. */
function madeUpStatuses(scanned: Source[]): string[] {
  return scanned.flatMap(({ file, text }) =>
    [...text.matchAll(OPEN_AND_TEXT)].filter((m) => /\bopen\s*:/.test(m[0]) && /\btext\s*:/.test(m[0])).map((m) => `${file}: ${m[0]}`),
  );
}

/** `openStatus=` bindings whose value isn't the hook's `openStatus`, or files where that name comes from anywhere else. */
function bindingsNotFromTheHook(scanned: Source[]): string[] {
  return scanned.flatMap(({ file, text }) => {
    const bindings = [...text.matchAll(OPEN_STATUS_BINDING)].map((m) => m[1] ?? '');
    if (bindings.length === 0) return [];
    const bad = bindings.filter((value) => value !== '{openStatus}').map((value) => `${file}: openStatus=${value}`);
    if (!FROM_THE_HOOK.test(text)) bad.push(`${file}: openStatus doesn't come from useOpenStatus`);
    if (OTHER_DECLARATION.test(text)) bad.push(`${file}: openStatus is declared or assigned elsewhere`);
    return bad;
  });
}

/** The index just past the brace, bracket or parenthesis that closes the one at `open` in `code`. */
function pastTheClose(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i] ?? '';
    if ('{[('.includes(c)) depth += 1;
    else if ('}])'.includes(c) && (depth -= 1) === 0) return i + 1;
  }
  return code.length;
}

/** The expression that starts at `start` in `code`: up to the first `,`, `;`, closing brace or line end outside brackets. */
function expressionAt(code: string, start: number): string {
  let i = start;
  while (i < code.length && !',;}\n'.includes(code[i] ?? '')) i = '{[('.includes(code[i] ?? '') ? pastTheClose(code, i) : i + 1;
  return code.slice(start, i).trim();
}

/** Parse the syntax React actually accepts, including factory calls and nested JSX props. */
function syntax(text: string): ts.SourceFile {
  return ts.createSourceFile('guard.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function nodes(root: ts.Node): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function unwrapped(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return node;
}

function keyName(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  if (ts.isComputedPropertyName(node)) return keyName(node.expression);
  return undefined;
}

function memberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return keyName(node.argumentExpression);
  return undefined;
}

function assignment(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
}

const compact = (node: ts.Node): string => node.getText().replace(/\s+/g, ' ');

/** Resolve imports and const aliases in their lexical scopes, including destructured namespaces. */
function symbols(root: ts.SourceFile): (expression: ts.Expression) => string {
  type Binding = string | { expression: ts.Expression; member?: string };
  const scopes = new Map<ts.Node, Map<string, Binding>>();
  const scopeOf = (node: ts.Node): ts.Node => {
    while (!ts.isSourceFile(node) && !ts.isBlock(node) && !ts.isFunctionLike(node)) node = node.parent;
    return node;
  };
  const bind = (node: ts.Node, name: string, value: Binding): void => {
    const scope = scopeOf(node);
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    scopes.get(scope)?.set(name, value);
  };
  for (const node of nodes(root)) {
    if (ts.isImportSpecifier(node)) bind(root, node.name.text, (node.propertyName ?? node.name).text);
    if (ts.isNamespaceImport(node)) bind(root, node.name.text, node.name.text);
    if (ts.isImportClause(node) && node.name) bind(root, node.name.text, node.name.text);
    if (!ts.isVariableDeclaration(node) || !node.initializer || !ts.isVariableDeclarationList(node.parent) || !(node.parent.flags & ts.NodeFlags.Const)) continue;
    if (ts.isIdentifier(node.name)) bind(node.parent, node.name.text, { expression: node.initializer });
    if (ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        if (ts.isIdentifier(element.name) && !element.dotDotDotToken) bind(node.parent, element.name.text, { expression: node.initializer, member: keyName(element.propertyName ?? element.name) });
      }
    }
  }
  const knownMember = (base: string, member: string): string =>
    ['PublicShell', 'createElement', 'jsx', 'jsxs', 'jsxDEV'].includes(member) ? member : `${base}.${member}`;
  const resolve = (expression: ts.Expression, seen = new Set<Binding>()): string => {
    const node = unwrapped(expression);
    if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
    if (ts.isIdentifier(node)) {
      for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
        const binding = scopes.get(at)?.get(node.text);
        if (binding === undefined) continue;
        if (typeof binding === 'string') return binding;
        if (seen.has(binding)) return '';
        const nextSeen = new Set([...seen, binding]);
        const base = resolve(binding.expression, nextSeen);
        return binding.member ? knownMember(base, binding.member) : base;
      }
      return node.text;
    }
    const member = memberName(node);
    if (member && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) return knownMember(resolve(node.expression, seen), member);
    return '';
  };
  return resolve;
}

/** Every route by which a page could give PublicShell an independently derived owner line. */
function ownerInChatNotFromTheChat(scanned: Source[]): string[] {
  return scanned.flatMap(({ file, text }) => {
    const root = syntax(text);
    const all = nodes(root);
    const resolve = symbols(root);
    const spreads: string[] = [];
    const factories: string[] = [];
    const fields: string[] = [];
    const writes: string[] = [];
    const props: string[] = [];
    let ownerProps = 0;
    for (const node of all) {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && resolve(node.tagName as ts.Expression) === 'PublicShell') {
        for (const prop of node.attributes.properties) if (ts.isJsxSpreadAttribute(prop)) spreads.push(`${file}: PublicShell takes a spread: ${compact(prop)}`);
      }
      if (ts.isCallExpression(node) && ['createElement', 'jsx', 'jsxs', 'jsxDEV'].includes(resolve(node.expression)) && node.arguments[0] && resolve(node.arguments[0]) === 'PublicShell') {
        factories.push(`${file}: PublicShell made with ${resolve(node.expression)}(${compact(node.arguments[0])}`);
      }
      if ((ts.isPropertyAssignment(node) || ts.isPropertySignature(node)) && keyName(node.name) === 'ownerInChat') {
        const quoted = ts.isStringLiteral(node.name);
        if (file !== VISITOR_CHAT_FILE || quoted) {
          const value = ts.isPropertyAssignment(node) ? node.initializer : node.type;
          fields.push(`${file}: ${quoted ? node.name.getText() : 'ownerInChat'}: ${value ? compact(value) : ''}`);
        }
      }
      if (assignment(node) && memberName(node.left) === 'ownerInChat') writes.push(`${file}: ${compact(node.left)} ${node.operatorToken.getText()} ${compact(node.right)}`);
      if (ts.isBindingElement(node) && keyName(node.propertyName ?? node.name) === 'ownerInChat') props.push(`${file}: ownerInChat`);
      if (ts.isJsxAttribute(node) && keyName(node.name) === 'ownerInChat') {
        ownerProps += 1;
        const value = node.initializer;
        if (!value || !ts.isJsxExpression(value) || !value.expression || compact(value.expression) !== 'chat.ownerInChat') props.push(`${file}: ${compact(node)}`);
      }
    }
    if (ownerProps > 0) {
      const declarations = all.filter(ts.isVariableDeclaration).filter((node) => keyName(node.name) === 'chat');
      const hook = declarations.some((node) => node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'useVisitorChat');
      if (!hook) props.push(`${file}: chat doesn't come from useVisitorChat`);
      const assigned = all.filter(assignment).filter((node) => ts.isIdentifier(node.left) && node.left.text === 'chat');
      const other = declarations.some((node) => !ts.isVariableDeclarationList(node.parent) || !(node.parent.flags & ts.NodeFlags.Const)) || all.some((node) => ts.isParameter(node) && keyName(node.name) === 'chat');
      if (declarations.length + assigned.length !== 1 || other) props.push(`${file}: chat is declared or assigned elsewhere`);
    }
    return [...spreads, ...factories, ...fields, ...writes, ...props];
  });
}

/** Public files and every other TypeScript file that references PublicShell, including imports. */
function shellFiles(all: Source[]): Source[] {
  return all.filter(({ file, text }) => /\.tsx?$/.test(file) && (file.startsWith('public/') || nodes(syntax(text)).some((node) => ts.isIdentifier(node) && node.text === 'PublicShell')));
}

/** The enclosing method, excluding nested functions that do not inherit its authority. */
function enclosingMethod(node: ts.Node): ts.MethodDeclaration | undefined {
  for (let at = node.parent; at; at = at.parent) {
    if (ts.isMethodDeclaration(at)) return at;
    if (ts.isFunctionLike(at)) return undefined;
  }
  return undefined;
}

function methodBody(code: string, name: string): [number, number] | null {
  const method = nodes(syntax(code)).find((node) => ts.isMethodDeclaration(node) && keyName(node.name) === name);
  return method && ts.isMethodDeclaration(method) && method.body ? [method.body.getStart(), method.body.end] : null;
}

/** A condition is required only when it is a conjunct, never an alternative way through a guard. */
function conjuncts(expression: ts.Expression): ts.Expression[] {
  const node = unwrapped(expression);
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? [...conjuncts(node.left), ...conjuncts(node.right)] : [node];
}

/** Compare syntax, so comments, whitespace and parentheses cannot affect a guard. */
function sameExpression(node: ts.Expression, expected: string): boolean {
  const compare = (left: ts.Node, right: ts.Node): boolean => {
    if (ts.isParenthesizedExpression(left)) return compare(left.expression, right);
    if (ts.isParenthesizedExpression(right)) return compare(left, right.expression);
    if (left.kind !== right.kind) return false;
    if (ts.isIdentifier(left) || ts.isStringLiteral(left)) return (right as ts.Identifier | ts.StringLiteral).text === left.text;
    const children = (parent: ts.Node): ts.Node[] => {
      const result: ts.Node[] = [];
      ts.forEachChild(parent, (child) => { result.push(child); });
      return result;
    };
    const a = children(left);
    const b = children(right);
    return a.length === b.length && a.every((child, i) => b[i] !== undefined && compare(child, b[i]));
  };
  const statement = syntax(`(${expected});`).statements[0];
  return !!statement && ts.isExpressionStatement(statement) && compare(node, statement.expression);
}

/** Required positive conditions enclosing this node's execution in the same method. */
function guardedBy(node: ts.Node, required: string[]): boolean {
  const conditions: ts.Expression[] = [];
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) break;
    if (ts.isIfStatement(parent) && parent.thenStatement === child) conditions.push(...conjuncts(parent.expression));
  }
  return required.every((condition) => conditions.some((candidate) => sameExpression(candidate, condition)));
}

/** Session writes and the only places allowed to raise mode or its confirmation. */
function sessionModeWrites(chat: string): string[] {
  const root = syntax(chat);
  const all = nodes(root);
  const resolve = symbols(root);
  const bad: string[] = [];
  const methodOf = (node: ts.Node) => keyName(enclosingMethod(node)?.name);
  for (const node of all) {
    if (ts.isCallExpression(node) && resolve(node.expression) === 'this.openedSession') {
      const method = methodOf(node);
      const current = method === 'confirmMode' && guardedBy(node, [
        'since === this.tracked',
        'transcript.last_seq >= this.modeAt',
        'transcript.state.generation >= this.sessionGeneration',
      ]);
      if (method !== 'open' && !current) bad.push(`${VISITOR_CHAT_FILE}: openedSession outside open or a current confirming read`);
    }
    if (assignment(node) && memberName(node.left) === 'modeKnown' && unwrapped(node.right).kind === ts.SyntaxKind.TrueKeyword) {
      const method = methodOf(node);
      const allowed = method === 'openedSession'
        || (method === 'laterRead' && guardedBy(node, ['following', 'since === this.tracked']))
        || (method === 'followMode' && guardedBy(node, ['!state.catchingUp']));
      if (!allowed) bad.push(`${VISITOR_CHAT_FILE}: modeKnown raised outside its guarded confirmation paths`);
    }
    if (ts.isCallExpression(node) && sameExpression(node.expression, 'this.set')) {
      for (const key of node.arguments.flatMap(nodes)) {
        if (ts.isShorthandPropertyAssignment(key) && key.name.text === 'session') bad.push(`${VISITOR_CHAT_FILE}: session (shorthand)`);
        if (!ts.isPropertyAssignment(key) || keyName(key.name) !== 'session') continue;
        const value = unwrapped(key.initializer);
        const helper = ts.isCallExpression(value) && ['this.openedSession', 'this.laterSession', 'this.laterRead'].includes(resolve(value.expression));
        const follow = methodOf(key) === 'followMode' && ts.isObjectLiteralExpression(value) && value.properties.length === 2 && ts.isSpreadAssignment(value.properties[0]!) && sameExpression(value.properties[0]!.expression, 'session') && ts.isShorthandPropertyAssignment(value.properties[1]!) && value.properties[1]!.name.text === 'mode';
        if (value.kind !== ts.SyntaxKind.NullKeyword && !helper && !follow) bad.push(`${VISITOR_CHAT_FILE}: session: ${compact(value)}`);
      }
    }
    const property = (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && keyName(node.name) === 'mode';
    const assigned = assignment(node) && memberName(node.left) === 'mode';
    if ((property || assigned) && !['openedSession', 'followMode'].includes(methodOf(node) ?? '')) {
      const lowering = ts.isPropertyAssignment(node) && ts.isCallExpression(node.initializer) && sameExpression(node.initializer.expression, 'lowerOnly');
      if (!lowering) {
        const write = assigned ? `${ts.isElementAccessExpression(node.left) ? node.left.getText().slice(node.left.expression.end - node.left.getStart()) : '.mode'} ${node.operatorToken.getText()}` : ts.isShorthandPropertyAssignment(node) ? ', mode' : ts.isPropertyAssignment(node) ? `${node.name.getText()}:` : '';
        bad.push(`${VISITOR_CHAT_FILE}: sets the mode outside the open path and followMode: ${write}`);
      }
    }
    if (ts.isStringLiteral(node) && node.text === 'owner' && methodOf(node) === 'followMode') {
      const parent = node.parent;
      if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(parent.operatorToken.kind)) continue;
      if (!ts.isConditionalExpression(parent) || parent.whenTrue !== node || !sameExpression(parent.condition, "ev.type === 'owner_joined'")) bad.push(`${VISITOR_CHAT_FILE}: followMode sets the owner's mode for something but owner_joined`);
    }
  }
  return bad;
}

/** Values attached to the owner flag; object and interface declarations are distinct AST nodes. */
function ownerInChatNodes(chat: string): (ts.PropertyAssignment | ts.PropertySignature)[] {
  return nodes(syntax(chat)).filter((node): node is ts.PropertyAssignment | ts.PropertySignature => (ts.isPropertyAssignment(node) || ts.isPropertySignature(node)) && keyName(node.name) === 'ownerInChat');
}

function anotherYes(root: ts.Node): boolean {
  return nodes(root).some((node) => node.kind === ts.SyntaxKind.TrueKeyword || ts.isConditionalExpression(node) || (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)));
}

function ownerInChatSources(chat: string, reducer: string): string[] {
  const bad = ownerInChatNodes(chat).flatMap((node) => {
    if (ts.isPropertySignature(node) && node.type?.kind === ts.SyntaxKind.BooleanKeyword) return [];
    const value = ts.isPropertyAssignment(node) ? unwrapped(node.initializer) : undefined;
    if (value && (value.kind === ts.SyntaxKind.FalseKeyword || (ts.isCallExpression(value) && sameExpression(value.expression, 'ownerInChatNow') && !anotherYes(value)))) return [];
    return [`${VISITOR_CHAT_FILE}: ownerInChat: ${value ? compact(value) : ts.isPropertySignature(node) ? node.type?.getText() ?? '' : ''}`];
  });
  const fn = nodes(syntax(reducer)).find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'ownerInChatNow');
  const returned = fn && ts.isFunctionDeclaration(fn) && fn.body ? nodes(fn.body).filter(ts.isReturnStatement).flatMap((node) => node.expression ? [node.expression] : []) : [];
  if (!returned.length || !returned.every((value) => conjuncts(value).some((part) => sameExpression(part, "session?.mode === 'owner'")))) bad.push(`${CHAT_REDUCER_FILE}: ownerInChatNow doesn't read the session's mode`);
  else if (returned.some(anotherYes)) bad.push(`${CHAT_REDUCER_FILE}: ownerInChatNow has another way to say yes`);
  return bad;
}

/** Assignments to `openStatus` in the hook whose value isn't an answer's `.open_status` or null. */
function hookAssignments(text: string): { all: string[]; bad: string[] } {
  const all = [...text.matchAll(HOOK_ASSIGNMENT)].map((m) => (m[1] ?? '').trim());
  return { all, bad: all.filter((value) => !FROM_AN_ANSWER.test(value)) };
}

describe('app source guards', () => {
  beforeAll(() => {
    // The scan reaches the app and skips what it exempts, or every guard below fails.
    const files = sources.map((s) => s.file);
    expect(files).toContain('api/http.ts');
    expect(files).toContain('app/App.tsx');
    expect(files.some((f) => f.startsWith('ds/') || f.startsWith('mocks/') || f.includes('.test.'))).toBe(false);
  });

  it('no_dangerously_set_inner_html', () => {
    expect(hits(RAW_HTML, sample('<div dangerouslySetInnerHTML={{ __html: x }} />; el.innerHTML = y;'))).toHaveLength(2);
    expect(hits(RAW_HTML)).toEqual([]);
  });

  it('no_cookie_or_auth_header_access', () => {
    const bad = [
      'document.cookie',
      "headers: { 'X-Owner-Session': t }",
      "h.set('X-Session-Token', t)",
      "h.set('Authorization', t)",
      "{ Authorization: 'Bearer x' }",
      "h.append('cookie', c)",
    ];
    for (const text of bad) expect(hits(CREDENTIALS, sample(text)), text).toHaveLength(1);
    expect(hits(CREDENTIALS)).toEqual([]);
  });

  it('screens_import_ui_only_from_the_ds_index', () => {
    expect(hits(DS_DEEP_IMPORT, sample("import { Button } from '../ds/components/Button/Button.tsx';"))).toHaveLength(1);
    expect(hits(DS_DEEP_IMPORT, sample("import { Button } from '../ds/index.ts';"))).toEqual([]);
    expect(hits(DS_DEEP_IMPORT)).toEqual([]);
  });

  it('no_raw_colors_or_durations_in_screens', () => {
    const bad = sample("color: #1c1b19; background: rgb(0 0 0); fill: hsl(0 0% 0%); setTimeout(f, 200); transition: opacity 150ms;");
    expect(hits(RAW_COLOR, bad)).toHaveLength(3);
    expect(hits(RAW_MS, bad)).toHaveLength(1);
    expect(hits(RAW_CSS_SECONDS, [{ file: 'x.css', text: 'transition: opacity .2s; gap: var(--space-2s);' }])).toHaveLength(1);

    // The Vision article's stylesheet and the About set's paper, and no other file, may hold colors, and only as
    // custom properties on their own root rule. A neighbour holding the same palette is caught: the article's own
    // code, a sibling stylesheet, the reading pages' and the vision pages' styles, and a path that only ends the
    // same way.
    const palette = '.vision-article {\n  --va-paper: #F4F2EC;\n  --va-line: rgba(28, 27, 25, 0.13);\n}';
    expect(rawColors([{ file: VISION_ARTICLE_STYLES, text: palette }])).toEqual([]);
    const paper = '.cd-about-paper {\n  --va-paper: #F4F2EC;\n  --va-line: rgba(28, 27, 25, 0.13);\n}';
    expect(rawColors([{ file: PAPER_STYLES, text: paper }])).toEqual([]);
    // Each file only on its own root: the paper's root in the article's stylesheet, or the article's in the
    // paper's, is a neighbour too.
    expect(rawColors([{ file: VISION_ARTICLE_STYLES, text: paper }])).toEqual([`${VISION_ARTICLE_STYLES}: #F4F2EC`, `${VISION_ARTICLE_STYLES}: rgba(`]);
    expect(rawColors([{ file: PAPER_STYLES, text: palette }])).toEqual([`${PAPER_STYLES}: #F4F2EC`, `${PAPER_STYLES}: rgba(`]);
    // In the paper, the rule that points the app's tokens at the palette holds no color of its own, and neither
    // does a rule under or beside the root.
    for (const text of [
      '.cd-about-paper--app { --bg-app: #F4F2EC; }',
      '.cd-about-paper .cd-card { --va-ink: #F4F2EC; }',
      '.cd-about-paper, .cd-card { --va-ink: #F4F2EC; }',
      '.cd-about-paper { background: #F4F2EC; }',
    ]) {
      expect(rawColors([{ file: PAPER_STYLES, text }]), text).toEqual([`${PAPER_STYLES}: #F4F2EC`]);
    }
    for (const file of ['about/reader.css', 'about/Paper.css', 'about/vision/paper.css', 'xabout/paper.css']) {
      expect(rawColors([{ file, text: paper }]), file).toEqual([`${file}: #F4F2EC`, `${file}: rgba(`]);
    }
    // A custom property after a comment, as the stylesheet writes its groups, is one too.
    const grouped = '/* The page. */\n.vision-article {\n  /* The ground. */\n  --va-paper: #F4F2EC;\n  color: var(--va-ink);\n}';
    expect(rawColors([{ file: VISION_ARTICLE_STYLES, text: grouped }])).toEqual([]);
    const neighbours = ['about/vision/VisionArticle.tsx', 'about/vision/Screens.css', 'about/reader.css', 'vision/Vision.css', 'xabout/vision/VisionArticle.css'];
    for (const file of neighbours) {
      expect(rawColors([{ file, text: palette }]), file).toEqual([`${file}: #F4F2EC`, `${file}: rgba(`]);
    }
    // In the stylesheet itself, a color anywhere else still counts: a plain declaration on the root, a custom
    // property on another rule or on a list or descendant selector that names the root, and a comment.
    const stray = [
      '.vision-article { color: #1C1B19; }',
      '.vision-article .va-bar { --va-ink: #1C1B19; }',
      '.vision-article, .va-bar { --va-ink: #1C1B19; }',
      '.va-bar .vision-article { --va-ink: #1C1B19; }',
      '/* #1C1B19 */ .vision-article { --va-ink: var(--va-paper); }',
    ];
    for (const text of stray) expect(rawColors([{ file: VISION_ARTICLE_STYLES, text }]), text).toEqual([`${VISION_ARTICLE_STYLES}: #1C1B19`]);
    // Only a declaration whose own name is a custom property is one: not a plain declaration with a custom
    // property's name in a comment or a string, before it or inside it.
    const posing = [
      '.vision-article { color: /* --x: */ #123456; }',
      '.vision-article { background: url("--x:") #123456; }',
      '.vision-article { /* --x: */ color: #123456; }',
    ];
    for (const text of posing) expect(rawColors([{ file: VISION_ARTICLE_STYLES, text }]), text).toEqual([`${VISION_ARTICLE_STYLES}: #123456`]);
    // Its durations are read as anywhere else.
    const timed = [{ file: VISION_ARTICLE_STYLES, text: '.vision-article { --va-fade: 150ms; transition: opacity .2s; }' }];
    expect(hits(RAW_MS, timed)).toHaveLength(1);
    expect(hits(RAW_CSS_SECONDS, timed)).toHaveLength(1);

    const headerPalette = {
      file: HEADER_PALETTE_FILE,
      text: "export const BRAND_PALETTE = { clay: { primary: '#773624', accent: '#D97757' } } as const satisfies Record<BrandPalette, object>; const other = '#123456';",
    };
    expect(rawColors([headerPalette])).toEqual([`${HEADER_PALETTE_FILE}: #123456`]);
    expect(hits(MARK_PARTS, [withoutHeaderPalette(headerPalette)])).toEqual([]);
    expect(hits(MARK_PARTS, [withoutHeaderPalette({ ...headerPalette, text: `${headerPalette.text} const stray = '#D97757';` })])).toEqual([`${HEADER_PALETTE_FILE}: #D97757`]);
    expect(rawColors([{ ...headerPalette, file: 'owner/settings/HeaderColourCard.tsx' }])).toHaveLength(3);

    expect(rawColors()).toEqual([]);
    expect(hits(RAW_MS)).toEqual([]);
    expect(hits(RAW_CSS_SECONDS, sources.filter((s) => s.file.endsWith('.css')))).toEqual([]);
  });

  it('busy_buttons_keep_their_words', () => {
    const bad = [
      "<Button busy={busy}>{busy ? 'Starting…' : 'Start the demo'}</Button>",
      '<Button variant="primary">Sending...</Button>',
      'const label = pending ? `Sending your answer…` : `Allow this time`;',
      '<Button>Saving…</Button>',
      '<Button>Checking…</Button>',
    ];
    for (const text of bad) expect(hits(BUSY_LABEL, sample(text)), text).toHaveLength(1);
    const fine = [
      "<Button {...props} busy={busy}>Start the demo</Button>; const rows = [...all]; // GET …/briefing\n<TextField placeholder='Type a message…' />",
      "'Something else…'",
      "'Nothing…'",
      "'Anything…'",
      "'Everything…'",
    ].join('\n');
    expect(hits(BUSY_LABEL, sample(fine))).toEqual([]);
    expect(hits(BUSY_LABEL)).toEqual([]);
  });

  it('buttons_beside_a_busy_one_wait', () => {
    const bad = [
      '<Button variant="secondary" busy={joining} disabled={closing} onClick={() => void join()}>',
      '<Button\n  variant="ghost"\n  busy={chat.cancelling === id}\n  disabled={chat.cancelling !== null && chat.cancelling !== id}\n  onClick={() => chat.cancel(id)}\n>',
      '<Button disabled={saving} variant="ghost" onClick={() => run({ x: { y: 1 } })} busy={sending}>',
    ];
    for (const text of bad) expect(hits(BUSY_AND_DISABLED, sample(text)), text).toHaveLength(1);
    const fine = [
      '<Button variant="secondary" busy={joining} waiting={closing} onClick={() => void join()}>Join the chat</Button>',
      '<Button variant="ghost" disabled={!ready}>Send</Button>',
      '<Composer busy={sending} disabled={!ready} />',
      '<Button variant="ghost" busy={busy} onClick={() => setOptions({ x: { disabled: true } })}>Review</Button>\n<TextField disabled={locked} />',
    ].join('\n');
    expect(hits(BUSY_AND_DISABLED, sample(fine))).toEqual([]);
    expect(hits(BUSY_AND_DISABLED)).toEqual([]);
  });

  it('no_page_sets_the_sidebar_look', () => {
    // The owner's decision: the sidebar looks the same on every owner page. AppShell has taken no
    // `sidebarLook` since #26, and no file outside the design system passes one, tests and the mock
    // included, even in a spread.
    expect(hits(SIDEBAR_LOOK, sample('<AppShell sidebar={sidebar} sidebarLook="ground">'))).toHaveLength(1);
    expect(hits(SIDEBAR_LOOK, sample("<AppShell {...{ sidebarLook: 'panel' }} />"))).toHaveLength(1);
    expect(hits(SIDEBAR_LOOK, sample('<AppShell sidebar={sidebar} business={name}>'))).toEqual([]);
    const outsideTheDs = everyFileButThisOne()
      .filter((file) => /\.(tsx?|css)$/.test(file) && !file.startsWith('ds/'))
      .map((file) => ({ file, text: readFileSync(path.join(SRC, file), 'utf8') }));
    expect(outsideTheDs.map((s) => s.file)).toContain('owner/OwnerLayout.tsx');
    expect(hits(SIDEBAR_LOOK, outsideTheDs)).toEqual([]);
  });

  it('visitor_code_never_formats_money_or_dates', () => {
    const bad = "import { formatCents } from '../lib/format.ts'; new Intl.NumberFormat(); d.toLocaleString(); new Date(); n.toFixed(2);";
    expect(hits(FORMATS, sample(bad))).toHaveLength(5);

    // The checkout may import `formatMoneyExact` for the amount with its cents, and nothing else:
    // no other part of `lib/format`, no dates and no Intl.
    const checkout = (text: string) => visitorFormatSources([{ file: 'public/checkout/CheckoutPage.tsx', text }]);
    expect(hits(FORMATS, checkout("import { formatMoneyExact } from '../../lib/format.ts';"))).toEqual([]);
    expect(hits(FORMATS, checkout("import { formatMoneyExact, formatClock } from '../../lib/format.ts';"))).toHaveLength(1);
    expect(hits(FORMATS, checkout("import * as format from '../../lib/format.ts';"))).toHaveLength(1);
    expect(hits(FORMATS, checkout("import { formatMoneyExact } from '../../lib/format.ts';\nconst at = new Date(); new Intl.DateTimeFormat('en');"))).toHaveLength(2);
    // Anywhere else on the visitor's page, that import is a hit too.
    expect(hits(FORMATS, visitorFormatSources([{ file: 'public/PublicChat.tsx', text: "import { formatMoneyExact } from '../lib/format.ts';" }]))).toHaveLength(1);

    const visitor = visitorFormatSources(sources);
    expect(visitor.map((s) => s.file)).toContain('public/checkout/CheckoutPage.tsx');
    expect(hits(FORMATS, visitor)).toEqual([]);
  });

  it('only_the_title_hook_names_the_tab', () => {
    const bad = [
      "document.title = 'Today · Claude Desk';",
      'document . title=name;',
      "document['title'] = name;",
      'document["title"] += " · Claude Desk";',
      'document[`title`] = name;',
      'document.title ||= name;',
      'document.title ??= name;',
      'Object.assign(document, { title: name });',
    ];
    for (const text of bad) expect(hits(SETS_THE_TITLE, sample(text)), text).toHaveLength(1);
    const fine =
      "const before = document.title; if (document.title === x || document['title'] !== y) useDocumentTitle('Today'); Object.assign(target, document); title = 'x';";
    expect(hits(SETS_THE_TITLE, sample(fine))).toEqual([]);

    // Every file under src/ that runs, the design system's, the mock's and the test helpers' included.
    // Tests are left out: they set the title to check what a page does with it.
    const running = everyFileButThisOne()
      .filter((file) => /\.(tsx?|m?js)$/.test(file) && !/\.test\.tsx?$/.test(file))
      .map((file) => ({ file, text: readFileSync(path.join(SRC, file), 'utf8') }));
    const files = running.map((s) => s.file);
    for (const file of [TITLE_HOOK_FILE, 'ds/components/Sidebar/Sidebar.tsx', 'ds/boards/parts.tsx', 'mocks/store.ts', 'test/renderRoute.tsx']) {
      expect(files, file).toContain(file);
    }
    // The matcher finds the hook's own writes, and none anywhere else.
    expect(hits(SETS_THE_TITLE, running.filter(({ file }) => file === TITLE_HOOK_FILE)).length).toBeGreaterThan(0);
    expect(hits(SETS_THE_TITLE, running.filter(({ file }) => file !== TITLE_HOOK_FILE))).toEqual([]);
  });

  it('only_the_send_agent_panel_holds_cards', () => {
    expect(hits(HOLDS_CARDS, sample('<Card as="section" label="Send an agent" holdsCards>{run}</Card>'))).toHaveLength(1);
    expect(hits(HOLDS_CARDS, sample('<Card as="section" label="Send an agent">{run}</Card>; const holdsCardsLike = 1;'))).toEqual([]);
    // Allowed in the design system, which these sources leave out, and in the panel the exception is for.
    expect(sources.some(({ file }) => file.startsWith('ds/'))).toBe(false);
    expect(hits(HOLDS_CARDS, sources.filter(({ file }) => file !== HOLDS_CARDS_FILE))).toEqual([]);
  });

  it('document_links_are_never_prefetched', () => {
    // The matchers, on known samples first.
    const bad = [
      '<link rel="prefetch" href="/api/d/tok" />',
      "link.rel = 'preload';",
      '<link rel="prerender" href="/d/rivera">',
      '<link rel="dns-prefetch" href="//desk.example">',
      '<script type="speculationrules">{}</script>',
      "import { prefetchDNS } from 'react-dom';",
      '<link rel="modulepreload" href="/x.js">',
      "import { preinit } from 'react-dom';",
      'ReactDOM.preloadModule(href);',
      'preinitModule(href, { as: "script" });',
    ];
    for (const text of bad) expect(hits(LINK_HINT, sample(text)), text).toHaveLength(1);
    expect(hits(LINK_HINT, sample('queryClient.prefetchQuery(desksQuery()); // a link never prefetched, preloaded or preinitialised'))).toEqual([]);
    expect(hits(LINK_HINT, sample('<video poster={poster} controls preload="metadata">'))).toEqual([]);
    expect(hits(LINK_HINT, sample("<audio preload='none' />"))).toEqual([]);
    for (const text of ['<video preload="auto">', 'link.rel = "preload";', '<video preload>']) expect(hits(LINK_HINT, sample(text)), text).toHaveLength(1);
    expect(documentLinks(sample("fetch(`/api/d/${token}`); const href = '/API/d/x';"))).toHaveLength(2);
    expect(documentLinks(sample("request('paymentLink', { params: { token } }); const page = '/d/rivera';"))).toEqual([]);
    // A link built any other way is one too: a whole address, or a path joined to a token.
    expect(documentLinks(sample("const a = 'https://desk.example/api/d/tok'; const b = '/api/d/' + token; const c = `${origin}/api/d/${t}`;"))).toHaveLength(3);
    // An API operation's name, "GET /api/d/{token}", written as the generated operation list and the
    // compile-time route checks write it, names the route for a check, never a link: in those files
    // only, and in capitals only, it doesn't trip the guard. A link built there still does.
    const named = (file: string, text: string) => documentLinks([{ file, text }]);
    expect(named('api/openapi.gen.ts', '"GET /api/d/{token}": { 200: null },')).toEqual([]);
    expect(named('api/routes.typecheck.ts', "export const NEVER_CALLED = ['GET /api/d/{token}'];")).toEqual([]);
    expect(named('api/openapi.gen.ts', '"get /api/d/{token}": { 200: null },')).toHaveLength(1);
    expect(named('api/routes.typecheck.ts', "const link = `${origin}/api/d/${token}`;")).toHaveLength(1);
    expect(named('owner/share/ShareKit.tsx', "const route = 'GET /api/d/{token}';")).toHaveLength(1);
    // Only those two files: any other compile-time check is scanned as code is.
    expect(named('api/contracts.typecheck.ts', "export const NEVER_CALLED = ['GET /api/d/{token}'];")).toHaveLength(1);

    // The app's code and its page: no hint that fetches a link ahead, and no document link written out.
    expect(INDEX_HTML.text).toContain('<div id="root"></div>');
    expect(hits(LINK_HINT, [...sources, INDEX_HTML])).toEqual([]);
    // The scan reads the generated operation list, which names the route, and finds no link in it.
    expect(sources.find((s) => s.file === 'api/openapi.gen.ts')?.text).toContain('GET /api/d/{token}');
    expect(documentLinks([...sources, INDEX_HTML])).toEqual([]);
  });

  it('visitor_code_never_shows_owner_reasons', () => {
    const visitor = sources.filter((s) => s.file.startsWith('public/'));
    const bad = '<MarginReceipt {...receipt} reason={decision.reason_plain} cardBelow />; decision.owner_plain; const ownerPlain = line;';
    expect.soft(hits(OWNER_REASON, sample(bad))).toHaveLength(5);
    expect(hits(OWNER_REASON, sample('<MarginReceipt {...receipt} onOpenTrace={open} />; const why = reasonPlain;'))).toEqual([]);
    expect.soft(ownerReasonLeaks(sample("import { ApprovalCard as CustomerCard } from '../ds/index.ts'; <CustomerCard {...decision} />"))).not.toEqual([]);
    const wrapper: Source[] = [{ file: 'lib/receipt.ts', text: "export { useOwnerReceipt as receiptFor } from '../owner/conversations/ownerReceipt.ts';" }];
    expect.soft(ownerReasonLeaks(libModulesOf(sample("import { receiptFor } from '../lib/receipt.ts';"), wrapper))).not.toEqual([]);
    expect.soft(ownerReasonLeaks(sample("import { View as CustomerReceipt } from '../owner/Receipt.tsx'; <CustomerReceipt />"))).not.toEqual([]);
    expect(ownerReasonLeaks([...visitor, ...libModulesOf(visitor)])).toEqual([]);
    // Leak assertions in public tests may name the key; tests already sit outside this source scan.
    expect(isScanned('public/leak.test.ts')).toBe(false);
  });

  it('open_status_comes_from_the_ds_once_it_has_the_slot', () => {
    expect(declaresOpenStatus('export interface PublicShellProps {\n  brand: PublicBrand;\n  openStatus?: PublicOpenStatus;\n}')).toBe(true);
    expect(declaresOpenStatus('export interface PublicShellProps {\n  brand: PublicBrand;\n}\nconst openStatus: X = y;')).toBe(false);

    // The public file that draws the shell; it must show the kernel's open status one way or the other.
    const page = sources.find((s) => s.file.startsWith('public/') && /<PublicShell\b/.test(s.text));
    expect(page, 'a public page renders PublicShell').toBeDefined();
    if (declaresOpenStatus(readFileSync(path.join(SRC, SHELL_FILE), 'utf8'))) {
      // The design system's slot has landed: the plain fallback is gone, and the shell gets the status.
      const everything = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
        .map((file) => file.split(path.sep).join('/'))
        .filter((file) => file !== 'app/guards.test.ts');
      expect(everything.filter((file) => FALLBACK_NAME.test(file))).toEqual([]);
      const mentions = everything
        .filter((file) => /\.(tsx?|css)$/.test(file))
        .filter((file) => FALLBACK_NAME.test(readFileSync(path.join(SRC, file), 'utf8')));
      expect(mentions).toEqual([]);
      expect(page?.text).toMatch(/\bopenStatus=\{openStatus\}/);
    } else {
      // Until then the page shows the same line through the plain fallback.
      expect(page?.text).toMatch(/<PlainOpenStatus\b[^>]*\bopenStatus=\{openStatus\}/);
    }
  });

  it('intro_dialog_comes_from_the_ds_once_it_exists', () => {
    // The matchers, on known samples first.
    expect(EXPORTS_INTRO_DIALOG.test("export {\n  IntroDialog,\n  type IntroDialogProps,\n} from './components/IntroDialog/IntroDialog.tsx';")).toBe(true);
    expect(EXPORTS_INTRO_DIALOG.test("export { Dialog, type DialogProps } from './components/Dialog/Dialog.tsx';")).toBe(false);
    expect(IMPORTS_INTRO_FROM_THE_INDEX.test("import { INTRO_ERROR_COPY, IntroDialog } from '../ds/index.ts';")).toBe(true);
    expect(IMPORTS_INTRO_FROM_THE_INDEX.test("import { IntroDialog } from './arrival/PlainIntroDialog.tsx';")).toBe(false);
    const planted: Record<string, string> = { 'owner/arrival/PlainIntroDialog.tsx': '', 'owner/Arrival.tsx': '<PlainIntroDialog />', 'owner/x.ts': '' };
    expect(introFallbacks(Object.keys(planted), (file) => planted[file] ?? '')).toEqual(['owner/arrival/PlainIntroDialog.tsx', 'owner/Arrival.tsx']);

    const arrival = sources.find((s) => s.file === ARRIVAL_FILE);
    expect(arrival, ARRIVAL_FILE).toBeDefined();
    if (EXPORTS_INTRO_DIALOG.test(readFileSync(path.join(SRC, DS_INDEX_FILE), 'utf8'))) {
      // The design system's dialog has landed: no stand-in anywhere, and the arrival uses the real one.
      expect(introFallbacks(everyFileButThisOne(), (file) => readFileSync(path.join(SRC, file), 'utf8'))).toEqual([]);
      expect(arrival?.text).toMatch(IMPORTS_INTRO_FROM_THE_INDEX);
    } else {
      // Until then the arrival shows the plain stand-in.
      expect(arrival?.text).toMatch(/<PlainIntroDialog\b/);
    }
  });

  it('open_status_comes_only_from_the_kernel', () => {
    const visitor = sources.filter((s) => s.file.startsWith('public/') && /\.tsx?$/.test(s.file));
    const hook = visitor.find((s) => s.file === 'public/useOpenStatus.ts');
    expect(hook, 'public/useOpenStatus.ts').toBeDefined();

    // Bindings: only the hook's value, by its own name.
    expect(bindingsNotFromTheHook(sample('<PublicShell openStatus={{ open: true, text: "Open" }} />'))).toHaveLength(2);
    expect(bindingsNotFromTheHook(sample('const { openStatus } = useOpenStatus(slug, desk);\n<X openStatus={status} />'))).toHaveLength(1);
    expect(bindingsNotFromTheHook(sample('let openStatus = desk.open_status;\n<X openStatus={openStatus} />'))).toHaveLength(2);
    expect(bindingsNotFromTheHook(sample('const { openStatus } = useOpenStatus(slug, desk);\n<X openStatus={openStatus} />'))).toEqual([]);
    expect(bindingsNotFromTheHook(visitor)).toEqual([]);

    // In the hook, the value is an answer's `open_status`, or nothing.
    expect(hookAssignments('openStatus = { ...shown.desk.open_status, text: t };').bad).toHaveLength(1);
    expect(hookAssignments('let openStatus: OpenStatus | null = null;\nopenStatus = shown.desk.open_status ?? null;').bad).toEqual([]);
    const assigned = hookAssignments(hook?.text ?? '');
    expect(assigned.all.length).toBeGreaterThan(0);
    expect(assigned.bad).toEqual([]);

    // No status made up on the page: no object with both `open:` and `text:`.
    expect(madeUpStatuses(sample("const line = { open: true, text: 'Open now' };"))).toHaveLength(1);
    expect(madeUpStatuses(visitor)).toEqual([]);

    // The times are read only to schedule what comes next: the open status's refetch, and how long
    // the owner's typing shows. Not elsewhere on the page, nor in the lib modules it imports.
    const helper = 'export function openStatusDelayMs(status: OpenStatus): number {\n  return Date.parse(status.refresh_at) - Date.parse(status.as_of);\n}\n';
    const typing = 'export function ownerTypingDelayMs(ev: EvOwnerTyping, nowMs: number): number {\n  return Date.parse(ev.until) - nowMs;\n}\n';
    expect(timeReadsOutsideTheHelper(sample(`${helper}${typing}`))).toEqual([]);
    expect(timeReadsOutsideTheHelper(sample(`${helper}${typing}const late = status['until'];\nconst { opens_at } = status;\nx.refresh_at;\nsignal.until;`))).toHaveLength(4);
    const planted: Source[] = [{ file: 'lib/clock.ts', text: 'const left = Date.parse(signal.until);' }, { file: 'lib/other.ts', text: '' }];
    expect(libModulesOf(sample("import { left } from '../lib/clock.ts';"), planted).map((s) => s.file)).toEqual(['lib/clock.ts']);
    // From the page's own folders, such as the inbox, verification and the checkout, too.
    expect(libModulesOf(sample("import { left } from '../../lib/clock.ts';"), planted).map((s) => s.file)).toEqual(['lib/clock.ts']);
    expect(libModulesOf(visitor).map((s) => s.file)).toContain('lib/format.ts');
    expect(timeReadsOutsideTheHelper(libModulesOf(sample("import { left } from '../lib/clock.ts';"), planted))).toHaveLength(1);
    expect(timeReadsOutsideTheHelper([...visitor, ...libModulesOf(visitor)])).toEqual([]);
    expect(functionBody(hook?.text ?? '', 'openStatusDelayMs'), 'openStatusDelayMs is in useOpenStatus.ts').not.toBeNull();
    const reducer = visitor.find((s) => s.file === 'public/chatReducer.ts');
    expect(functionBody(reducer?.text ?? '', 'ownerTypingDelayMs'), 'ownerTypingDelayMs is in chatReducer.ts').not.toBeNull();
  });

  it('finds_PublicShell_through_import_and_const_factory_aliases', () => {
    const fixtures = [
      "import { jsx as _jsx } from 'react/jsx-runtime'; _jsx(PublicShell, props);",
      "import { jsxs as _jsxs } from 'react/jsx-runtime'; const make = _jsxs; make(PublicShell, props);",
      "import { jsxDEV as dev } from 'react/jsx-dev-runtime'; const make = dev; make(PublicShell, props);",
      "import { createElement as make } from 'react'; make(PublicShell, props);",
      "import * as React from 'react'; const make = React.createElement; const again = make; again(PublicShell, props);",
      "import * as runtime from 'react/jsx-runtime'; const { jsx: make } = runtime; make(PublicShell, props);",
      "import { PublicShell as Shell } from '../ds/index.ts'; const Head = Shell; const Page = Head; <Page {...props} />;",
      "import * as ds from '../ds/index.ts'; const { PublicShell: Shell } = ds; const Head = Shell; <Head {...props} />;",
    ];
    expect(fixtures.map((text) => ownerInChatNotFromTheChat(sample(text)).length > 0)).toEqual(fixtures.map(() => true));
  });

  it('pins_mode_raises_and_confirmation_to_their_guarded_paths', () => {
    const method = (name: string, body: string) => `class VisitorChat { private ${name}() { ${body} } }`;
    const guard = 'since === this.tracked && transcript.last_seq >= this.modeAt && transcript.state.generation >= this.sessionGeneration';
    const opened = 'this.set({ session: this.openedSession(transcript) });';
    const negative = [
      method('checkCode', opened),
      method('confirmMode', opened),
      method('confirmMode', `if (transcript.last_seq >= this.modeAt && transcript.state.generation >= this.sessionGeneration) ${opened}`),
      method('confirmMode', `if (since === this.tracked && transcript.state.generation >= this.sessionGeneration) ${opened}`),
      method('confirmMode', `if (since === this.tracked && transcript.last_seq >= this.modeAt) ${opened}`),
      method('confirmMode', `if ((${guard}) || enabled) ${opened}`),
      method('confirmMode', `if (${guard}) {} else { ${opened} }`),
      method('open', `const deferred = () => { ${opened} };`),
      method('checkCode', 'this.modeKnown = true;'),
      method('laterRead', 'this.modeKnown = true;'),
      method('laterRead', 'if (following) this.modeKnown = true;'),
      method('laterRead', 'if (since === this.tracked) this.modeKnown = true;'),
      method('laterRead', 'if (following || since === this.tracked) this.modeKnown = true;'),
      method('followMode', 'this.modeKnown = true;'),
      method('followMode', 'if (state.catchingUp) this.modeKnown = true;'),
      method('followMode', 'if (!state.catchingUp || enabled) this.modeKnown = true;'),
    ];
    expect(negative.map((text) => sessionModeWrites(text).length > 0)).toEqual(negative.map(() => true));
    const positive = [
      method('open', opened),
      method('confirmMode', `if (${guard}) ${opened}`),
      method('confirmMode', `if ((since === this.tracked) && /* current cursor */ (transcript.last_seq >= this.modeAt) && (transcript.state.generation >= this.sessionGeneration)) { ${opened} }`),
      method('openedSession', 'this.modeKnown = true;'),
      method('laterRead', 'if (following && since === this.tracked) this.modeKnown = true;'),
      method('followMode', "if (ev.type === 'owner_joined' && !state.catchingUp) this.modeKnown = true;"),
    ];
    expect(positive.flatMap(sessionModeWrites)).toEqual([]);
  });

  it('owner_in_chat_comes_only_from_the_sessions_mode', () => {
    // Every file under `public/`, and every other file that renders PublicShell, the vision pages among them.
    const visitor = shellFiles(sources);
    expect(visitor.map(({ file }) => file)).toEqual(expect.arrayContaining(['public/PublicChat.tsx', 'vision/CityOfficePage.tsx', 'vision/ClaudeAccountPage.tsx']));
    const planted: Source = { file: 'vision/Planted.tsx', text: 'export const Page = () => <PublicShell ownerInChat brand={brand} />;' };
    expect(ownerInChatNotFromTheChat(shellFiles([...sources, planted]))).toContain('vision/Planted.tsx: ownerInChat');
    const hook = "const chat = useVisitorChat(slug, previewDeskId);\n";

    // Props: only the visitor chat's own value, by its own name, from the hook.
    expect(ownerInChatNotFromTheChat(sample(`${hook}<PublicShell ownerInChat={true} />`))).toEqual(['sample.tsx: ownerInChat={true}']);
    expect(ownerInChatNotFromTheChat(sample(`${hook}<PublicShell ownerInChat />`))).toEqual(['sample.tsx: ownerInChat']);
    expect(ownerInChatNotFromTheChat(sample(`${hook}<PublicShell ownerInChat={ready && joined(state)} />`))).toHaveLength(1);
    expect(ownerInChatNotFromTheChat(sample(`${hook}const { ownerInChat } = chat;\n<PublicShell ownerInChat={ownerInChat} />`))).toHaveLength(2);
    expect(ownerInChatNotFromTheChat(sample('const chat = { ownerInChat: true };\n<PublicShell ownerInChat={chat.ownerInChat} />'))).toHaveLength(2);
    expect(ownerInChatNotFromTheChat(sample(`${hook}chat = other;\n<PublicShell ownerInChat={chat.ownerInChat} />`))).toHaveLength(1);
    expect(ownerInChatNotFromTheChat(sample(`${hook}// ownerInChat={true} in a comment\n<PublicShell ownerInChat={chat.ownerInChat} />`))).toEqual([]);
    expect(ownerInChatNotFromTheChat(sample("type Set = Omit<Snapshot, 'ownerInChat'>;"))).toEqual([]);
    // Nothing reaches PublicShell another way: no spread into it, and no `ownerInChat` key outside the
    // visitor chat, as an object a spread or `createElement` would pass.
    expect(ownerInChatNotFromTheChat(sample(`${hook}const shellProps = { ownerInChat: true };\n<PublicShell {...shellProps} />`))).toEqual([
      'sample.tsx: PublicShell takes a spread: {...shellProps}',
      'sample.tsx: ownerInChat: true',
    ]);
    expect(ownerInChatNotFromTheChat(sample(`${hook}<PublicShell\n  brand={brand}\n  composer={<div onInput={(e) => typed(e)}>{box}</div>}\n  {...rest}\n/>`))).toEqual([
      'sample.tsx: PublicShell takes a spread: {...rest}',
    ]);
    expect(ownerInChatNotFromTheChat(sample('createElement(PublicShell, { ...props, ownerInChat: enabled });'))).toEqual([
      'sample.tsx: PublicShell made with createElement(PublicShell',
      'sample.tsx: ownerInChat: enabled',
    ]);
    expect(ownerInChatNotFromTheChat(sample(`${hook}<PublicShell brand={brand} composer={<Composer {...composerProps} />} ownerInChat={chat.ownerInChat} />`))).toEqual([]);
    // Nor assigned to anything, or written as a quoted key.
    expect(ownerInChatNotFromTheChat(sample('shellProps.ownerInChat = true;'))).toEqual(['sample.tsx: shellProps.ownerInChat = true']);
    expect(ownerInChatNotFromTheChat(sample("shellProps['ownerInChat'] = enabled;"))).toEqual(["sample.tsx: shellProps['ownerInChat'] = enabled"]);
    expect(ownerInChatNotFromTheChat(sample("const shellProps = { 'ownerInChat': true, \"ownerInChat\": joined };"))).toEqual([
      "sample.tsx: 'ownerInChat': true",
      'sample.tsx: "ownerInChat": joined',
    ]);
    expect(ownerInChatNotFromTheChat(sample('if (shellProps.ownerInChat === chat.ownerInChat) show();'))).toEqual([]);
    // Compound assignments are assignments too.
    expect(ownerInChatNotFromTheChat(sample('chat.ownerInChat ||= true;'))).toEqual(['sample.tsx: chat.ownerInChat ||= true']);
    expect(ownerInChatNotFromTheChat(sample('shellProps.ownerInChat ??= joined;'))).toEqual(['sample.tsx: shellProps.ownerInChat ??= joined']);
    expect(ownerInChatNotFromTheChat(sample("shellProps['ownerInChat'] &&= enabled;"))).toEqual(["sample.tsx: shellProps['ownerInChat'] &&= enabled"]);
    // PublicShell by another name is still PublicShell, in any file that names it, and so is one made
    // with `createElement`, which takes its props whole.
    const aliased: Source = { file: 'vision/Aliased.tsx', text: "import { PublicShell as Shell } from '../ds/index.ts';\nexport const Page = () => <Shell {...props} />;" };
    expect(shellFiles([...sources, aliased]).map(({ file }) => file)).toContain('vision/Aliased.tsx');
    expect(ownerInChatNotFromTheChat([aliased])).toEqual(['vision/Aliased.tsx: PublicShell takes a spread: {...props}']);
    expect(ownerInChatNotFromTheChat(sample('const Shell = PublicShell;\nconst page = <Shell brand={brand} {...rest} />;'))).toEqual([
      'sample.tsx: PublicShell takes a spread: {...rest}',
    ]);
    expect(ownerInChatNotFromTheChat(sample("import * as ds from '../ds/index.ts';\nconst page = <ds.PublicShell {...props} />;"))).toEqual([
      'sample.tsx: PublicShell takes a spread: {...props}',
    ]);
    expect(ownerInChatNotFromTheChat(sample('const page = createElement(PublicShell, props);'))).toEqual(['sample.tsx: PublicShell made with createElement(PublicShell']);
    expect(ownerInChatNotFromTheChat(sample("import { PublicShell as Shell } from '../ds/index.ts';\nconst page = React.createElement(Shell, { brand });"))).toEqual([
      'sample.tsx: PublicShell made with createElement(Shell',
    ]);
    expect(ownerInChatNotFromTheChat(sample("import { PublicShell as Shell } from '../ds/index.ts';\nconst page = <Shell brand={brand} ownerInChat={chat.ownerInChat} />;"))).toEqual([
      "sample.tsx: chat doesn't come from useVisitorChat",
      'sample.tsx: chat is declared or assigned elsewhere',
    ]);
    expect(ownerInChatNotFromTheChat(visitor)).toEqual([]);
    // The binding check below and the method check further down read code without its comments. A comment
    // marker inside a string is text, so the code after it on the same line still counts.
    expect(withoutComments("const a = '//'; const b = <X ownerInChat />;")).toContain('ownerInChat');
    expect(methodBody(withoutComments("class C { private a(): string { return '//'; } private followMode(): void {} }"), 'followMode')).not.toBeNull();
    // It is passed where it is meant to be, so the check can't pass by finding nothing.
    expect(visitor.filter(({ file, text }) => /\bownerInChat=\{chat\.ownerInChat\}/.test(withoutComments(text, file))).map(({ file }) => file)).toEqual(['public/PublicChat.tsx']);

    // In the visitor chat, the value is `ownerInChatNow`'s, which reads the session's mode and only
    // ANDs on what keeps it false.
    const now = "export function ownerInChatNow({ session, state }: OwnerInChatFacts): boolean {\n  return session?.mode === 'owner' && !state.catchingUp;\n}\n";
    const call = 'ownerInChatNow({\n      session: next.session,\n      state: next.state,\n      ready: next.status === \'ready\',\n    })';
    expect(ownerInChatSources(`interface Snapshot { ownerInChat: boolean; }\nconst initial = { ownerInChat: false };\nthis.snapshot = { ...next, ownerInChat: ${call} };`, now)).toEqual([]);
    expect(ownerInChatSources('({ ownerInChat: state.rows.some(joined), });', now)).toHaveLength(1);
    expect(ownerInChatSources('({ ownerInChat: ownerInChatNow(facts) || joined, });', now)).toHaveLength(1);
    // Exactly the call: nothing around it that could say yes on its own.
    expect(ownerInChatSources('({ ownerInChat: enabled ? enabled : ownerInChatNow(facts), });', now)).toEqual([
      'public/PublicChatProvider.tsx: ownerInChat: enabled ? enabled : ownerInChatNow(facts)',
    ]);
    expect(ownerInChatSources('({ ownerInChat: ready && ownerInChatNow(facts), });', now)).toHaveLength(1);
    expect(ownerInChatSources('({ ownerInChat: ownerInChatNow({ session, state, ready: true }), });', now)).toHaveLength(1);
    expect(ownerInChatSources('', now.replace("session?.mode === 'owner'", 'joined(state)'))).toHaveLength(1);
    expect(ownerInChatSources('', now.replace('&& !state.catchingUp', '|| joined(state)'))).toHaveLength(1);
    expect(ownerInChatSources('', now.replace("return session?.mode === 'owner'", "return enabled ? session?.mode === 'owner' : joined(state)"))).toHaveLength(1);

    // In the visitor chat, only the open path (`openedSession`) and `followMode` set the session's
    // mode, and `followMode` sets the owner's only for `owner_joined`. Every other session it keeps
    // goes through a helper that can only lower the mode, and nothing else writes one.
    const chatSample = (method: string, body: string) => `class VisitorChat {\n  private ${method}(ev: SseEvent): void {\n${body}\n  }\n}\n`;
    const follow = "    const mode = ev.type === 'owner_joined' ? 'owner' : ev.type === 'message' && ev.author !== 'owner' ? 'ai' : null;\n    this.set({ session: { ...session, mode } });";
    const opened = "    return { ...read, mode: read.mode === 'owner' && out ? 'ai' : read.mode };";
    const fine = [
      chatSample('followMode', follow),
      chatSample('openedSession', opened),
      chatSample('laterSession', '    return { ...next, mode: lowerOnly(this.snapshot.session?.mode ?? null, said) };'),
      chatSample('open', '    if (gone) this.set({ session: this.laterSession(session, session.mode) });\n    else this.set({ session: this.openedSession(transcript) });'),
      chatSample('checkCode', "    this.set(ok ? { verifyStatus: 'idle', session: this.laterRead(read.transcript, read.since) } : { verifyStatus: 'unreachable' });\n    this.set({ session: null, status: 'loading' });"),
      chatSample('confirmMode', "    if (this.snapshot.session?.mode === 'owner') void this.read();\n    const mode: SessionMode | null = null;"),
    ].join('');
    expect(sessionModeWrites(fine)).toEqual([]);
    expect(sessionModeWrites(chatSample('checkCode', "    this.set(state.verified ? { verifyStatus: 'idle', session: state } : { verifyStatus: 'failed' });"))).toEqual([
      `${VISITOR_CHAT_FILE}: session: state`,
    ]);
    expect(sessionModeWrites(chatSample('open', '    this.set({ session });'))).toEqual([`${VISITOR_CHAT_FILE}: session (shorthand)`]);
    expect(sessionModeWrites(chatSample('open', '    this.set({ session: gone ? this.laterSession(session, session.mode) : transcript.state });'))).toHaveLength(1);
    expect(sessionModeWrites(chatSample('confirmMode', "    this.set({ session: this.laterSession({ ...read, mode: 'owner' }, null) });"))).toEqual([
      `${VISITOR_CHAT_FILE}: sets the mode outside the open path and followMode: mode:`,
    ]);
    expect(sessionModeWrites(chatSample('confirmMode', "    session.mode = 'owner';"))).toEqual([`${VISITOR_CHAT_FILE}: sets the mode outside the open path and followMode: .mode =`]);
    expect(sessionModeWrites(chatSample('confirmMode', "    session.mode ||= 'owner';"))).toEqual([`${VISITOR_CHAT_FILE}: sets the mode outside the open path and followMode: .mode ||=`]);
    expect(sessionModeWrites(chatSample('confirmMode', "    session['mode'] ??= 'owner';"))).toHaveLength(1);
    expect(sessionModeWrites(chatSample('followMode', follow.replace("ev.type === 'owner_joined' ? 'owner'", "ev.type === 'owner_typing' ? 'owner'")))).toEqual([
      `${VISITOR_CHAT_FILE}: followMode sets the owner's mode for something but owner_joined`,
    ]);
    expect(sessionModeWrites(chatSample('followMode', `${follow}\n    this.set({ session: { ...session, mode: 'owner' } });`))).toHaveLength(2);
    const chat = visitor.find((s) => s.file === VISITOR_CHAT_FILE);
    const reducer = visitor.find((s) => s.file === CHAT_REDUCER_FILE);
    expect(chat, VISITOR_CHAT_FILE).toBeDefined();
    expect(reducer, CHAT_REDUCER_FILE).toBeDefined();
    expect(ownerInChatSources(chat?.text ?? '', reducer?.text ?? '')).toEqual([]);
    expect(sessionModeWrites(chat?.text ?? '')).toEqual([]);
    // The rules read the methods they name, so they can't pass by finding nothing.
    for (const method of ['openedSession', 'followMode', 'laterSession', 'laterRead']) expect(methodBody(withoutComments(chat?.text ?? '', VISITOR_CHAT_FILE), method), method).not.toBeNull();
    expect(ownerInChatNodes(chat?.text ?? '').some((node) => ts.isPropertyAssignment(node) && ts.isCallExpression(node.initializer) && sameExpression(node.initializer.expression, 'ownerInChatNow')), 'the chat sets it from ownerInChatNow').toBe(true);
  });

  it('mark_tile_only_in_the_app_icon', () => {
    // The matcher, on known samples first: the prop however it is written, under an imported name,
    // and a spread that could carry it; not another prop, a longer tag name or another component's.
    expect(markTiles(sample('<Mark tile />'))).toEqual(['sample.tsx: <Mark tile />']);
    expect(markTiles(sample('<Mark size={20}\n  tile={true} />'))).toHaveLength(1);
    expect(markTiles(sample("import { Mark as Bell } from '../ds/index.ts'; <Bell tile />"))).toEqual(['sample.tsx: <Bell tile />']);
    expect(markTiles(sample('<Mark {...props} />'))).toHaveLength(1);
    expect(markTiles(sample('<Mark size={32} ground="light" /> <Mark /> <MarkBanner tile /> <Tile tile />'))).toEqual([]);
    // A word that only starts with the prop's name, and an arrow's `>` inside a braced value, are not it.
    expect(markTiles(sample('<Mark key={tiles.length} onClick={() => open(tiles)} />'))).toEqual([]);
    expect(markTiles(sample('<Mark onClick={() => setOpen(true)} tile />'))).toHaveLength(1);
    // A namespace's member, and a local name the component is given, however many steps it takes.
    expect(markTiles(sample("import * as DS from '../ds/index.ts';\n<DS.Mark tile />"))).toEqual(['sample.tsx: <DS.Mark tile />']);
    expect(markTiles(sample('const Bell = Mark;\n<Bell tile />'))).toEqual(['sample.tsx: <Bell tile />']);
    expect(markTiles(sample('const Bell = DS.Mark;\nconst Ring: typeof Mark = Bell;\n<Ring size={20} tile />'))).toHaveLength(1);
    expect(markTiles(sample('const { Mark: Bell } = DS;\n<Bell tile />'))).toHaveLength(1);
    expect(markTiles(sample('const $bell = Mark;\n<$bell tile />'))).toEqual(['sample.tsx: <$bell tile />']);
    expect(markTiles(sample('const Bell = MarkBanner;\n<Bell tile />\n<DS.MarkBanner tile />'))).toEqual([]);
    // The allowlist: the app icon's file and the design system's stories, nothing else: not the About
    // pages, whose top bar drew it until the owner moved it into the article's icon, and not another
    // file in the mark's folder.
    expect(mayDrawTheMarkTile(MARK_TILE_FILE)).toBe(true);
    expect(mayDrawTheMarkTile('ds/components/Mark/Mark.stories.tsx')).toBe(true);
    expect(mayDrawTheMarkTile('about/ReaderPage.tsx')).toBe(false);
    expect(mayDrawTheMarkTile('ds/components/Mark/MarkBadge.tsx')).toBe(false);
    expect(mayDrawTheMarkTile('about/Hero.tsx')).toBe(false);
    expect(mayDrawTheMarkTile('about/figures/ArchitectureFigure.tsx')).toBe(false);
    expect(mayDrawTheMarkTile('ds/components/Sidebar/Sidebar.tsx')).toBe(false);
    expect(mayDrawTheMarkTile('ds/boards/parts.tsx')).toBe(false);
    expect(mayDrawTheMarkTile('owner/OwnerLayout.tsx')).toBe(false);
    expect(mayDrawTheMarkTile('aboutness/Page.tsx')).toBe(false);
    const planted: Source[] = [
      { file: 'about/Hero.tsx', text: '<Mark tile />' },
      { file: 'about/ReaderPage.tsx', text: '<span className="cd-about-brand">\n  <Mark tile />\n  <Wordmark preview />\n</span>' },
    ];
    expect(markTiles(planted.filter(({ file }) => !mayDrawTheMarkTile(file)))).toEqual([
      'about/Hero.tsx: <Mark tile />',
      'about/ReaderPage.tsx: <Mark tile />',
    ]);

    // Every TypeScript file under src/, the design system included. The app icon does draw it, once,
    // in `MarkAppIcon`, so the matcher reads the code as it is written, and nothing else does.
    const code = everyTextFile().filter(({ file }) => /\.tsx?$/.test(file));
    const markFile = code.find(({ file }) => file === MARK_TILE_FILE);
    expect(markTiles(markFile ? [markFile] : [])).toHaveLength(1);
    const icon = functionBody(markFile?.text ?? '', MARK_TILE_COMPONENT);
    expect(icon, `${MARK_TILE_COMPONENT} is in ${MARK_TILE_FILE}`).not.toBeNull();
    expect(markTiles(sample(markFile?.text.slice(...(icon ?? [0, 0])) ?? ''))).toHaveLength(1);
    expect(markTiles(code.filter(({ file }) => !mayDrawTheMarkTile(file)))).toEqual([]);
  });

  it('caps_pill_only_in_the_wordmark', () => {
    // The matcher, on known samples first: the prop however it is written, under an imported or
    // local name or a namespace's member, and a spread that could carry it; not another component's.
    expect(pillCaps(sample('<Pill caps>Preview</Pill>'))).toEqual(['sample.tsx: <Pill caps>']);
    expect(pillCaps(sample("import * as DS from '../ds/index.ts';\n<DS.Pill caps>Preview</DS.Pill>"))).toEqual(['sample.tsx: <DS.Pill caps>']);
    expect(pillCaps(sample("import { Pill as Badge } from '../ds/index.ts';\n<Badge\n  caps={true}>New</Badge>"))).toHaveLength(1);
    expect(pillCaps(sample('const Badge = Pill;\n<Badge caps>New</Badge>'))).toEqual(['sample.tsx: <Badge caps>']);
    expect(pillCaps(sample('<Pill {...badge} />'))).toHaveLength(1);
    expect(pillCaps(sample('<Pill>Public</Pill> <PillGroup caps /> <Wordmark preview /> <DS.PillGroup caps />'))).toEqual([]);
    // A planted badge in the intro dialog fails, though its row shows the badge through the Wordmark.
    const planted: Source[] = [
      { file: 'ds/components/IntroDialog/IntroDialog.tsx', text: '<Mark />\n<Wordmark />\n<Pill caps>Preview</Pill>' },
      { file: 'ds/components/IntroDialog/IntroDialog.tsx', text: '<Mark />\n<Wordmark preview />' },
    ];
    expect(pillCaps(planted.filter(({ file }) => file !== WORDMARK_FILE))).toEqual(['ds/components/IntroDialog/IntroDialog.tsx: <Pill caps>']);

    // Every TypeScript file under src/, the design system and the tests included. The Wordmark does
    // draw the badge, so the matcher reads the code as it is written, and nothing else does.
    const everything = everyTextFile();
    const code = everything.filter(({ file }) => /\.tsx?$/.test(file));
    expect(pillCaps(code.filter(({ file }) => file === WORDMARK_FILE))).toEqual([`${WORDMARK_FILE}: <Pill caps>`]);
    expect(pillCaps(code.filter(({ file }) => file !== WORDMARK_FILE))).toEqual([]);

    // Outside the design system, only tests name the badge's style or marker.
    expect(hits(CAPS_BADGE_NAMES, sample('<span className="cd-type-badge-caps" data-ds="preview-badge">New</span>'))).toHaveLength(2);
    const outsideTheDs = everything.filter(({ file }) => !file.startsWith('ds/') && !/\.test\.tsx?$/.test(file));
    expect(outsideTheDs.map(({ file }) => file)).toContain('about/ReaderPage.tsx');
    expect(hits(CAPS_BADGE_NAMES, outsideTheDs)).toEqual([]);
  });

  it('a_systems_preference_never_overrides_a_chosen_theme', () => {
    // The app follows the device until a person chooses, and a chosen Dark marks the root: a
    // stylesheet turns light for a system that prefers it only on a root not marked dark. Every
    // stylesheet in src/, the design system's included.
    const unscoped = ({ file, text }: Source) =>
      systemLightSelectors(withoutCssComments(text)).filter((selector) => !NOT_DARK_ROOT.test(selector)).map((selector) => `${file}: ${selector}`);
    // The matcher, on known samples first.
    const scoped = `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) .a, :root:not([data-theme='dark']) { color: red } }`;
    expect(sample(scoped).flatMap(unscoped)).toEqual([]);
    const loose = `@media (prefers-color-scheme: light) { :root { color: red } .b { color: blue } }`;
    expect(sample(loose).flatMap(unscoped)).toEqual(['sample.tsx: :root', 'sample.tsx: .b']);
    const stylesheets: Source[] = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .map((file) => file.split(path.sep).join('/'))
      .filter((file) => file.endsWith('.css'))
      .map((file) => ({ file, text: readFileSync(path.join(SRC, file), 'utf8') }));
    // The two that have such a block today: the tokens and the mark.
    expect(stylesheets.filter(({ text }) => systemLightSelectors(text).length > 0).map(({ file }) => file).sort()).toEqual([
      'ds/components/Mark/Mark.css',
      'ds/tokens.css',
    ]);
    expect(stylesheets.flatMap(unscoped)).toEqual([]);
    // Dark is the base the tokens are written in, so no stylesheet follows a system that prefers
    // dark: such a rule would override a chosen Light on a dark device.
    const darkPreference = /@media[^{]*prefers-color-scheme\s*:\s*dark/;
    expect(sample('@media (prefers-color-scheme: dark) { .x { color: red } }').filter(({ text }) => darkPreference.test(text))).toHaveLength(1);
    expect(stylesheets.filter(({ text }) => darkPreference.test(withoutCssComments(text))).map(({ file }) => file)).toEqual([]);
  });

  it('mark_and_clay_colors_stay_in_their_components', () => {
    // The matchers, on known samples first: the mark's tokens, its parts' classes and its clay;
    // clay's token and color. The mark's own class and longer names aren't matched.
    expect(hits(MARK_PARTS, sample('fill: var(--mark-clay); .cd-mark__ink {} color: #D97757; rgb(217, 119, 87)'))).toHaveLength(4);
    expect(hits(MARK_PARTS, sample('.cd-mark { display: block } --bookmark-tile: 1; --marked: 1'))).toEqual([]);
    expect(hits(CLAY_PARTS, sample('background: var(--clay-soft); color: #E08968; rgb(224, 137, 104)'))).toHaveLength(3);
    expect(hits(CLAY_PARTS, sample('--clayton: 1; --mark-clay: 1'))).toEqual([]);
    // The light theme's clay is clay too, as hex and as RGB.
    expect(hits(CLAY_PARTS, sample('color: #C4673F; fill: rgb(196, 103, 63)'))).toHaveLength(2);

    // Every text file under src/, the design system's stories, boards and docs included.
    const everything = everyTextFile().map(withoutHeaderPalette);
    const files = everything.map((s) => s.file);
    for (const file of ['ds/components/Mark/Mark.css', 'ds/components/IntroDialog/IntroDialog.css', 'ds/boards/parts.tsx', 'ds/README.md', 'about/reader.css']) {
      expect(files, file).toContain(file);
    }
    // Clay's allowlist is the intro dialog's and mark's folders, plus the writing dots' CSS and story.
    expect(mayUseClay('ds/components/Mark/Mark.css')).toBe(true);
    expect(mayUseClay('ds/components/WritingIndicator/WritingIndicator.css')).toBe(true);
    expect(mayUseClay('ds/components/WritingIndicator/WritingIndicator.stories.tsx')).toBe(true);
    expect(mayUseClay('ds/components/WritingIndicator/Other.css')).toBe(false);
    expect(mayUseClay('ds/components/MarkBanner/MarkBanner.css')).toBe(false);
    expect(mayUseClay('about/reader.css')).toBe(false);
    const plantedClay: Source[] = [
      { file: 'about/reader.css', text: '.cd-about-hero__icon { background: var(--clay); }' },
      { file: 'owner/settings/Settings.css', text: '.cd-settings__accent { color: #c4673f; }' },
      { file: 'ds/components/IntroDialog/IntroDialog.css', text: '.cd-intro__field { background: #c4673f; }' },
    ];
    expect(hits(CLAY_PARTS, plantedClay.filter(({ file }) => !mayUseClay(file)))).toEqual(['about/reader.css: --clay', 'owner/settings/Settings.css: #c4673f']);
    // The matchers find the real uses in their own folders, and nothing anywhere else.
    expect(hits(MARK_PARTS, everything.filter(({ file }) => file.startsWith(MARK_FOLDER))).length).toBeGreaterThan(0);
    for (const folder of CLAY_FOLDERS) {
      expect(hits(CLAY_PARTS, everything.filter(({ file }) => file.startsWith(folder))).length, folder).toBeGreaterThan(0);
    }
    for (const allowed of CLAY_FILES) {
      expect(hits(CLAY_PARTS, everything.filter(({ file }) => file === allowed)).length, allowed).toBeGreaterThan(0);
    }
    expect(hits(MARK_PARTS, everything.filter(({ file }) => !file.startsWith(MARK_FOLDER)))).toEqual([]);
    expect(hits(CLAY_PARTS, everything.filter(({ file }) => !mayUseClay(file)))).toEqual([]);
  });
});
