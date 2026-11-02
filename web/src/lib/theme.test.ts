import { StrictMode, act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { applyTheme, readTheme, saveTheme, useTheme, watchTheme, type ThemeChoice } from './theme.ts';

/** The theme switch's hook, drawn in strict mode as the app runs, and a way to take it down. */
function mountSwitch() {
  // React's own flag that this is a test environment where updates run inside act().
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const rendered: { theme?: ReturnType<typeof useTheme> } = {};
  function Switch() {
    rendered.theme = useTheme();
    return null;
  }
  const page = createRoot(document.createElement('div'));
  act(() => page.render(createElement(StrictMode, null, createElement(Switch))));
  return {
    now: () => {
      if (rendered.theme === undefined) throw new Error('The switch has not rendered.');
      return rendered.theme;
    },
    unmount: () => act(() => page.unmount()),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('theme', () => {
  test('the_default_is_dark', () => {
    expect(readTheme()).toBe('dark');
    // Anything else stored under the key reads as dark too.
    localStorage.setItem('claude-desk.theme', 'sepia');
    expect(readTheme()).toBe('dark');
  });

  test('light_or_system_marks_the_root_and_dark_leaves_it_unmarked', () => {
    const root = document.documentElement;
    applyTheme('light');
    expect(root.dataset.theme).toBe('light');
    applyTheme('system');
    expect(root.dataset.theme).toBe('system');
    applyTheme('dark');
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  test('a_saved_choice_is_read_back_and_dark_stores_nothing', () => {
    saveTheme('light');
    expect(readTheme()).toBe('light');
    saveTheme('system');
    expect(readTheme()).toBe('system');
    expect(localStorage.getItem('claude-desk.theme')).toBe('system');
    saveTheme('dark');
    expect(readTheme()).toBe('dark');
    expect(localStorage.getItem('claude-desk.theme')).toBeNull();
  });

  test('blocked_storage_falls_back_to_dark_without_throwing', () => {
    // A private window or blocked site data: every read and write throws.
    localStorage.setItem('claude-desk.theme', 'light');
    const blocked = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) vi.spyOn(Storage.prototype, method).mockImplementation(blocked);
    expect(readTheme()).toBe('dark');
    for (const choice of ['light', 'dark', 'system'] as const) expect(() => saveTheme(choice)).not.toThrow();
    // The choice still shows for as long as the page is open.
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  test('a_choice_made_in_another_tab_applies_here', () => {
    const root = document.documentElement;
    // Another tab's write: this tab's storage holds it, and this window hears of it.
    const otherTab = (key: string | null, value: string | null) => {
      if (key !== null) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }));
    };
    const heard: ThemeChoice[] = [];
    const stop = watchTheme((choice) => heard.push(choice));
    try {
      otherTab('claude-desk.theme', 'light');
      expect(root.dataset.theme).toBe('light');
      otherTab('claude-desk.theme', 'system');
      expect(root.dataset.theme).toBe('system');
      otherTab('claude-desk.theme', null);
      expect(root.hasAttribute('data-theme')).toBe(false);
      // Another key's change leaves the theme alone; storage cleared (no key) goes back to dark.
      applyTheme('light');
      otherTab('claude-desk.last-desk', 'turner-plumbing');
      expect(root.dataset.theme).toBe('light');
      otherTab(null, null);
      expect(root.hasAttribute('data-theme')).toBe(false);
      expect(heard).toEqual(['light', 'system', 'dark', 'dark']);
    } finally {
      stop();
    }
    // Once stopped, it no longer listens.
    otherTab('claude-desk.theme', 'light');
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(heard).toHaveLength(4);
  });

  test('the_hook_gives_the_choice_and_changes_it', () => {
    // A choice kept from before, as index.html's first script marks the root with it on load.
    localStorage.setItem('claude-desk.theme', 'system');
    applyTheme(readTheme());
    const { now, unmount } = mountSwitch();
    try {
      expect(now().choice).toBe('system');
      // Choosing applies, stores and shows the choice.
      act(() => now().choose('light'));
      expect([now().choice, document.documentElement.dataset.theme, localStorage.getItem('claude-desk.theme')]).toEqual(['light', 'light', 'light']);
      act(() => now().choose('dark'));
      expect([now().choice, document.documentElement.hasAttribute('data-theme'), localStorage.getItem('claude-desk.theme')]).toEqual(['dark', false, null]);
      // A choice made in another tab shows here too.
      act(() => {
        localStorage.setItem('claude-desk.theme', 'system');
        window.dispatchEvent(new StorageEvent('storage', { key: 'claude-desk.theme', newValue: 'system' }));
      });
      expect([now().choice, document.documentElement.dataset.theme]).toEqual(['system', 'system']);
    } finally {
      unmount();
    }
  });

  test('the_hook_shows_the_active_choice_when_storage_is_blocked', () => {
    // Nothing can be kept in a private window, but a choice made there still holds while the page is
    // open: the switch, drawn again on another visit to its page, shows the theme that is on.
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      });
    }
    const first = mountSwitch();
    act(() => first.now().choose('light'));
    first.unmount();
    expect(document.documentElement.dataset.theme).toBe('light');

    const again = mountSwitch();
    try {
      expect(again.now().choice).toBe('light');
      // And Dark goes back to the default, unmarked.
      act(() => again.now().choose('dark'));
      expect([again.now().choice, document.documentElement.hasAttribute('data-theme')]).toEqual(['dark', false]);
    } finally {
      again.unmount();
    }
  });
});
