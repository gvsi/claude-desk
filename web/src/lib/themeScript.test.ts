/**
 * index.html's first script: it marks the root with the theme chosen in this browser before the
 * page first paints, so a light or dark choice never flashes the other theme while the app loads.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { storageKey } from './storage.ts';

const INDEX_HTML = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.html'), 'utf8');
const page = new DOMParser().parseFromString(INDEX_HTML, 'text/html');

/** The page's first script, which must be a classic one written into the page. */
function themeScript(): HTMLScriptElement {
  const script = page.querySelector('script');
  if (script === null) throw new Error('index.html has no script');
  return script;
}

/** Runs the first script against this test's page and storage, as the browser runs it in the head. */
function runThemeScript(): void {
  new Function(themeScript().text)();
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
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
    // The browser's own scheme follows either theme before the styles load.
    expect(page.querySelector('meta[name="color-scheme"]')?.getAttribute('content')).toBe('dark light');
  });

  test('it_marks_the_root_with_a_light_or_dark_choice_and_leaves_the_system_its_own', () => {
    const root = document.documentElement;
    for (const choice of ['light', 'dark']) {
      localStorage.setItem(storageKey('theme'), choice);
      runThemeScript();
      expect(root.dataset.theme, choice).toBe(choice);
      delete root.dataset.theme;
    }
    // Nothing stored, or something that isn't a choice: the system's theme, so no mark.
    localStorage.clear();
    runThemeScript();
    expect(root.hasAttribute('data-theme')).toBe(false);
    localStorage.setItem(storageKey('theme'), 'sepia');
    runThemeScript();
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  test('blocked_storage_leaves_the_system_theme_without_throwing', () => {
    localStorage.setItem(storageKey('theme'), 'light');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(runThemeScript).not.toThrow();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
