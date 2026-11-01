/**
 * Source guards for the About this prototype pages. The pages are static: they make no request and read no
 * session, and the two documents and their parser load only with the reader, behind its route's `import()`, so
 * a document that can't be parsed never reaches the app's entry module.
 *
 * Each guard first proves its matcher on known-bad samples, so it can't pass by matching nothing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every TypeScript source under `web/src/`, by its path from there with forward slashes. */
function sources(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .map((file) => file.split(path.sep).join('/'))
      .filter((file) => /\.tsx?$/.test(file))
      .sort()
      .map((file) => [file, readFileSync(path.join(SRC, file), 'utf8')]),
  );
}

/** Tests may load what they check; only the code that ships is held to these rules. */
function isTest(file: string): boolean {
  return /\.test\.tsx?$/.test(file);
}

// Anything that sends a request or opens a stream: fetch, the query library's fetching hooks (the pages read
// nothing from its cache either), EventSource, XMLHttpRequest, WebSocket and beacons.
const FETCHING =
  /\bfetch\s*\(|\b(?:useMutation|use(?:Suspense)?(?:Infinite)?Quer(?:y|ies)|EventSource|XMLHttpRequest|WebSocket|sendBeacon)\b/g;

function fetching(text: string): string[] {
  return [...text.matchAll(FETCHING)].map((match) => match[0]);
}

interface Import {
  /** The specifier as written. */
  spec: string;
  /** The file it names, from `web/src/`, or the specifier itself for a package or a file outside the sources. */
  to: string;
  /** Through `import()`, which loads it on demand rather than with the importing module. */
  dynamic: boolean;
}

// Static imports and re-exports, side-effect imports included; `import type` and `export type` are erased.
const STATIC_IMPORT = /(?:^|[;\n])\s*(?:import|export)\s+(type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?(['"])([^'"\n]+)\2/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;

function importsOf(file: string, text: string, files: ReadonlySet<string>): Import[] {
  const resolve = (spec: string): string => {
    if (!spec.startsWith('.')) return spec;
    const bare = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec.replace(/\?.*$/, '')));
    return ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].map((end) => bare + end).find((name) => files.has(name)) ?? bare;
  };
  const found: Import[] = [];
  for (const [, type, , spec = ''] of text.matchAll(STATIC_IMPORT)) {
    if (!type) found.push({ spec, to: resolve(spec), dynamic: false });
  }
  for (const [, , spec = ''] of text.matchAll(DYNAMIC_IMPORT)) found.push({ spec, to: resolve(spec), dynamic: true });
  return found;
}

// What only the reader may load: the registry, the parser and the page. The page's own figures load the
// registry with it.
const READER_ONLY = ['about/documents.ts', 'about/markdown.ts', 'about/ReaderPage.tsx'];
const READER = (file: string) => file === 'about/ReaderPage.tsx' || /^about\/figures\/[^/]+\.tsx$/.test(file);
// The page's chrome, which renders when the reader can't (or hasn't yet: the wait while it loads), and the set's top
// bar, which the Vision article draws too: never the registry or the page, even on demand.
const CHROME = ['about/ReaderError.tsx', 'about/AboutWait.tsx', 'about/PrototypeLink.tsx', 'about/links.ts', 'about/AboutBar.tsx'];
// The one `import()` that may load the reader: the router's, of the page itself.
const ON_DEMAND = { from: 'app/routes.tsx', to: 'about/ReaderPage.tsx' };

/** Each way the sources break the reader's import rules, as "file: what". Tests are exempt. */
function importProblems(sources: Record<string, string>): string[] {
  const files = new Set(Object.keys(sources));
  const graph = new Map(
    Object.entries(sources)
      .filter(([file]) => !isTest(file))
      .map(([file, text]) => [file, importsOf(file, text, files)] as const),
  );
  const loadsWith = (file: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [file];
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      for (const { to, dynamic } of graph.get(next) ?? []) {
        if (dynamic || seen.has(to)) continue;
        seen.add(to);
        queue.push(to);
      }
    }
    return seen;
  };
  const problems: string[] = [];
  for (const [file, imports] of graph) {
    for (const { spec, to, dynamic } of imports) {
      const document = to === 'about/markdown.ts' || /\.md(?:\?|$)/.test(spec);
      if (document && file !== 'about/documents.ts') problems.push(`${file}: imports ${spec}, which only documents.ts may`);
      if (CHROME.includes(file) && (to === 'about/documents.ts' || to === 'about/ReaderPage.tsx')) {
        problems.push(`${file}: imports ${spec}, which the page's chrome never loads`);
      }
      if (file.startsWith('about/') && (/^(?:api|owner|mocks)\//.test(to) || spec.startsWith('@tanstack/'))) {
        problems.push(`${file}: imports ${spec}, and the About pages make no requests`);
      }
      // On demand, the registry, the parser and the page load only from the router, by the page itself, so
      // a document that can't be parsed fails on its own page and nowhere else.
      if (dynamic && !(file === ON_DEMAND.from && to === ON_DEMAND.to)) {
        const brings = READER_ONLY.filter((name) => name === to || loadsWith(to).has(name));
        if (brings.length > 0) {
          problems.push(`${file}: loads ${brings.join(', ')} through import(${spec}); only routes.tsx may, and only ReaderPage.tsx`);
        }
      }
    }
    // Outside the reader, the registry, the parser and the page load only through `import()`: this covers
    // the router and the owner shell, which imports only links.ts.
    const loaded = READER_ONLY.filter((name) => name !== file && loadsWith(file).has(name));
    if (loaded.length > 0 && !READER(file) && file !== 'about/documents.ts') {
      problems.push(`${file}: loads ${loaded.join(', ')} with itself, not through import()`);
    }
  }
  return problems;
}

// Helpers with one home in the shipped About sources, which the rest import rather than copy: the month names, and
// the walk that reads a run of inlines as words.
const ONE_HOME: Record<string, { home: string; copy: RegExp }> = {
  'the month names': { home: 'about/months.ts', copy: /(['"])January\1\s*,\s*(['"])February\2/ },
  'the words of a run of inlines': { home: 'about/markdown.ts', copy: /(['"])children\1\s+in\s+[\w$]+\s*\?/ },
  'the reduced-motion query': { home: 'about/motion.ts', copy: /prefers-reduced-motion:\s*reduce/ },
};

/** The shipped About sources that hold each helper. */
function helperHomes(sources: Record<string, string>): Record<string, string[]> {
  const shipped = Object.entries(sources).filter(([file]) => file.startsWith('about/') && !isTest(file));
  return Object.fromEntries(
    Object.entries(ONE_HOME).map(([helper, { copy }]) => [helper, shipped.filter(([, text]) => copy.test(text)).map(([file]) => file)]),
  );
}

/**
 * The one place a figure's play marks may take effect: on screen, for a reader who hasn't asked for reduced motion.
 * A rule outside it would hide or move a figure's parts on paper or under reduced motion, where the figure must be
 * drawn complete.
 */
const MOTION_BLOCK = '@media screen and (prefers-reduced-motion: no-preference)';

interface PlayRule {
  /** The rule's selector, its whitespace collapsed. */
  selector: string;
  /** Whether it sits inside `MOTION_BLOCK`, at any depth. */
  inMotion: boolean;
}

/** Every rule in a stylesheet whose selector names `data-play`, and whether it sits inside `MOTION_BLOCK`. */
function playRules(css: string): PlayRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const collapse = (prelude: string) => prelude.trim().replace(/\s+/g, ' ').replace(/:\s*/g, ': ');
  const motion = collapse(MOTION_BLOCK);
  // The preludes of the blocks around the current place, outermost first.
  const around: string[] = [];
  const found: PlayRule[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '{') {
      const prelude = text.slice(start, i).trim().replace(/\s+/g, ' ');
      if (!prelude.startsWith('@') && prelude.includes('data-play')) {
        found.push({ selector: prelude, inMotion: around.some((outer) => collapse(outer) === motion) });
      }
      around.push(prelude);
    } else if (char === '}') {
      around.pop();
    }
    if (char === '{' || char === '}' || char === ';') start = i + 1;
  }
  return found;
}

describe('About page source guards', () => {
  it('play_marks_apply_only_on_screen_with_motion', () => {
    const outside = (css: string) => playRules(css).filter((rule) => !rule.inMotion).map((rule) => rule.selector);
    const hide = "[data-play='ready'] .part { opacity: 0; }";
    const hidden = "[data-play='ready'] .part";
    // Each place a play rule would reach print or reduced motion, a comment that only looks like the block included.
    const bad: [string, string][] = [
      [hide, hidden],
      [`@media (prefers-reduced-motion: no-preference) { ${hide} }`, hidden],
      [`@media screen { ${hide} }`, hidden],
      [`@media print { ${hide} }`, hidden],
      [`@supports (clip-path: inset(0)) { ${hide} }`, hidden],
      [`/* ${MOTION_BLOCK} { */ ${hide}`, hidden],
      [
        `${MOTION_BLOCK} { .chart { color: red; } }\n.chart:is(\n  [data-play='played']\n) .part { animation: none; }`,
        ".chart:is( [data-play='played'] ) .part",
      ],
    ];
    for (const [css, selector] of bad) expect(outside(css), css).toEqual([selector]);
    // Inside the block, at any depth, a rule may name the marks; outside it, other rules may do as they like.
    const good = [
      `${MOTION_BLOCK} { ${hide} }`,
      `${MOTION_BLOCK} {\n  .chart { --step: 1; }\n  @supports (clip-path: inset(0)) { ${hide} }\n  @keyframes fade { from { opacity: 0; } }\n}`,
      `@media   screen and (prefers-reduced-motion:   no-preference) {\n${hide}\n}`,
      '.chart { opacity: 1; } @media print { .chart { break-inside: avoid; } }',
    ];
    for (const css of good) expect(outside(css), css).toEqual([]);
    expect(playRules(`${MOTION_BLOCK} { ${hide} }`)).toEqual([{ selector: "[data-play='ready'] .part", inMotion: true }]);

    // The readers' stylesheet keys its figures on the marks, and only inside the block.
    const reader = readFileSync(path.join(SRC, 'about/reader.css'), 'utf8');
    expect(playRules(reader).length).toBeGreaterThan(0);
    expect(outside(reader)).toEqual([]);
  });

  const all = sources();
  const about = Object.entries(all).filter(([file]) => file.startsWith('about/') && !isTest(file));

  it('about_styles_set_no_scroll_behavior', () => {
    // Only a contents link's jump glides, through its own handler. A scroll-behavior in a stylesheet would glide every
    // scroll that names no behavior: a focused link brought into view, the end-to-end test's own scrolls.
    const setsScrollBehavior = (css: string) => /(?<![\w-])scroll-behavior\s*:/.test(css.replace(/\/\*[\s\S]*?\*\//g, ''));
    for (const css of ['html { scroll-behavior: smooth; }', '.cd-about-page{scroll-behavior:auto}', '@media screen { :root { scroll-behavior : smooth } }']) {
      expect(setsScrollBehavior(css), css).toBe(true);
    }
    for (const css of ['.fold { overscroll-behavior: contain; }', '/* no scroll-behavior: smooth here */ .x { color: red; }']) {
      expect(setsScrollBehavior(css), css).toBe(false);
    }

    const sheets = readdirSync(path.join(SRC, 'about'), { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.css'));
    expect(sheets).toContain('reader.css');
    expect(sheets.filter((file) => setsScrollBehavior(readFileSync(path.join(SRC, 'about', file), 'utf8')))).toEqual([]);
  });

  it('about_has_no_fetching', () => {
    const bad = [
      "await fetch('/api/x')",
      'window.fetch (url)',
      'useMutation({ mutationFn })',
      'useQuery({ queryKey })',
      'useSuspenseQuery(options)',
      'useInfiniteQuery(options)',
      'useQueries({ queries })',
      'new EventSource(url)',
      'new XMLHttpRequest()',
      'new WebSocket(url)',
      'navigator.sendBeacon(url)',
    ];
    for (const sample of bad) expect(fetching(sample), sample).toHaveLength(1);
    // Names that only contain the words aren't requests.
    expect(fetching('prefetchData(); const fetched = refetch; useQueryClient(); fetchCount += 1;')).toEqual([]);

    expect(about.map(([file]) => file)).toEqual(expect.arrayContaining(['about/documents.ts', 'about/links.ts', 'about/markdown.ts']));
    expect(about.flatMap(([file, text]) => fetching(text).map((hit) => `${file}: ${hit}`))).toEqual([]);
  });

  it('only_the_reader_imports_the_documents', () => {
    // The reader as it will be wired: the router loads the page on demand and shows ReaderError statically.
    const wired: Record<string, string> = {
      'about/markdown.ts': 'export function parseDocument() {}',
      'about/documents.ts': [
        "import proposal from '../../../docs/product-proposal.md?raw';",
        "import { ABOUT_PAGES } from './links.ts';",
        "import { parseDocument, type Block } from './markdown.ts';",
        "export { documentText } from './markdown.ts';",
      ].join('\n'),
      'about/links.ts': "import type { SidebarAbout } from '../ds/index.ts';",
      'about/ReaderPage.tsx': "import {\n  ABOUT_DOCUMENTS,\n} from './documents.ts';\nimport { Tau3Chart } from './figures/Tau3Chart.tsx';",
      'about/figures/Tau3Chart.tsx': "import { ABOUT_DOCUMENTS } from '../documents.ts';\nimport '../reader.css';",
      'about/ReaderError.tsx': "import { PrototypeLink } from './PrototypeLink.tsx';",
      'about/PrototypeLink.tsx': "import { readLocal } from '../lib/storage.ts';",
      'about/reader.browser.test.tsx': "import { parseDocument } from './markdown.ts';\nimport md from '../../../docs/x.md?raw';",
      'lib/storage.ts': 'export function readLocal() {}',
      'app/routes.tsx': [
        "import { ReaderError } from '../about/ReaderError.tsx';",
        "import { ABOUT_PAGES, type AboutId } from '../about/links.ts';",
        'const lazy = async () => {',
        "  const { ReaderPage } = await import('../about/ReaderPage.tsx');",
        '  return { element: ReaderPage, errorElement: ReaderError };',
        '};',
      ].join('\n'),
      'owner/OwnerLayout.tsx': "import { ABOUT_LINKS } from '../about/links.ts';",
      'main.tsx': "import { routes } from './app/routes.tsx';\nimport.meta.env.MODE;",
    };
    expect(importProblems(wired)).toEqual([]);
    // Type-only imports are erased, so they load nothing.
    expect(importProblems({ ...wired, 'about/links.ts': "import type { AboutDocument } from './documents.ts';" })).toEqual([]);

    const broken: [string, string, string][] = [
      ['about/ReaderPage.tsx', "import { parseDocument } from './markdown.ts';", 'only documents.ts may'],
      ['about/links.ts', "import md from '../../../docs/product-proposal.md?raw';", 'only documents.ts may'],
      ['about/ReaderError.tsx', "import {\n  ABOUT_DOCUMENTS,\n} from './documents.ts';", 'chrome never loads'],
      ['about/AboutWait.tsx', "import { ReaderPage } from './ReaderPage.tsx';", 'chrome never loads'],
      ['about/PrototypeLink.tsx', "const page = () => import('./ReaderPage.tsx');", 'chrome never loads'],
      ['about/links.ts', "export * from './documents';", 'chrome never loads'],
      ['owner/OwnerLayout.tsx', "import { ABOUT_DOCUMENTS } from '../about/documents.ts';", 'not through import()'],
      ['app/routes.tsx', "import { ReaderPage } from '../about/ReaderPage.tsx';", 'not through import()'],
      ['app/routes.tsx', "import { ReaderPage } from './about.ts';", 'not through import()'],
      ['main.tsx', "import { ABOUT_LINKS } from './about/links.ts';\nimport './about/documents.ts';", 'not through import()'],
      // On demand, only the router may load the reader, and only by its page.
      ['owner/OwnerLayout.tsx', "const docs = () => import('../about/documents.ts');", 'only routes.tsx may'],
      ['owner/OwnerLayout.tsx', "const reader = () => import('../about/ReaderPage.tsx');", 'only routes.tsx may'],
      ['owner/OwnerLayout.tsx', "const chart = () => import('../about/figures/Tau3Chart.tsx');", 'only routes.tsx may'],
      ['app/routes.tsx', "const docs = () => import('../about/documents.ts');", 'only routes.tsx may'],
      ['app/routes.tsx', "const reader = () => import('./about.ts');", 'only routes.tsx may'],
      ['about/PrototypeLink.tsx', "import { request } from '../api/http.ts';", 'make no requests'],
      ['about/ReaderPage.tsx', "import { useQuery } from '@tanstack/react-query';", 'make no requests'],
      ['about/PrototypeLink.tsx', "import { useDesks } from '../owner/useDesks.ts';", 'make no requests'],
    ];
    for (const [file, text, problem] of broken) {
      // A module the router reaches statically that re-exports the page.
      const sources = { ...wired, 'app/about.ts': "export { ReaderPage } from '../about/ReaderPage.tsx';", [file]: text };
      const found = importProblems(sources);
      expect(found.filter((line) => line.startsWith(`${file}: `) && line.includes(problem)), `${file}: ${text}`).not.toEqual([]);
    }

    const real = sources();
    expect(Object.keys(real)).toEqual(expect.arrayContaining(['about/documents.ts', 'about/links.ts', 'about/markdown.ts']));
    // The router does load the page on demand, so the one exception above is the path the app takes.
    expect(importsOf('app/routes.tsx', real['app/routes.tsx'] ?? '', new Set(Object.keys(real)))).toContainEqual({
      spec: '../about/ReaderPage.tsx',
      to: 'about/ReaderPage.tsx',
      dynamic: true,
    });
    expect(importProblems(real)).toEqual([]);
  });

  it('about_helpers_have_one_home', () => {
    // Copies as they would be written, in a shipped file and in a test, which may hold its own.
    const copies = {
      'about/ReaderPage.tsx': "const MONTHS = [\n  'January',\n  'February',\n];",
      'about/figures/Chart.tsx': 'const NAMES = ["January", "February"] as const;',
      'about/Inlines.tsx': "inlines.map((inline) => ('children' in inline ? words(inline.children) : inline.text))",
      'about/months.test.ts': "expect(MONTHS.slice(0, 2)).toEqual(['January', 'February']);",
      'owner/format.ts': "const MONTHS = ['January', 'February'];",
      'about/figures/usePlayOnce.ts': "window.matchMedia('(prefers-reduced-motion: reduce)').matches",
      'about/reader.motion.test.ts': "matchMedia('(prefers-reduced-motion:reduce)')",
    };
    expect(helperHomes(copies)).toEqual({
      'the month names': ['about/ReaderPage.tsx', 'about/figures/Chart.tsx'],
      'the words of a run of inlines': ['about/Inlines.tsx'],
      'the reduced-motion query': ['about/figures/usePlayOnce.ts'],
    });

    expect(helperHomes(sources())).toEqual(
      Object.fromEntries(Object.entries(ONE_HOME).map(([helper, { home }]) => [helper, [home]])),
    );
  });
});
