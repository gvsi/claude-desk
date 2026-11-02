/**
 * The About pages' figures with motion, in the `about-motion` project: a reader who hasn't asked for reduced
 * motion. What each figure draws, and that it is complete under reduced motion, is checked in
 * figures.browser.test.tsx; this file checks how a figure plays. Expected timings are written out here, never
 * read from the components or their styles.
 */
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { tokenColor } from '../test/screen.ts';
import { ArchitectureFigure } from './figures/ArchitectureFigure.tsx';
import { Tau3Chart } from './figures/Tau3Chart.tsx';
import { forgetPlayedFigures } from './figures/usePlayOnce.ts';

afterEach(async () => {
  // Each test is a fresh page load at the desktop size, in which no figure has played.
  forgetPlayedFigures();
  vi.unstubAllGlobals();
  window.scrollTo(0, 0);
  await page.viewport(1440, 900);
});

/** Waits `count` frames: long enough for an intersection observer to have heard a scroll. */
async function frames(count = 3): Promise<void> {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
}

/** Mounts `ui` more than a window's height down the page, so it starts out of view, with room to scroll past it. */
function renderBelowTheFold(ui: ReactNode) {
  return render(
    <>
      <div style={{ height: '150vh' }} />
      {ui}
      <div style={{ height: '150vh' }} />
    </>,
  );
}

function figureIn(container: HTMLElement): HTMLElement {
  const figure = container.querySelector('figure');
  if (!figure) throw new Error('no figure');
  return figure;
}

/**
 * Each part drawn under `root` that is hidden, scaled, clipped or still animating, as "tag (class): what". A
 * complete figure has none.
 */
function unfinishedParts(root: Element): string[] {
  return [...root.querySelectorAll('svg *:not(title)')].flatMap((part) => {
    const where = `${part.localName} (${part.getAttribute('class') ?? ''}${part.textContent ? `, ${part.textContent}` : ''})`;
    return unfinished(part).map((what) => `${where}: ${what}`);
  });
}

/**
 * What under a figure isn't at rest, as "tag (class): what": any element still animating, and any part of its drawing
 * that is hidden, scaled or clipped. A figure at rest has none.
 */
function notAtRest(figure: Element): string[] {
  const animating = figure.getAnimations({ subtree: true }).flatMap((animation) => {
    const el = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
    return el ? [`${el.localName} (${el.getAttribute('class') ?? ''}${el.textContent ? `, ${el.textContent}` : ''}): animating`] : [];
  });
  return [...new Set([...animating, ...unfinishedParts(figure)])];
}

/** How one part is hidden, scaled, clipped or still animating; nothing for a part drawn in full and still. */
function unfinished(part: Element): string[] {
  const style = getComputedStyle(part);
  return [
    style.opacity === '1' ? null : `opacity ${style.opacity}`,
    style.transform === 'none' ? null : `transform ${style.transform}`,
    style.clipPath === 'none' ? null : `clip-path ${style.clipPath}`,
    part.getAnimations().length === 0 ? null : 'animating',
  ].filter((what) => what !== null);
}

/** A computed time ("0.48s", "200ms") in whole milliseconds. */
function ms(time: string): number {
  const value = parseFloat(time);
  return Math.round(time.endsWith('ms') ? value : value * 1000);
}

/** The easing a motion token computes to, read off a probe element. */
function tokenEasing(token: string): string {
  const probe = document.createElement('span');
  probe.style.animationTimingFunction = `var(${token})`;
  document.body.append(probe);
  const easing = getComputedStyle(probe).animationTimingFunction;
  probe.remove();
  return easing;
}

/** How a part plays: its animation's name, delay, duration (in ms), easing and fill. */
function timing(part: Element) {
  const style = getComputedStyle(part);
  return {
    name: style.animationName,
    delay: ms(style.animationDelay),
    duration: ms(style.animationDuration),
    easing: style.animationTimingFunction,
    fill: style.animationFillMode,
  };
}

/** Whether any of `el` is inside the window. */
function inView(el: Element): boolean {
  const box = el.getBoundingClientRect();
  return box.bottom > 0 && box.top < window.innerHeight;
}

/**
 * The part of the architecture figure that lights for one step of the request's path, named by its `data-arch-step`
 * hook: a box, or the ledger, lights itself; an outcome lights its pill.
 */
