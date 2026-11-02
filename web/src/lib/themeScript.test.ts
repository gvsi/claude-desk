/**
 * index.html's first script: it marks the root with the theme chosen in this browser before the
 * page first paints, so a light or system choice never flashes dark, the default, while the app loads.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { storageKey } from './storage.ts';

const INDEX_HTML = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.html'), 'utf8');
const page = new DOMParser().parseFromString(INDEX_HTML, 'text/html');

/** The page's first script, which must be a classic one written into the page. */
function themeScript(): HTMLScriptElement {
  const script = page.querySelector('script');
  if (script === null) throw new Error('index.html has no script');
  return script;
}

/** This test's page's own color-scheme meta, written as index.html writes it. */
function schemeMeta(): HTMLMetaElement {
  let meta = document.head.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (meta === null) {
    meta = document.createElement('meta');
    meta.name = 'color-scheme';
    document.head.append(meta);
  }
  return meta;
}

/** Runs the first script against this test's page and storage, as the browser runs it in the head. */
function runThemeScript(): void {
  new Function(themeScript().text)();
}

beforeEach(() => {
  schemeMeta().content = 'dark';
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  schemeMeta().remove();
});

describe('the theme script in index.html', () => {
  test('it_runs_in_the_head_before_any_stylesheet', () => {
    const script = themeScript();
    expect(script.parentElement).toBe(page.head);
    // Classic and written into the page, so it runs as the parser reaches it, before anything paints.
    expect([script.hasAttribute('src'), script.hasAttribute('type'), script.hasAttribute('async'), script.hasAttribute('defer')]).toEqual([
      false,
      false,
      false,
      false,
    ]);
    const head = [...page.head.children];
    const stylesheets = head.filter((el) => el.matches('link[rel="stylesheet"]'));
    expect(stylesheets.length).toBeGreaterThan(0);
    for (const sheet of stylesheets) expect(head.indexOf(script)).toBeLessThan(head.indexOf(sheet));
    // The browser's own scheme is dark, the default, before the styles load.
    expect(page.querySelector('meta[name="color-scheme"]')?.getAttribute('content')).toBe('dark');
  });

  test('it_marks_the_root_with_a_light_or_system_choice_and_leaves_dark_unmarked', () => {
    const root = document.documentElement;
    // The root is marked, and the page's scheme follows the choice, so the blank page before the
    // styles load is already in its colors: light alone, or both for the system to pick.
    for (const [choice, scheme] of [['light', 'light'], ['system', 'dark light']] as const) {
      localStorage.setItem(storageKey('theme'), choice);
      runThemeScript();
      expect([root.dataset.theme, schemeMeta().content], choice).toEqual([choice, scheme]);
      delete root.dataset.theme;
      schemeMeta().content = 'dark';
    }
    // Nothing stored, dark, or something that isn't a choice: dark, the default, so no mark and the
    // scheme stays dark.
    for (const stored of [null, 'dark', 'sepia']) {
      localStorage.clear();
      if (stored !== null) localStorage.setItem(storageKey('theme'), stored);
      runThemeScript();
      expect([root.hasAttribute('data-theme'), schemeMeta().content], String(stored)).toEqual([false, 'dark']);
    }
  });

  test('blocked_storage_leaves_the_dark_theme_without_throwing', () => {
    localStorage.setItem(storageKey('theme'), 'light');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(runThemeScript).not.toThrow();
    expect([document.documentElement.hasAttribute('data-theme'), schemeMeta().content]).toEqual([false, 'dark']);
  });
});
