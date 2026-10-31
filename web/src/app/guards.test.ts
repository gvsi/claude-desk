/**
 * Source guards for the app: everything under `src/` that runs in a browser, except the design
 * system (it has its own guards), the mock API and tests; one guard, on the mark's and clay's colors,
 * reads every text file. Each guard first proves its matcher on a known-bad sample, so it can't pass
 * by matching nothing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

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

// A label swapped for a waiting one ("Starting…", "Sending your answer..."): a busy button keeps its words and spins.
const BUSY_LABEL = /['"`>]\s*[A-Z][a-z]+ing\b[^'"`<>{}\n]*(?:…|\.{3})\s*(?=['"`<])/;

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

// A card that holds cards: the design system's one exception to "never a card in a card", for the
// agents page's "Send an agent" card, which holds the agent's run and the Desk's reply cards.
const HOLDS_CARDS = /\bholdsCards\b/;
const HOLDS_CARDS_FILE = 'public/agents/SendAgentPanel.tsx';

// An owner's reason on a receipt: the decision's `reason_plain` and the receipt props that show it
// to the owner. The visitor's page shows each receipt's `visitor_plain` and nothing else.
const OWNER_REASON = /\breason_plain\b|\breason=|\bcardBelow\b/;

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

// The first visit's dialog: the design system's, once its index exports it, with no stand-in left.
const DS_INDEX_FILE = 'ds/index.ts';
const ARRIVAL_FILE = 'owner/Arrival.tsx';
const INTRO_FALLBACK_NAME = /PlainIntroDialog/;
const EXPORTS_INTRO_DIALOG = /\bexport\s*\{[^}]*\bIntroDialog\b[^}]*\}\s*from\b/;
const IMPORTS_INTRO_FROM_THE_INDEX = /\bimport\s*\{[^}]*\bIntroDialog\b[^}]*\}\s*from\s*['"](?:\.\.\/)+ds\/index(?:\.ts)?['"]/;

/** Every file under `src/` but this one, by path relative to `src/`. */
function everyFileButThisOne(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .map((file) => file.split(path.sep).join('/'))
    .filter((file) => file !== 'app/guards.test.ts');
}

// The Claude Desk mark's fixed colors and its parts' classes, only in the mark's folder; clay, the
// intro illustration's field, only in the intro dialog's. Unlike the guards above, this one reads every
// text file under `src/`, the design system included, but the token sources and the tables and tests
// that list every token or prove the design system's own guards.
const MARK_PARTS = /(?<![\w-])--mark-[a-z-]*[a-z]|\bcd-mark__[a-z-]*|#d97757\b|217\s*,\s*119\s*,\s*87/i;
const CLAY_PARTS = /(?<![\w-])--clay\b|#e08968\b|224\s*,\s*137\s*,\s*104/i;
const MARK_FOLDER = 'ds/components/Mark/';
const CLAY_FOLDER = 'ds/components/IntroDialog/';
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