function stepIn(figure: Element, name: string): HTMLElement {
  const hook = figure.querySelector<HTMLElement>(`[data-arch-step="${name}"]`);
  if (!hook) throw new Error(`no step ${name}`);
  return hook.querySelector<HTMLElement>(':scope > .cd-pill') ?? hook;
}

/**
 * How a part of the architecture figure looks: its own outline and ground, and how much of the trace's light lies
 * over them (the opacity of its overlay, 0 where none is drawn).
 */
function look(part: Element) {
  const { boxShadow, backgroundColor } = getComputedStyle(part);
  const overlay = getComputedStyle(part, '::after');
  return { boxShadow, backgroundColor, light: overlay.content === 'none' ? 0 : Number(overlay.opacity) };
}

describe('the about-motion project', () => {
  it('motion_project_runs_with_motion', () => {
    expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false);
    expect(matchMedia('(prefers-reduced-motion: no-preference)').matches).toBe(true);
  });
});

describe('Tau3Chart with motion', () => {
  it('play_once_marks_a_figure_the_first_time_it_is_in_view', async () => {
    const screen = await renderBelowTheFold(<Tau3Chart />);
    const figure = figureIn(screen.container);
    await frames();
    expect(inView(figure)).toBe(false);
    expect(figure.dataset.play).toBe('ready');

    // In view, it plays.
    figure.scrollIntoView({ block: 'center' });
    await expect.poll(() => figure.dataset.play).toBe('played');
    await Promise.all(figure.getAnimations({ subtree: true }).map((animation) => animation.finished));

    // Played through, the mark comes off: the chart is complete by default again.
    await expect.poll(() => figure.hasAttribute('data-play')).toBe(false);
    expect(unfinishedParts(figure)).toEqual([]);

    // Scrolled away and back, it doesn't play again.
    window.scrollTo(0, 0);
    await frames();
    expect(inView(figure)).toBe(false);
    expect(figure.hasAttribute('data-play')).toBe(false);
    figure.scrollIntoView({ block: 'center' });
    await frames();
    expect(figure.hasAttribute('data-play')).toBe(false);
    expect(figure.getAnimations({ subtree: true })).toEqual([]);
  });

  it('a_short_window_still_plays_a_figure', async () => {
    // In a window shorter than a third of the chart, a third of it is never in view: the chart plays once it fills
    // the window, whether the reader jumps there or scrolls a little at a time.
    await page.viewport(1440, 160);
    for (const how of ['jump', 'scroll'] as const) {
      const screen = await renderBelowTheFold(<Tau3Chart />);
      const figure = figureIn(screen.container);
      await frames();
      expect(figure.getBoundingClientRect().height / 3, `${how}: a third of the chart is taller than the window`).toBeGreaterThan(
        window.innerHeight,
      );
      expect(figure.dataset.play, how).toBe('ready');
      const box = figure.getBoundingClientRect();
      const filled = Math.round(box.top + window.scrollY + box.height / 2 - window.innerHeight / 2);
      if (how === 'jump') {
        window.scrollTo(0, filled);
      } else {
        for (let y = window.scrollY; y < filled; y = Math.min(filled, y + 6)) {
          window.scrollTo(0, y);
          await frames(1);
        }
        window.scrollTo(0, filled);
      }
      await expect.poll(() => figure.dataset.play, { message: how }).toBe('played');
      await screen.unmount();
      forgetPlayedFigures();
      window.scrollTo(0, 0);
    }
  });

  it('played_figure_stays_complete_after_a_remount', async () => {
    const first = await render(<Tau3Chart />);
    await expect.poll(() => figureIn(first.container).dataset.play).toBe('played');
    await first.unmount();

    // As when the reader opens the proposal and comes back: the chart draws again, complete, and doesn't play.
    const again = await render(<Tau3Chart />);
    const figure = figureIn(again.container);
    expect(inView(figure)).toBe(true);
    await frames();
    expect(figure.hasAttribute('data-play')).toBe(false);
    expect(unfinishedParts(figure)).toEqual([]);
  });

  it('chart_plays_in_its_signed_order', async () => {
    // The board's order: the frame of the chart shows from the start, today's rule with it; then the Claude
    // releases one by one, then the top score, the ring, the point labels and the trend through the scores, then the
    // trend's dashed run ahead of today, then the band and the prediction's bracket.
    const FROM_THE_START = ['grid', 'axis', 'tick', 'tick-label', 'score-label', 'bar', 'bar-label', 'today', 'today-label'];
    const LATE = ['top', 'ring', 'point-label', 'trend'];
    const AFTER_THE_FIT = ['band', 'rule', 'prediction-date', 'band-label'];
    const emphasis = tokenEasing('--motion-ease-emphasis');

    for (const compact of [false, true]) {
      const size = compact ? 'phone' : 'desktop';
      if (compact) await page.viewport(390, 844);
      const screen = await renderBelowTheFold(<Tau3Chart compact={compact} />);
      const figure = figureIn(screen.container);
      const parts = (name: string) => {
        const found = [...figure.querySelectorAll(`[data-tau3-part="${name}"]`)];
        expect(found.length, `${size}: ${name}`).toBeGreaterThan(0);
        return found;
      };
      const each = (names: string[]) => names.flatMap((name) => parts(name).map((part) => ({ name, part })));

      // Before it plays: the frame is drawn and nothing else is.
      await frames();
      expect(figure.dataset.play).toBe('ready');
      for (const { name, part } of each(FROM_THE_START)) expect(unfinished(part), `${size}: ${name} before`).toEqual([]);
      for (const { name, part } of each(['point', ...LATE, ...AFTER_THE_FIT])) {
        expect(getComputedStyle(part).opacity, `${size}: ${name} before`).toBe('0');
      }
      expect(getComputedStyle(parts('fit')[0]!).clipPath, `${size}: the fit before`).not.toBe('none');

      figure.scrollIntoView({ block: 'center' });
      await expect.poll(() => figure.dataset.play).toBe('played');

      // The frame never moves.
      for (const { name, part } of each(FROM_THE_START)) expect(timing(part).name, `${size}: ${name}`).toBe('none');

      // The ten releases scale in one by one in date order, 80 ms apart, each over 200 ms on the emphasis ease.
      const points = parts('point').sort((a, b) => Number(a.getAttribute('cx')) - Number(b.getAttribute('cx')));
      expect(points).toHaveLength(10);
      expect(points.map((point) => timing(point).delay), size).toEqual([0, 80, 160, 240, 320, 400, 480, 560, 640, 720]);
      for (const point of points) {
        expect(timing(point), size).toMatchObject({ duration: 200, easing: emphasis, fill: 'backwards' });
      }
      const lastPoint = timing(points.at(-1)!);

      // Then the top score, the ring, the point labels and the trend fade in, after the last release starts and
      // before the dashed run draws.
      const fit = timing(parts('fit')[0]!);
      for (const { name, part } of each(LATE)) {
        const late = timing(part);
        expect(late.delay, `${size}: ${name}`).toBeGreaterThan(lastPoint.delay);
        expect(late.delay + late.duration, `${size}: ${name}`).toBeLessThanOrEqual(fit.delay);
        expect(late, `${size}: ${name}`).toMatchObject({ duration: 200, fill: 'backwards' });
      }

      // The dashed run ahead of today draws once the last release is in, over the signed 600 ms, on the emphasis ease.
      expect(fit.delay, size).toBeGreaterThanOrEqual(lastPoint.delay + lastPoint.duration);
      expect(fit, size).toMatchObject({ duration: 600, easing: emphasis });

      // Then the band, the bracket, the prediction and the band's labels, which wait their turn hidden.
      for (const { name, part } of each(AFTER_THE_FIT)) {
        const after = timing(part);
        expect(after.delay, `${size}: ${name}`).toBeGreaterThanOrEqual(fit.delay + fit.duration);
        expect(after, `${size}: ${name}`).toMatchObject({ duration: 200, fill: 'backwards' });
        expect(getComputedStyle(part).opacity, `${size}: ${name} while the fit draws`).toBe('0');
      }

      await screen.unmount();
      forgetPlayedFigures();
      window.scrollTo(0, 0);
    }
  });

  it('fit_reveal_ends_unclipped', async () => {
    const screen = await render(<Tau3Chart />);
    const figure = figureIn(screen.container);
    await expect.poll(() => figure.dataset.play).toBe('played');
    const fit = figure.querySelector('[data-tau3-part="fit"]');
    if (!fit) throw new Error('no fit');
    const [draw, ...more] = fit.getAnimations();
    expect(more).toEqual([]);
    if (!(draw?.effect instanceof KeyframeEffect)) throw new Error('the fit has no reveal');

    // The reveal fills backwards: it hides the line while it waits, and holds nothing once drawn.
    expect(draw.effect.getComputedTiming().fill).toBe('backwards');
    // It is measured against the stroke's box, which takes in the line's width and round caps, so even its last
    // frame cuts nothing off; it opens from the right edge to nothing.
    const clips = draw.effect.getKeyframes().map((keyframe) => String(keyframe.clipPath));
    expect(clips).toHaveLength(2);
    for (const clip of clips) expect(clip).toMatch(/ stroke-box$/);
    expect(clips[0]).toMatch(/^inset\(0(?:px)? 100% 0(?:px)? 0(?:px)?\)/);
    expect(clips[1]).toMatch(/^inset\(0(?:px)?\)/);

    // Once drawn, the line is whole: unclipped, round caps and all, and nothing animates it.
    await draw.finished;
    expect(getComputedStyle(fit).clipPath).toBe('none');
    expect(getComputedStyle(fit).strokeLinecap).toBe('round');
    expect(fit.getAnimations()).toEqual([]);
  });

  it('chart_stays_complete_across_a_layout_switch', async () => {
    const screen = await render(<Tau3Chart />);
    const figure = figureIn(screen.container);
    await expect.poll(() => figure.dataset.play).toBe('played');
    await Promise.all(figure.getAnimations({ subtree: true }).map((animation) => animation.finished));

    // To the phone's layout and back, as a window resized or a tablet turned across the breakpoint redraws it. Some
    // labels are drawn afresh (a phone keeps only the short ones), and none of them plays again or waits hidden.
    for (const compact of [true, false]) {
      const size = compact ? 'phone' : 'desktop again';
      await page.viewport(compact ? 390 : 1440, compact ? 844 : 900);
      await screen.rerender(<Tau3Chart compact={compact} />);
      await frames();
      expect(notAtRest(figure), size).toEqual([]);
    }
  });

  it('chart_is_complete_without_an_observer', async () => {
    // A browser with no IntersectionObserver, and a chart that hasn't played.
    vi.stubGlobal('IntersectionObserver', undefined);
    const screen = await renderBelowTheFold(<Tau3Chart />);
    const figure = figureIn(screen.container);
    await frames();
    expect(figure.hasAttribute('data-play')).toBe(false);
    expect(unfinishedParts(figure)).toEqual([]);
    figure.scrollIntoView({ block: 'center' });
    await frames();
    expect(figure.hasAttribute('data-play')).toBe(false);
    expect(unfinishedParts(figure)).toEqual([]);
  });
});

