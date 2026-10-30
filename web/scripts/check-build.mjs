#!/usr/bin/env node
// Checks the hosting build before it ships: the hosted site serves `dist/` as built, so this is the
// line that keeps the mock API off it. It fails when `dist/index.html` is missing, or when any file
// under `dist/` carries the mock: its service worker, its handlers or store, its dev server plugin,
// or the dev server's cookie handling, by name or in its text.
//   node scripts/check-build.mjs          check web/dist
//   node scripts/check-build.mjs <dir>    check another build folder

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The signs of mock code, each as a pattern. `Set-Cookie` is a header name, so any case counts;
 * the rest are the mock's own names.
 */
const MARKERS = [
  ['mockServiceWorker', /mockServiceWorker/],
  ['setupWorker', /setupWorker/],
  ['msw/browser', /msw\/browser/],
  ['createMockApi', /createMockApi/],
  ['mockApiPlugin', /mockApiPlugin/],
  ['mockStore', /mockStore/],
  ['Set-Cookie', /set-cookie/i],
];

/** Every file under `dir`, as paths relative to it with `/` separators, sorted. */
function filesUnder(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      return entry.isDirectory() ? filesUnder(path.join(dir, entry.name), rel) : [rel];
    })
    .sort();
}

/**
 * The files checked in the build in `distDir`, and what is wrong with it, one line each (none when
 * it can ship). Files are read byte for byte (latin1), so a marker is found in any file, text or not.
 */
export function checkBuild(distDir) {
  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    return { files: [], problems: [`${distDir} is not a build folder: run npm run build first`] };
  }
  const files = filesUnder(distDir);
  const problems = [];
  if (!files.includes('index.html')) problems.push('index.html is missing');
  for (const file of files) {
    const text = readFileSync(path.join(distDir, file), 'latin1');
    for (const [name, pattern] of MARKERS) {
      if (pattern.test(file)) problems.push(`${file}: its name carries ${name}`);
      else if (pattern.test(text)) problems.push(`${file}: carries ${name}`);
    }
  }
  return { files, problems };
}

const run = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (run) {
  const distDir = path.resolve(process.argv[2] ?? fileURLToPath(new URL('../dist', import.meta.url)));
  const { files, problems } = checkBuild(distDir);
  if (problems.length > 0) {
    console.error(`Build check failed for ${distDir}:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`Build check clean: ${files.length} files in ${distDir}, no mock code, mock routes or dev cookies.`);
}
