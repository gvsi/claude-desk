/**
 * The About pages' figures with motion, in the `about-motion` project: a reader who hasn't asked for reduced
 * motion. What each figure draws, and that it is complete under reduced motion, is checked in
 * figures.browser.test.tsx; this file checks how a figure plays. Expected timings are written out here, never
 * read from the components or their styles.
 */
import { describe, expect, it } from 'vitest';

describe('the about-motion project', () => {
  it('motion_project_runs_with_motion', () => {
    expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false);
    expect(matchMedia('(prefers-reduced-motion: no-preference)').matches).toBe(true);
  });
});
