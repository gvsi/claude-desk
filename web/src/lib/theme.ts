import { useCallback, useEffect, useState } from 'react';

import { readLocal, storageKey, writeLocal } from './storage.ts';

/**
 * The theme chosen in this browser: dark (the default), light or the system's. tokens.css draws
 * each one: dark on a root left unmarked, light on a root marked light, and the system's through
 * prefers-color-scheme on a root marked system, so the system's needs no listener here.
 * index.html's first script marks the root from the stored choice before the page first paints.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

/** The stored choice, or dark when there is none, it isn't one, or storage can't be read. */
export function readTheme(): ThemeChoice {
  const stored = readLocal('theme');
  return stored === 'light' || stored === 'system' ? stored : 'dark';
}

/**
 * The choice in force on this page: the root's light or system mark, or dark when it has neither.
 * index.html's first script marks the root from the stored choice, and every choice since marks it,
 * so this holds the choice even where storage is blocked and nothing could be kept.
 */
export function activeTheme(): ThemeChoice {
  const mark = document.documentElement.dataset.theme;
  return mark === 'light' || mark === 'system' ? mark : 'dark';
}

/** Marks the root with a light or system choice, or unmarks it for dark, the default. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'dark') delete root.dataset.theme;
  else root.dataset.theme = choice;
}

/** Stores the choice; dark, the default, stores nothing. Does nothing when storage can't be written. */
export function saveTheme(choice: ThemeChoice): void {
  writeLocal('theme', choice === 'dark' ? null : choice);
}

/**
 * Applies a choice made in another tab of this browser as soon as it is stored, and tells
 * `onChange`. Storage cleared there goes back to dark. Returns the function that stops it.
 */
export function watchTheme(onChange?: (choice: ThemeChoice) => void): () => void {
  const key = storageKey('theme');
  const heard = (event: StorageEvent) => {
    if (event.key !== null && event.key !== key) return;
    const choice = readTheme();
    applyTheme(choice);
    onChange?.(choice);
  };
  window.addEventListener('storage', heard);
  return () => window.removeEventListener('storage', heard);
}

/**
 * For the theme switch: the choice in force on this page, kept in step with other tabs, and how to
 * change it. It starts from the root's mark, not from storage, which a private window may block.
 */
export function useTheme(): { choice: ThemeChoice; choose: (choice: ThemeChoice) => void } {
  const [choice, setChoice] = useState(activeTheme);
  useEffect(() => watchTheme(setChoice), []);
  const choose = useCallback((next: ThemeChoice) => {
    saveTheme(next);
    applyTheme(next);
    setChoice(next);
  }, []);
  return { choice, choose };
}
