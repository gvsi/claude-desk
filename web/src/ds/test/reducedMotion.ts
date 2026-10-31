/**
 * prefers-reduced-motion for the design system's browser tests, whose context emulates reduce:
 * a test that needs motion turns it on for itself, and reduce comes back after the test.
 */
import { expect, onTestFinished } from 'vitest';
import { cdp } from 'vitest/browser';

/** Sets prefers-reduced-motion for the page, as a visitor's system setting would. */
export async function reduceMotion(reduce: boolean): Promise<void> {
  await cdp().send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }],
  });
}

/** Lets motion play for the rest of the test; reduced motion, as the project has it, comes back after. */
export async function motion(): Promise<void> {
  await reduceMotion(false);
  onTestFinished(() => reduceMotion(true));
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false);
}
