/**
 * Chat renders Markdown with Streamdown alone: its code highlighting (Shiki), math (KaTeX) and
 * diagrams (Mermaid) come only as separate plugins, and none of them is installed, so none can
 * reach the bundle. Streamdown's core still emits two small lazy chunks of its own
 * (`mermaid-*.js`, a one-line re-export, and `highlighted-body-*.js`), which load none of those
 * libraries and which ChatMarkdown never renders, since it draws code blocks itself.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** A package of code highlighting, math or diagrams, wherever it sits in `node_modules`. */
const HEAVY = /(?:^|\/)node_modules\/(?:shiki|@shikijs\/[^/]+|katex|mermaid|@streamdown\/[^/]+)$/;

/** The heavy packages a lockfile installs. */
function heavyPackages(lock: { packages: Record<string, unknown> }): string[] {
  return Object.keys(lock.packages).filter((name) => HEAVY.test(name));
}

it('no_code_math_or_diagram_bundle_is_installed', () => {
  const planted = {
    packages: {
      '': {},
      'node_modules/streamdown': {},
      'node_modules/katex': {},
      'node_modules/a/node_modules/shiki': {},
      'node_modules/@shikijs/core': {},
      'node_modules/mermaid': {},
      'node_modules/@streamdown/math': {},
      'node_modules/katex-lite': {},
    },
  };
  expect(heavyPackages(planted)).toEqual([
    'node_modules/katex',
    'node_modules/a/node_modules/shiki',
    'node_modules/@shikijs/core',
    'node_modules/mermaid',
    'node_modules/@streamdown/math',
  ]);
  const lock = JSON.parse(readFileSync(path.join(WEB, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> };
  // It reads the lockfile that installs Streamdown, so it can't pass by reading nothing.
  expect(lock.packages['node_modules/streamdown']?.version).toBe('2.7.0');
  expect(heavyPackages(lock)).toEqual([]);
});
