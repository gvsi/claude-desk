/**
 * Ask Claude opening beside the Rules page, in a real browser against the mock API: the page is
 * laid out beside the panel at once and glides there from where it was, so what the owner just
 * used doesn't leap from under them. Under reduced motion the page is in its new place at once.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import { cdp, userEvent } from 'vitest/browser';

import { settled } from '../../ds/test/settled.ts';
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
    // The reload's outgoing frame also has a content element; measure after its fade ends.
    await settled(screen.container);
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

  it('the_panels_box_shows_an_example_question', async () => {
    // Once the panel is open, its own box shows an example of what to ask, under the same name;
    // the Rules page's box keeps its own words.
    const { screen } = await renderRoute(RULES);
    const composer = screen.getByRole('textbox', { name: 'Ask Claude to change a rule', exact: true });
    await expect.element(composer).toHaveAttribute('placeholder', 'Ask Claude to change a rule');
    await composer.fill(ASK);
    await userEvent.keyboard('{Enter}');
    const panel = screen.getByRole('complementary', { name: 'Ask Claude', exact: true });
    await expect.element(panel.getByRole('heading', { level: 2, name: 'Ask Claude', exact: true })).toBeVisible();
    const box = panel.getByRole('textbox', { name: 'Ask Claude', exact: true });
    await expect.element(box).toHaveAttribute('placeholder', 'What happens if someone asks for a discount?');
    // One line in the empty box, clipped nowhere: the panel's 400 px hold the whole example.
    await expect.element(box).toHaveValue('');
    expect(box.element().scrollWidth).toBeLessThanOrEqual(box.element().clientWidth);
    expect(box.element().scrollHeight).toBeLessThanOrEqual(box.element().clientHeight);
  });

  it('the_page_under_the_header_has_no_vertical_jump', async () => {
    // Beside the panel at 1440 px, the header keeps its lines, so nothing under it moves: on the
    // first frame of the open and of the close, and once each settles, the first section is where it was.
    await cdp().send('Animation.enable');
    onTestFinished(async () => {
      await cdp().send('Animation.setPlaybackRate', { playbackRate: 1 });
    });
    const { screen } = await renderRoute(RULES);
    const composer = screen.getByRole('textbox', { name: 'Ask Claude to change a rule' });
    await expect.element(composer).toBeVisible();
    // The loading layer also has these classes; wait for the page's own first section.
    const group = () => [...screen.container.querySelectorAll<HTMLElement>('.cd-rules__section')].find((el) => !el.closest('.cd-skeleton-screen__layer')) ?? null;
    await expect.poll(() => group()).not.toBeNull();
    const top = () => (group() as HTMLElement).getBoundingClientRect().top;
    const closed = top();

    await cdp().send('Animation.setPlaybackRate', { playbackRate: 0 });
    await composer.fill(ASK);
    await userEvent.keyboard('{Enter}');
    const panel = screen.getByRole('complementary', { name: 'Ask Claude' });
    await expect.element(panel).toBeVisible();
    expect(Math.abs(top() - closed), `opening: ${top()}, was ${closed}`).toBeLessThanOrEqual(0.5);
    await cdp().send('Animation.setPlaybackRate', { playbackRate: 1 });
    await settled(screen.container);
    const opened = top();
    expect(opened - closed).toBeCloseTo(0, 0);

    await cdp().send('Animation.setPlaybackRate', { playbackRate: 0 });
    await panel.getByRole('button', { name: 'Close' }).click();
    expect(Math.abs(top() - opened), `closing: ${top()}, was ${opened}`).toBeLessThanOrEqual(0.5);
    await cdp().send('Animation.setPlaybackRate', { playbackRate: 1 });
    await settled(screen.container);
    expect(top()).toBeCloseTo(closed, 0);
  });

  it('nothing_in_the_payments_rows_jumps_at_1512', async () => {
    // At 1512 px, beside the panel and the header's action, the subtitle keeps its line above the
    // rows scrolled to here, and the browser keeps them where they are on screen. On the first frame
    // of the open and of the close, every part of the Payments and Stripe cards is where it was in them.
    await cdp().send('Animation.enable');
    onTestFinished(async () => {
      await cdp().send('Animation.setPlaybackRate', { playbackRate: 1 });
    });
    const { screen } = await renderRoute(RULES, { viewport: { width: 1512, height: 982 } });
    const composer = screen.getByRole('textbox', { name: 'Ask Claude to change a rule' });
    await expect.element(composer).toBeVisible();
    const sections = () =>
      [...screen.container.querySelectorAll<HTMLElement>('section.cd-card[aria-label="Payments"], section.cd-card[aria-label="Stripe"]')]
        .filter((section) => !section.closest('.cd-skeleton-screen__layer'));
    await expect.poll(() => sections().length).toBe(2);
    // The words go in first, since typing brings the composer into view; then the rows are scrolled to.
    await composer.fill(ASK);
    (sections()[0] as HTMLElement).scrollIntoView({ block: 'start' });
    const main = screen.container.querySelector('main') as HTMLElement;
    expect(main.scrollTop).toBeGreaterThan(0);
    // What shows: a closed Details panel takes no room.
    const parts = () => sections().flatMap((section) => [...section.querySelectorAll<HTMLElement>('*')]).filter((part) => part.getBoundingClientRect().height > 0);
    const header = screen.container.querySelector('.cd-rules__header') as HTMLElement;
    // Where each part is from the top of the Payments rows, wherever the page is scrolled (closing
    // returns focus to the composer, which scrolls) and however many lines the header takes; the
    // rows themselves are checked on screen as the panel opens.
    const tops = () => {
      const start = (sections()[0] as HTMLElement).getBoundingClientRect().top;
      return parts().map((el) => Math.round((el.getBoundingClientRect().top - start) * 10) / 10);
    };
    /** Each part that moved more than half a pixel from `was`, as "class: from → to". */
    const jumps = (was: number[]) =>
      tops().flatMap((top, index) => (Math.abs(top - (was[index] ?? top)) > 0.5 ? [`${parts()[index]?.className}: ${was[index]} → ${top}`] : []));
    const closed = tops();
    const onScreen = () => Math.round((sections()[0] as HTMLElement).getBoundingClientRect().top);
    const seen = onScreen();
    const lines = header.getBoundingClientRect().height;

    await cdp().send('Animation.setPlaybackRate', { playbackRate: 0 });
    await userEvent.keyboard('{Enter}');
    const panel = screen.getByRole('complementary', { name: 'Ask Claude' });
    await expect.element(panel).toBeVisible();
    expect(header.getBoundingClientRect().height - lines, 'the subtitle fits beside the panel').toBe(0);
    expect(onScreen(), 'the rows stay where they are on screen').toBe(seen);
    expect(jumps(closed), 'opening').toEqual([]);
    await cdp().send('Animation.setPlaybackRate', { playbackRate: 1 });
    await settled(screen.container);
    const opened = tops();

    await cdp().send('Animation.setPlaybackRate', { playbackRate: 0 });
    await panel.getByRole('button', { name: 'Close' }).click();
    expect(jumps(opened), 'closing').toEqual([]);
    await cdp().send('Animation.setPlaybackRate', { playbackRate: 1 });
    await settled(screen.container);
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
