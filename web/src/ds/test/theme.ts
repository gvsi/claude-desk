/**
 * The theme for the design system's browser tests, whose context prefers dark and reduced motion:
 * a test that needs the light theme asks for it, by the system's preference or by the choice
 * index.html's first script applies, and both come back after the test.
 */
import { expect, onTestFinished } from 'vitest';
import { cdp } from 'vitest/browser';

/** Sets prefers-color-scheme for the page, as a visitor's system setting would, with motion still reduced. */
async function prefer(scheme: 'light' | 'dark'): Promise<void> {
  await cdp().send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: scheme },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ],
  });
}

/** The system prefers light for the rest of the test; dark, as the project has it, comes back after. */
export async function systemPrefersLight(): Promise<void> {
  await prefer('light');
  onTestFinished(() => prefer('dark'));
  expect(window.matchMedia('(prefers-color-scheme: light)').matches).toBe(true);
}

/** Marks the root with a theme chosen in this browser, or unmarks it for the system's, until the test ends. */
export function chooseTheme(choice: 'light' | 'dark' | 'system'): void {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  onTestFinished(() => {
    delete root.dataset.theme;
  });
}
