// @vitest-environment node
// The hosting build check (check-build.mjs), run as CI and the deploy's preflight run it: a dist
// that carries any of the mock's code, its routes or its dev cookies fails, and a clean one passes.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./check-build.mjs', import.meta.url));

const INDEX_HTML = '<!doctype html><html><head><script type="module" src="/assets/index-a1.js"></script></head><body><div id="root"></div></body></html>';
const CLEAN_JS = 'const root=document.getElementById("root");fetch("/api/owner/me",{credentials:"same-origin"});';

/** Every temp dist made by a test, removed after it. */
const made = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A dist in a temp folder: `files` maps each path under it to its text. */
function dist(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-build-'));
  made.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

/** Runs the script on `dir` as `npm run check:build` would; its exit code and what it printed. */
function check(dir) {
  const run = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

describe('check-build', () => {
  it('fails_on_msw_in_dist', () => {
    const leaked = dist({ 'index.html': INDEX_HTML, 'assets/index-a1.js': CLEAN_JS, 'assets/browser-b2.js': 'const w=setupWorker(...h);' });
    const result = check(leaked);
    expect(result.status).toBe(1);
    expect(result.out).toContain('assets/browser-b2.js');
    expect(result.out).toContain('setupWorker');

    // Every other sign of the mock fails it too, in a file's text or in its name.
    for (const marker of ['mockServiceWorker', 'msw/browser', 'createMockApi', 'mockApiPlugin', 'mockStore', 'Set-Cookie', 'set-cookie']) {
      const named = check(dist({ 'index.html': INDEX_HTML, 'assets/index-a1.js': `${CLEAN_JS}const x=${JSON.stringify(marker)};` }));
      expect(named.status, marker).toBe(1);
      expect(named.out, marker).toContain('assets/index-a1.js');
    }
    const worker = check(dist({ 'index.html': INDEX_HTML, 'assets/index-a1.js': CLEAN_JS, 'mockServiceWorker.js': '/* Mock Service Worker. */' }));
    expect(worker.status).toBe(1);
    expect(worker.out).toContain('mockServiceWorker.js');
  });

  it('fails_without_index_html', () => {
    const result = check(dist({ 'assets/index-a1.js': CLEAN_JS }));
    expect(result.status).toBe(1);
    expect(result.out).toContain('index.html');
  });

  it('passes_on_a_clean_dist', () => {
    const result = check(dist({ 'index.html': INDEX_HTML, 'assets/index-a1.js': CLEAN_JS, 'assets/index-c3.css': ':root{--cd-app:#1c1b19}' }));
    expect(result.out).toContain('3 files');
    expect(result.status).toBe(0);
  });
});
