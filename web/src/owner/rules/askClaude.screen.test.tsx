/**
 * Ask Claude opening beside the Rules page, in a real browser against the mock API: the page is
 * laid out beside the panel at once and glides there from where it was, so what the owner just
 * used doesn't leap from under them. Under reduced motion the page is in its new place at once.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import { cdp, userEvent } from 'vitest/browser';

import { RIVERA } from '../../mocks/seed.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll } from '../../test/screen.ts';

const RULES = `/app/${RIVERA.deskId}/rules`;
const ASK = 'Stop quoting on weekends';

/** Sets prefers-reduced-motion for the page, back to no preference after the test. */
async function reduceMotion(): Promise<void> {
  await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  onTestFinished(async () => {
    await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  });
  await expect.poll(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
}

describe('ask claude', () => {
  it('ask_claude_opens_without_the_page_jumping', async () => {
    // Every animation on the page held at its first frame while the owner sends, then let go.
    await cdp().send('Animation.enable');
    onTestFinished(async () => {
      await cdp().send('Animation.setPlaybackRate', { playbackRate: 1 });
    });
    const { screen } = await renderRoute(RULES);
    const composer = screen.getByRole('textbox', { name: 'Ask Claude to change a rule' });
    await expect.element(composer).toBeVisible();
    const sent = composer.element().getBoundingClientRect().left;
    await cdp().send('Animation.setPlaybackRate', { playbackRate: 0 });
    await composer.fill(ASK);
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByRole('complementary', { name: 'Ask Claude' })).toBeVisible();

    // At its first frame the page is where it was, though it is laid out beside the panel already.
    const content = screen.container.querySelector('.cd-app-shell__content') as HTMLElement;
    const glides = content.getAnimations();
    expect(glides).toHaveLength(1);
    expect(composer.element().getBoundingClientRect().left).toBeCloseTo(sent, 0);
    expectNoHorizontalScroll();

    // Let go, it glides to its place beside the panel: 68 px left at 1440 px.
    await cdp().send('Animation.setPlaybackRate', { playbackRate: 1 });
    await Promise.all(glides.map((glide) => glide.finished));
    expect(sent - composer.element().getBoundingClientRect().left).toBeCloseTo(68, 0);
    expectNoHorizontalScroll();
  });

  it('ask_claude_opens_at_once_under_reduced_motion', async () => {
    await reduceMotion();
    const { screen } = await renderRoute(RULES);
    const composer = screen.getByRole('textbox', { name: 'Ask Claude to change a rule' });
    await expect.element(composer).toBeVisible();
    const sent = composer.element().getBoundingClientRect().left;
    await composer.fill(ASK);
    await userEvent.keyboard('{Enter}');
    const panel = screen.getByRole('complementary', { name: 'Ask Claude' });
    await expect.element(panel).toBeVisible();
    // The end state at once: the page in its place beside the panel, nothing moving.
    const content = screen.container.querySelector('.cd-app-shell__content') as HTMLElement;
    expect(content.getAnimations()).toHaveLength(0);
    expect(sent - composer.element().getBoundingClientRect().left).toBeCloseTo(68, 0);

    // Closing too: the panel goes and the page is back in its place, at once.
    await panel.getByRole('button', { name: 'Close' }).click();
    expect(screen.container.querySelector('.cd-ask-claude')).toBeNull();
    expect(content.getAnimations()).toHaveLength(0);
    expect(composer.element().getBoundingClientRect().left).toBeCloseTo(sent, 0);
  });
});