// The mark's white tile: only the About pages' top bar draws it (owner, 2026-10-30), in that file's
// `Brand`, and the design system's stories show it. A JSX `<Mark>`, under any name it is given, that
// passes `tile`, or a spread that could carry it, counts as a use.
const MARK_TILE_FILE = 'about/ReaderPage.tsx';
const TILE_ATTRIBUTE = /\stile\b|\{\s*\.\.\./;

/** Each `<Mark …>` opening tag in a source that passes `tile` or spreads its props, as "file: tag". */
function markTiles(scanned: Source[]): string[] {
  return jsxTagsPassing(scanned, 'Mark', TILE_ATTRIBUTE);
}

/** The files that may draw the mark's tile: the About top bar's file, and the design system's stories. */
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
    expect(hits(RAW_COLOR)).toEqual([]);
    expect(hits(RAW_MS)).toEqual([]);
    expect(hits(RAW_CSS_SECONDS, sources.filter((s) => s.file.endsWith('.css')))).toEqual([]);
  });

  it('busy_buttons_keep_their_words', () => {
    const bad = [
      "<Button busy={busy}>{busy ? 'Starting…' : 'Start the demo'}</Button>",
      '<Button variant="primary">Sending...</Button>',
      'const label = pending ? `Sending your answer…` : `Allow this time`;',
    ];
    for (const text of bad) expect(hits(BUSY_LABEL, sample(text)), text).toHaveLength(1);
    const fine = "<Button {...props} busy={busy}>Start the demo</Button>; const rows = [...all]; // GET …/briefing\n<TextField placeholder='Type a message…' />";
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

  it('only_the_send_agent_panel_holds_cards', () => {
    expect(hits(HOLDS_CARDS, sample('<Card as="section" label="Send an agent" holdsCards>{run}</Card>'))).toHaveLength(1);
    expect(hits(HOLDS_CARDS, sample('<Card as="section" label="Send an agent">{run}</Card>; const holdsCardsLike = 1;'))).toEqual([]);
    // Allowed in the design system, which these sources leave out, and in the panel the exception is for.
    expect(sources.some(({ file }) => file.startsWith('ds/'))).toBe(false);
    expect(hits(HOLDS_CARDS, sources.filter(({ file }) => file !== HOLDS_CARDS_FILE))).toEqual([]);
  });

  it('visitor_code_never_shows_owner_reasons', () => {
    const visitor = (s: Source) => s.file.startsWith('public/');
    const bad = '<MarginReceipt {...receipt} reason={decision.reason_plain} cardBelow />';
    expect(hits(OWNER_REASON, sample(bad))).toHaveLength(3);
    expect(hits(OWNER_REASON, sample('<MarginReceipt {...receipt} onOpenTrace={open} />; const why = reasonPlain;'))).toEqual([]);
    expect(hits(OWNER_REASON, sources.filter(visitor))).toEqual([]);
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

  it('mark_tile_only_on_the_about_top_bar', () => {
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
    // The allowlist: the About top bar's file and the design system's stories, nothing else, not even
    // another file of the About pages.
    expect(mayDrawTheMarkTile(MARK_TILE_FILE)).toBe(true);
    expect(mayDrawTheMarkTile('ds/components/Mark/Mark.stories.tsx')).toBe(true);
    expect(mayDrawTheMarkTile('about/Hero.tsx')).toBe(false);
    expect(mayDrawTheMarkTile('about/figures/ArchitectureFigure.tsx')).toBe(false);
    expect(mayDrawTheMarkTile('ds/components/Sidebar/Sidebar.tsx')).toBe(false);
    expect(mayDrawTheMarkTile('ds/boards/parts.tsx')).toBe(false);
    expect(mayDrawTheMarkTile('owner/OwnerLayout.tsx')).toBe(false);
    expect(mayDrawTheMarkTile('aboutness/Page.tsx')).toBe(false);
    const planted: Source[] = [{ file: 'about/Hero.tsx', text: '<Mark tile />' }];
    expect(markTiles(planted.filter(({ file }) => !mayDrawTheMarkTile(file)))).toEqual(['about/Hero.tsx: <Mark tile />']);

    // Every TypeScript file under src/, the design system included. The About top bar does draw it,
    // once, in its `Brand`, so the matcher reads the code as it is written, and nothing else does.
    const code = everyTextFile().filter(({ file }) => /\.tsx?$/.test(file));
    const reader = code.find(({ file }) => file === MARK_TILE_FILE);
    expect(markTiles(reader ? [reader] : [])).toEqual([`${MARK_TILE_FILE}: <Mark tile />`]);
    const brand = functionBody(reader?.text ?? '', 'Brand');
    expect(brand, 'Brand is in ReaderPage.tsx').not.toBeNull();
    expect(markTiles(sample(reader?.text.slice(...(brand ?? [0, 0])) ?? ''))).toHaveLength(1);
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

  it('mark_and_clay_colors_stay_in_their_components', () => {
    // The matchers, on known samples first: the mark's tokens, its parts' classes and its clay;
    // clay's token and color. The mark's own class and longer names aren't matched.
    expect(hits(MARK_PARTS, sample('fill: var(--mark-clay); .cd-mark__ink {} color: #D97757; rgb(217, 119, 87)'))).toHaveLength(4);
    expect(hits(MARK_PARTS, sample('.cd-mark { display: block } --bookmark-tile: 1; --marked: 1'))).toEqual([]);
    expect(hits(CLAY_PARTS, sample('background: var(--clay-soft); color: #E08968; rgb(224, 137, 104)'))).toHaveLength(3);
    expect(hits(CLAY_PARTS, sample('--clayton: 1; --mark-clay: 1'))).toEqual([]);

    // Every text file under src/, the design system's stories, boards and docs included.
    const everything = everyTextFile();
    const files = everything.map((s) => s.file);
    for (const file of ['ds/components/Mark/Mark.css', 'ds/components/IntroDialog/IntroDialog.css', 'ds/boards/parts.tsx', 'ds/README.md', 'about/reader.css']) {
      expect(files, file).toContain(file);
    }
    // The matchers find the real uses in their own folders, and nothing anywhere else.
    expect(hits(MARK_PARTS, everything.filter(({ file }) => file.startsWith(MARK_FOLDER))).length).toBeGreaterThan(0);
    expect(hits(CLAY_PARTS, everything.filter(({ file }) => file.startsWith(CLAY_FOLDER))).length).toBeGreaterThan(0);
    expect(hits(MARK_PARTS, everything.filter(({ file }) => !file.startsWith(MARK_FOLDER)))).toEqual([]);
    expect(hits(CLAY_PARTS, everything.filter(({ file }) => !file.startsWith(CLAY_FOLDER)))).toEqual([]);
  });
});
