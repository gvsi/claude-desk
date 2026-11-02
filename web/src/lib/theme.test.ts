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
  test('the_default_is_system', () => {
    expect(readTheme()).toBe('system');
    // Anything else stored under the key reads as the system's too.
    localStorage.setItem('claude-desk.theme', 'sepia');
    expect(readTheme()).toBe('system');
  });

  test('each_choice_marks_the_root_or_leaves_it_to_the_system', () => {
    const root = document.documentElement;
    applyTheme('light');
    expect(root.dataset.theme).toBe('light');
    applyTheme('dark');
    expect(root.dataset.theme).toBe('dark');
    applyTheme('system');
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  test('a_saved_choice_is_read_back_and_system_stores_nothing', () => {
    saveTheme('light');
    expect(readTheme()).toBe('light');
    saveTheme('dark');
    expect(readTheme()).toBe('dark');
    expect(localStorage.getItem('claude-desk.theme')).toBe('dark');
    saveTheme('system');
    expect(readTheme()).toBe('system');
    expect(localStorage.getItem('claude-desk.theme')).toBeNull();
  });

  test('blocked_storage_falls_back_to_system_without_throwing', () => {
    // A private window or blocked site data: every read and write throws.
    localStorage.setItem('claude-desk.theme', 'light');
    const blocked = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) vi.spyOn(Storage.prototype, method).mockImplementation(blocked);
    expect(readTheme()).toBe('system');
    for (const choice of ['light', 'dark', 'system'] as const) expect(() => saveTheme(choice)).not.toThrow();
    // The choice still shows for as long as the page is open.
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
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
      otherTab('claude-desk.theme', 'dark');
      expect(root.dataset.theme).toBe('dark');
      otherTab('claude-desk.theme', null);
      expect(root.hasAttribute('data-theme')).toBe(false);
      // Another key's change leaves the theme alone; storage cleared (no key) goes back to the system's.
      applyTheme('light');
      otherTab('claude-desk.last-desk', 'turner-plumbing');
      expect(root.dataset.theme).toBe('light');
      otherTab(null, null);
      expect(root.hasAttribute('data-theme')).toBe(false);
      expect(heard).toEqual(['light', 'dark', 'system', 'system']);
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
    localStorage.setItem('claude-desk.theme', 'dark');
    applyTheme(readTheme());
    const { now, unmount } = mountSwitch();
    try {
      expect(now().choice).toBe('dark');
      // Choosing applies, stores and shows the choice.
      act(() => now().choose('light'));
      expect([now().choice, document.documentElement.dataset.theme, localStorage.getItem('claude-desk.theme')]).toEqual(['light', 'light', 'light']);
      act(() => now().choose('system'));
      expect([now().choice, document.documentElement.hasAttribute('data-theme'), localStorage.getItem('claude-desk.theme')]).toEqual(['system', false, null]);
      // A choice made in another tab shows here too.
      act(() => {
        localStorage.setItem('claude-desk.theme', 'dark');
        window.dispatchEvent(new StorageEvent('storage', { key: 'claude-desk.theme', newValue: 'dark' }));
      });
      expect([now().choice, document.documentElement.dataset.theme]).toEqual(['dark', 'dark']);
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
      // And System hands it back to the device.
      act(() => again.now().choose('system'));
      expect([again.now().choice, document.documentElement.hasAttribute('data-theme')]).toEqual(['system', false]);
    } finally {
      again.unmount();
    }
  });
});
