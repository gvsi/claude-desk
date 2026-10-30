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

/** Reads of an open status's times outside `openStatusDelayMs`. */
function timeReadsOutsideTheHelper(scanned: Source[]): string[] {
  return scanned.flatMap(({ file, text }) => {
    const body = functionBody(text, 'openStatusDelayMs');
    return [...text.matchAll(STATUS_TIME)]
      .filter((m) => body === null || m.index < body[0] || m.index >= body[1])
      .map((m) => `${file}: ${m[0]}`);
  });
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
    const visitor = (s: Source) => s.file.startsWith('public/') && !s.file.startsWith('public/checkout/');
    const bad = "import { formatCents } from '../lib/format.ts'; new Intl.NumberFormat(); d.toLocaleString(); new Date(); n.toFixed(2);";
    expect(hits(FORMATS, sample(bad))).toHaveLength(5);
    expect(hits(FORMATS, sources.filter(visitor))).toEqual([]);
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

    // The times are read only to schedule the next refetch.
    const helper = 'export function openStatusDelayMs(status: OpenStatus): number {\n  return Date.parse(status.refresh_at) - Date.parse(status.as_of);\n}\n';
    expect(timeReadsOutsideTheHelper(sample(helper))).toEqual([]);
    expect(timeReadsOutsideTheHelper(sample(`${helper}const late = status['until'];\nconst { opens_at } = status;\nx.refresh_at;`))).toHaveLength(3);
    expect(timeReadsOutsideTheHelper(visitor)).toEqual([]);
    expect(functionBody(hook?.text ?? '', 'openStatusDelayMs'), 'openStatusDelayMs is in useOpenStatus.ts').not.toBeNull();
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