describe('ArchitectureFigure with motion', () => {
  it('architecture_traces_its_path_once', async () => {
    // The board's path: one request lights, in turn, the visitor, the chat layer, the kernel's Decide and its
    // "Runs", Check reply and its "Shown", then the signed ledger, 300 ms apart. Each step's light (an outline in
    // secondary ink on a hover ground, laid over the part's own look) comes up over 120 ms, holds for 400 ms, and
    // goes back over 120 ms. The part's own look never changes.
    const PATH = ['visitor', 'chat', 'decide', 'runs', 'check', 'shown', 'ledger'];
    const ring = `${tokenColor('--text-secondary')} 0px 0px 0px 1px inset`;
    const hover = tokenColor('--fill-hover');
    const ease = tokenEasing('--motion-ease');

    for (const compact of [false, true]) {
      const size = compact ? 'phone' : 'desktop';
      if (compact) await page.viewport(390, 844);
      const screen = await renderBelowTheFold(<ArchitectureFigure compact={compact} />);
      const figure = figureIn(screen.container);

      // Before it plays: nothing moves and nothing is lit. This is how each step rests.
      await frames();
      expect(figure.dataset.play, size).toBe('ready');
      expect(figure.getAnimations({ subtree: true }), size).toEqual([]);
      const steps = PATH.map((name) => {
        const part = stepIn(figure, name);
        const rest = look(part);
        expect(rest.light, `${size}: ${name} before`).toBe(0);
        return { name, part, rest, lit: { ...rest, light: 1 } };
      });

      figure.scrollIntoView({ block: 'center' });
      await expect.poll(() => figure.dataset.play).toBe('played');

      // Only the seven steps move. Held still, the trace reads at any moment from the start of its play.
      const animations = figure.getAnimations({ subtree: true });
      const targetOf = (animation: Animation) => (animation.effect instanceof KeyframeEffect ? animation.effect.target : null);
      expect(new Set(animations.map(targetOf)), size).toEqual(new Set(steps.map(({ part }) => part)));
      for (const animation of animations) animation.pause();
      const at = (time: number) => {
        for (const animation of animations) animation.currentTime = time;
      };

      for (const [i, { name, part, rest, lit }] of steps.entries()) {
        // The light lies over the whole part, its own outline included: over a pill's border too.
        const overlay = getComputedStyle(part, '::after');
        expect({ ground: overlay.backgroundColor, outline: overlay.boxShadow, inset: overlay.top }, `${size}: ${name} light`).toEqual({
          ground: hover,
          outline: ring,
          inset: part.classList.contains('cd-pill') ? '-1px' : '0px',
        });
        // Its turn comes 300 ms after the step before's, and its light takes 640 ms. (Read from the animations as
        // the play began: one that has run its course by the time held is no longer listed on the part.)
        const start = i * 300;
        const timings = animations
          .filter((animation) => targetOf(animation) === part)
          .map((animation) => animation.effect?.getComputedTiming() ?? {});
        const first = Math.min(...timings.map((timing) => Number(timing.delay)));
        const last = Math.max(...timings.map((timing) => Number(timing.endTime)));
        expect(Math.round(first), `${size}: ${name} starts`).toBe(start);
        expect(Math.round(last), `${size}: ${name} ends`).toBe(start + 640);
        // At rest until its turn; brightening, then lit through its hold; going back, then at rest again.
        for (const [time, state, expected] of [
          [start - 1, 'before its turn', rest],
          [start + 120, 'brightened', lit],
          [start + 320, 'holding', lit],
          [start + 519, 'still held', lit],
          [start + 641, 'gone back', rest],
        ] as const) {
          at(time);
          expect(look(part), `${size}: ${name} ${state}`).toEqual(expected);
        }
        for (const [time, state] of [
          [start + 60, 'brightening'],
          [start + 580, 'going back'],
        ] as const) {
          at(time);
          expect(look(part), `${size}: ${name} ${state}`).not.toEqual(rest);
          expect(look(part), `${size}: ${name} ${state}`).not.toEqual(lit);
        }
        // Every part of its light eases as the design system's motion does.
        const easings = getComputedStyle(part, '::after').animationTimingFunction.split(/,\s*(?![^()]*\))/);
        for (const easing of easings) expect(easing, `${size}: ${name}`).toBe(ease);
      }

      // Played through, the figure rests as drawn, and nothing holds it.
      for (const animation of animations) animation.finish();
      expect(figure.getAnimations({ subtree: true }), size).toEqual([]);
      for (const { name, part, rest } of steps) expect(look(part), `${size}: ${name} after`).toEqual(rest);

      // Drawn again, as when the reader opens the other document and comes back, it rests and doesn't trace again.
      await screen.unmount();
      const again = await render(<ArchitectureFigure compact={compact} />);
      const redrawn = figureIn(again.container);
      await frames();
      expect(inView(redrawn), size).toBe(true);
      expect(redrawn.hasAttribute('data-play'), size).toBe(false);
      expect(redrawn.getAnimations({ subtree: true }), size).toEqual([]);

      await again.unmount();
      forgetPlayedFigures();
      window.scrollTo(0, 0);
    }
  });

  it('architecture_stays_at_rest_across_a_layout_switch', async () => {
    const screen = await render(<ArchitectureFigure />);
    const figure = figureIn(screen.container);
    await expect.poll(() => figure.dataset.play).toBe('played');
    await Promise.all(figure.getAnimations({ subtree: true }).map((animation) => animation.finished));

    // To the phone's layout and back, as a window resized or a tablet turned across the breakpoint redraws it. Some
    // parts are drawn afresh (on a phone each check's outcomes move inside its box), and none of them plays again.
    for (const compact of [true, false]) {
      const size = compact ? 'phone' : 'desktop again';
      await page.viewport(compact ? 390 : 1440, compact ? 844 : 900);
      await screen.rerender(<ArchitectureFigure compact={compact} />);
      await frames();
      expect(notAtRest(figure), size).toEqual([]);
    }
  });
});
