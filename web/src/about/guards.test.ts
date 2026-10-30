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
// The page's chrome, which renders when the reader can't: never the registry or the page, even on demand.
const CHROME = ['about/ReaderError.tsx', 'about/BackLink.tsx', 'about/links.ts'];

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
    for (const { spec, to } of imports) {
      const document = to === 'about/markdown.ts' || /\.md(?:\?|$)/.test(spec);
      if (document && file !== 'about/documents.ts') problems.push(`${file}: imports ${spec}, which only documents.ts may`);
      if (CHROME.includes(file) && (to === 'about/documents.ts' || to === 'about/ReaderPage.tsx')) {
        problems.push(`${file}: imports ${spec}, which the page's chrome never loads`);
      }
      if (file.startsWith('about/') && (/^(?:api|owner|mocks)\//.test(to) || spec.startsWith('@tanstack/'))) {
        problems.push(`${file}: imports ${spec}, and the About pages make no requests`);
      }
    }
    // Outside the reader, the registry, the parser and the page load only through `import()`: this covers
    // the router (Task 4b's routes.tsx) and the owner shell, which imports only links.ts.
    const loaded = READER_ONLY.filter((name) => name !== file && loadsWith(file).has(name));
    if (loaded.length > 0 && !READER(file) && file !== 'about/documents.ts') {
      problems.push(`${file}: loads ${loaded.join(', ')} with itself, not through import()`);
    }
  }
  return problems;
}

describe('About page source guards', () => {
  const all = sources();
  const about = Object.entries(all).filter(([file]) => file.startsWith('about/') && !isTest(file));

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
      'about/ReaderError.tsx': "import { BackLink } from './BackLink.tsx';",
      'about/BackLink.tsx': "import { readLocal } from '../lib/storage.ts';",
      'about/reader.browser.test.tsx': "import { parseDocument } from './markdown.ts';\nimport md from '../../../docs/x.md?raw';",
      'lib/storage.ts': 'export function readLocal() {}',
      'app/routes.tsx': [
        "import { ReaderError } from '../about/ReaderError.tsx';",
        "const reader = { lazy: () => import('../about/ReaderPage.tsx'), errorElement: ReaderError };",
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
      ['about/BackLink.tsx', "const page = () => import('./ReaderPage.tsx');", 'chrome never loads'],
      ['about/links.ts', "export * from './documents';", 'chrome never loads'],
      ['owner/OwnerLayout.tsx', "import { ABOUT_DOCUMENTS } from '../about/documents.ts';", 'not through import()'],
      ['app/routes.tsx', "import { ReaderPage } from '../about/ReaderPage.tsx';", 'not through import()'],
      ['app/routes.tsx', "import { ReaderPage } from './about.ts';", 'not through import()'],
      ['main.tsx', "import { ABOUT_LINKS } from './about/links.ts';\nimport './about/documents.ts';", 'not through import()'],
      ['about/BackLink.tsx', "import { request } from '../api/http.ts';", 'make no requests'],
      ['about/ReaderPage.tsx', "import { useQuery } from '@tanstack/react-query';", 'make no requests'],
      ['about/BackLink.tsx', "import { useDesks } from '../owner/useDesks.ts';", 'make no requests'],
    ];
    for (const [file, text, problem] of broken) {
      // A module the router reaches statically that re-exports the page.
      const sources = { ...wired, 'app/about.ts': "export { ReaderPage } from '../about/ReaderPage.tsx';", [file]: text };
      const found = importProblems(sources);
      expect(found.filter((line) => line.startsWith(`${file}: `) && line.includes(problem)), `${file}: ${text}`).not.toEqual([]);
    }

    const real = sources();
    expect(Object.keys(real)).toEqual(expect.arrayContaining(['about/documents.ts', 'about/links.ts', 'about/markdown.ts']));
    expect(importProblems(real)).toEqual([]);
  });
});
