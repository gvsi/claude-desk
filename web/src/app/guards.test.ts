/**
 * Source guards for the app: everything under `src/` that runs in a browser, except the design
 * system (it has its own guards), the mock API and tests. Each guard first proves its matcher on a
 * known-bad sample, so it can't pass by matching nothing.
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

// Formatting money or dates: the visitor's page shows only what the kernel rendered.
const FORMATS = /\blib\/format\b|\bIntl\.|\btoLocale\w*|\bnew\s+Date\b|\btoFixed\(/;

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

  it('visitor_code_never_formats_money_or_dates', () => {
    const visitor = (s: Source) => s.file.startsWith('public/') && !s.file.startsWith('public/checkout/');
    const bad = "import { formatCents } from '../lib/format.ts'; new Intl.NumberFormat(); d.toLocaleString(); new Date(); n.toFixed(2);";
    expect(hits(FORMATS, sample(bad))).toHaveLength(5);
    expect(hits(FORMATS, sources.filter(visitor))).toEqual([]);
  });
});
