import { useCallback, useEffect, useState } from 'react';

import { readLocal, storageKey, writeLocal } from './storage.ts';

/**
 * The theme chosen in this browser: the system's (the default), light or dark. tokens.css draws
 * each one: dark on a root marked dark, light on a root marked light, and the system's through
 * prefers-color-scheme while the root is marked neither, so the system's needs no listener here.
 * index.html's first script marks the root from the stored choice before the page first paints.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

/** The stored choice, or the system's when there is none, it isn't one, or storage can't be read. */
export function readTheme(): ThemeChoice {
  const stored = readLocal('theme');
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/** Marks the root with a light or dark choice, or unmarks it for the system's. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
}

/** Stores the choice; the system's stores nothing. Does nothing when storage can't be written. */
export function saveTheme(choice: ThemeChoice): void {
  writeLocal('theme', choice === 'system' ? null : choice);
}

/**
 * Applies a choice made in another tab of this browser as soon as it is stored, and tells
 * `onChange`. Storage cleared there goes back to the system's. Returns the function that stops it.
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

/** For the theme switch: the choice in this browser, kept in step with other tabs, and how to change it. */
export function useTheme(): { choice: ThemeChoice; choose: (choice: ThemeChoice) => void } {
  const [choice, setChoice] = useState(readTheme);
  useEffect(() => watchTheme(setChoice), []);
  const choose = useCallback((next: ThemeChoice) => {
    saveTheme(next);
    applyTheme(next);
    setChoice(next);
  }, []);
  return { choice, choose };
}
