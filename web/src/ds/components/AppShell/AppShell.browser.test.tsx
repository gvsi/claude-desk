/**
 * AppShell switches between the sidebar column and the compact top bar as the window crosses
 * 768 px. The page inside must survive the switch: resizing a window or turning a phone keeps an
 * unsent draft and every other bit of page state.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { motion } from '../../test/reducedMotion.ts';
import { AskClaudePanel } from '../AskClaudePanel/AskClaudePanel.tsx';
import { Composer } from '../Composer/Composer.tsx';
import { AppShell } from './AppShell.tsx';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const WIDE = { width: 1280, height: 820 };
const NARROW = { width: 600, height: 820 };

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await page.viewport(WIDE.width, WIDE.height);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await page.viewport(WIDE.width, WIDE.height);
});

function isCompact(): boolean {
  return container.querySelector('.cd-app-shell--compact') !== null;
}

it('fill_never_changes_the_sidebar', () => {
  // The sidebar looks the same on every page: the panel, its seam, the window's height. `fill`
  // sets only the main area, so moving between a padded page and a filled one leaves it as it is.
  const shell = (fill: boolean) => (
    <AppShell sidebar={<nav aria-label="Main">Today</nav>} business="Rivera Plumbing" fill={fill}>
      <p>Page</p>
    </AppShell>
  );
  const column = () => container.querySelector('.cd-app-shell__column') as HTMLElement;
  const main = () => container.querySelector('main') as HTMLElement;
  const look = () => {
    const style = getComputedStyle(column());
    return { ground: style.backgroundColor, seam: style.borderRightWidth, align: style.alignItems };
  };
  const PANEL = { ground: 'rgb(34, 34, 32)', seam: '1px', align: 'normal' };

  act(() => root.render(shell(false)));
  expect(look()).toEqual(PANEL);
  expect(getComputedStyle(main()).paddingLeft).toBe('40px');
  act(() => root.render(shell(true)));
  expect(getComputedStyle(main()).paddingLeft).toBe('0px');
  expect(look()).toEqual(PANEL);
});

it('page_state_survives_the_breakpoint', async () => {
  act(() =>
    root.render(
      <AppShell sidebar={<nav aria-label="Main">Today</nav>} business="Rivera Plumbing">
        <Composer variant="whisper" label="Whisper to Claude" placeholder="Whisper to Claude. Dana won't see it." onSend={() => {}} />
      </AppShell>,
    ),
  );
  expect(isCompact()).toBe(false);

  const box = page.getByRole('textbox', { name: 'Whisper to Claude' });
  await userEvent.type(box, 'Keep this draft');
  const textarea = box.element() as HTMLTextAreaElement;
  expect(textarea.value).toBe('Keep this draft');

  // Narrower than 768 px: the top bar replaces the column, and the draft is the same text box.
  await page.viewport(NARROW.width, NARROW.height);
  await vi.waitFor(() => expect(isCompact()).toBe(true));
  expect(page.getByRole('button', { name: 'Menu' }).element()).toBeTruthy();
  expect(box.element()).toBe(textarea);
  expect(textarea.isConnected).toBe(true);
  expect(textarea.value).toBe('Keep this draft');

  // And back: the column returns, and the draft is still there.
  await page.viewport(WIDE.width, WIDE.height);
  await vi.waitFor(() => expect(isCompact()).toBe(false));
  expect(box.element()).toBe(textarea);
  expect(textarea.value).toBe('Keep this draft');
});

it('long_pages_scroll_inside_the_shell', async () => {
  // The shell is the window's height and its main area scrolls. A long page, with the
  // screen-reader-only labels receipts carry, must not stretch the document behind it: the page
  // itself never scrolls, on a laptop or a phone, padded or filled.
  const longPage = (
    <div>
      {Array.from({ length: 80 }, (_, index) => (
        <p key={index}>
          Message {index + 1}
          <span className="cd-sr-only">Reply checked before the visitor saw it.</span>
        </p>
      ))}
    </div>
  );
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.viewport(width, height);
    for (const fill of [false, true]) {
      act(() =>
        root.render(
          <AppShell sidebar={<nav aria-label="Main">Today</nav>} business="Rivera Plumbing" fill={fill}>
            {longPage}
          </AppShell>,
        ),
      );
      const main = container.querySelector('main') as HTMLElement;
      // The page is longer than the window, so the main area scrolls...
      await vi.waitFor(() => expect(main.scrollHeight).toBeGreaterThan(main.clientHeight));
      // ...and the document doesn't.
      expect([width, fill, document.documentElement.scrollHeight]).toEqual([width, fill, height]);
    }
  }
});

it('long_sidebars_and_panels_scroll_inside_the_shell', async () => {
  // The shell's other scroll regions hold their own long content the same way: a sidebar taller
  // than a short window, and the Ask Claude panel's conversation beside the page.
  const longList = (
    <div>
      {Array.from({ length: 80 }, (_, index) => (
        <p key={index}>
          Line {index + 1}
          <span className="cd-sr-only">Checked before it was shown.</span>
        </p>
      ))}
    </div>
  );
  const noop = () => {};
  await page.viewport(1440, 400);
  act(() =>
    root.render(
      <AppShell sidebar={longList} business="Rivera Plumbing">
        <p>Page</p>
      </AppShell>,
    ),
  );
  await vi.waitFor(() => expect(container.querySelector('.cd-app-shell__column')!.scrollHeight).toBeGreaterThan(400));
  expect(['sidebar', document.documentElement.scrollHeight]).toEqual(['sidebar', 400]);

  await page.viewport(1440, 900);
  act(() =>
    root.render(
      <AppShell
        sidebar={<nav aria-label="Main">Today</nav>}
        business="Rivera Plumbing"
        panel={
          <AskClaudePanel onClose={noop} onSend={noop}>
            {longList}
          </AskClaudePanel>
        }
      >
        <p>Page</p>
      </AppShell>,
    ),
  );
  await vi.waitFor(() => expect(container.querySelector('.cd-ask-claude__log')!.scrollHeight).toBeGreaterThan(900));
  expect(['panel', document.documentElement.scrollHeight]).toEqual(['panel', 900]);
});

/**
 * Opening and closing a panel beside the page (N-Conn-12-Chat and N-Conn-17-Presets, open and
 * closed, as signed): the panel slides 24 px in from the right and fades up, and the page is laid
 * out at its new width at once and glides from where it was to its new place on transform alone, a
 * FLIP, both on motion-base with the emphasis ease. Closing reverses on motion-fast. Under reduced
 * motion, and for a panel that is a sheet over the window, nothing slides or glides.
 */
const LAPTOP = { width: 1512, height: 982 };

/** A motion token's value, as the root has it: "200ms", "cubic-bezier(.165,.84,.44,1)". */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** An easing written either way the browser may give it back: "cubic-bezier(0.165, 0.84, 0.44, 1)". */
function easing(value: string): string {
  return value.replace(/\s+/g, '').replace(/(^|[(,])0\./g, '$1.');
}

/** A shell around a page, with the Ask Claude panel beside it while `open`. */
function shellWithPanel(open: boolean, onClose: () => void = () => {}) {
  return (
    <AppShell
      sidebar={<nav aria-label="Main">Today</nav>}
      business="Rivera Plumbing"
      panel={
        open ? (
          <AskClaudePanel onClose={onClose} onSend={() => {}}>
            <p>Stop quoting on weekends</p>
          </AskClaudePanel>
        ) : undefined
      }
    >
      <p>Rules</p>
    </AppShell>
  );
}

const content = () => container.querySelector('.cd-app-shell__content') as HTMLElement;
const slot = () => container.querySelector<HTMLElement>('.cd-app-shell__panel');
const left = (el: Element) => el.getBoundingClientRect().left;

/** What an animation moves: the properties its keyframes set. */
function properties(animation: Animation): string[] {
  const frames = (animation.effect as KeyframeEffect).getKeyframes();
  const set = new Set(frames.flatMap((frame) => Object.keys(frame)));
  for (const key of ['offset', 'computedOffset', 'easing', 'composite']) set.delete(key);
  return [...set].sort();
}

/** An animation's first and last keyframes, as the browser keeps them. */
function ends(animation: Animation): [Keyframe, Keyframe] {
  const frames = (animation.effect as KeyframeEffect).getKeyframes();
  return [frames[0] as Keyframe, frames.at(-1) as Keyframe];
}

/** The one animation on `el`, held at its start. */
function heldAtStart(el: Element): Animation {
  const animations = el.getAnimations();
  expect(animations).toHaveLength(1);
  const animation = animations[0] as Animation;
  animation.pause();
  animation.currentTime = 0;
  return animation;
}

it('opening_a_panel_glides_the_page_without_a_jump', async () => {
  await motion();
  await page.viewport(LAPTOP.width, LAPTOP.height);
  act(() => root.render(shellWithPanel(false)));
  const closed = content().getBoundingClientRect();

  act(() => root.render(shellWithPanel(true)));
  // The page is laid out at its new width at once, and its first frame is where it was: no jump.
  const glide = heldAtStart(content());
  expect(Math.round(content().getBoundingClientRect().width)).toBe(768);
  expect(left(content())).toBeCloseTo(closed.left, 0);
  // Drawn past the main area's edge while it glides in, the page never makes it scroll sideways.
  const main = container.querySelector('main') as HTMLElement;
  expect(getComputedStyle(main).overflowX).toBe('hidden');
  // It glides on transform alone, on motion-base with the emphasis ease, to its new place.
  expect(properties(glide)).toEqual(['transform']);
  expect(glide.effect?.getTiming().duration).toBe(Number.parseFloat(token('--motion-base')));
  expect(easing(glide.effect?.getTiming().easing ?? '')).toBe(easing(token('--motion-ease-emphasis')));
  glide.finish();
  await glide.finished;
  expect(content().getAnimations()).toHaveLength(0);
  expect(left(content())).toBeCloseTo(closed.left - 104, 0);

  // The panel slides 24 px in from the right and fades up, on the same time and ease.
  const panel = slot();
  if (!panel) throw new Error('No panel slot');
  const slide = heldAtStart(panel);
  expect(properties(slide)).toEqual(['opacity', 'transform']);
  const [from, to] = ends(slide);
  expect([from.transform, from.opacity, to.transform, to.opacity]).toEqual(['translateX(24px)', '0', 'none', '1']);
  // Drawn past the window's edge as it starts, it never makes the window scroll sideways.
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(LAPTOP.width);
  expect(slide.effect?.getTiming().duration).toBe(Number.parseFloat(token('--motion-base')));
  expect(easing(slide.effect?.getTiming().easing ?? '')).toBe(easing(token('--motion-ease-emphasis')));
  slide.finish();
  expect(left(panel)).toBe(LAPTOP.width - 400);
  // Landed, the main area scrolls as it did, and nothing is past its edge.
  expect(getComputedStyle(main).overflowX).toBe('auto');
  expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
});

it('closing_a_panel_reverses_on_motion_fast', async () => {
  await motion();
  await page.viewport(LAPTOP.width, LAPTOP.height);
  act(() => root.render(shellWithPanel(false)));
  const closed = left(content());
  act(() => root.render(shellWithPanel(true)));
  for (const el of [content(), slot()]) for (const animation of el?.getAnimations() ?? []) animation.finish();
  const opened = left(content());

  act(() => root.render(shellWithPanel(false)));
  // The page takes its full width at once and glides back from where it was, on transform alone.
  const glide = heldAtStart(content());
  expect(Math.round(content().getBoundingClientRect().width)).toBe(960);
  expect(left(content())).toBeCloseTo(opened, 0);
  expect(properties(glide)).toEqual(['transform']);
  expect(glide.effect?.getTiming().duration).toBe(Number.parseFloat(token('--motion-fast')));
  glide.finish();
  expect(left(content())).toBeCloseTo(closed, 0);

  // The panel stays while it slides 24 px out and fades, out of reach, then goes.
  const panel = slot();
  if (!panel) throw new Error('The panel left before sliding out');
  expect(panel.hasAttribute('inert')).toBe(true);
  const slide = heldAtStart(panel);
  expect(properties(slide)).toEqual(['opacity', 'transform']);
  const [from, to] = ends(slide);
  expect([from.transform, from.opacity, to.transform, to.opacity]).toEqual(['none', '1', 'translateX(24px)', '0']);
  slide.currentTime = Number.parseFloat(token('--motion-fast'));
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(LAPTOP.width);
  expect(slide.effect?.getTiming().duration).toBe(Number.parseFloat(token('--motion-fast')));
  await act(async () => {
    slide.finish();
    await slide.finished;
  });
  expect(slot()).toBeNull();
  expect(container.querySelector('.cd-ask-claude')).toBeNull();
});

it('reopening_while_it_leaves_brings_a_new_panel', async () => {
  await motion();
  await page.viewport(LAPTOP.width, LAPTOP.height);
  act(() => root.render(shellWithPanel(true)));
  const leaving = container.querySelector('.cd-ask-claude');
  act(() => root.render(shellWithPanel(false)));
  act(() => root.render(shellWithPanel(true)));
  // One panel, a new one, live and sliding in; the one that was leaving is gone.
  expect(container.querySelectorAll('.cd-ask-claude')).toHaveLength(1);
  expect(container.querySelector('.cd-ask-claude')).not.toBe(leaving);
  expect(slot()?.hasAttribute('inert')).toBe(false);
  const [, to] = ends(heldAtStart(slot() as HTMLElement));
  expect(to.opacity).toBe('1');
});

it('panel_opens_and_closes_at_once_under_reduced_motion', async () => {
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  await page.viewport(LAPTOP.width, LAPTOP.height);
  act(() => root.render(shellWithPanel(false)));
  const closed = left(content());
  act(() => root.render(shellWithPanel(true)));
  // The end state at once: the page in its new place, the panel beside it, nothing moving.
  expect(content().getAnimations()).toHaveLength(0);
  expect(slot()?.getAnimations()).toHaveLength(0);
  expect(left(content())).toBeCloseTo(closed - 104, 0);
  act(() => root.render(shellWithPanel(false)));
  expect(content().getAnimations()).toHaveLength(0);
  expect(slot()).toBeNull();
  expect(left(content())).toBeCloseTo(closed, 0);
});

it('a_sheet_neither_slides_nor_glides', async () => {
  // Under 1024 px the panel is a modal sheet over the window, and the page behind it keeps its place.
  await motion();
  for (const [width, height] of [
    [768, 1024],
    [390, 844],
  ] as const) {
    await page.viewport(width, height);
    act(() => root.render(shellWithPanel(false)));
    const closed = left(content());
    act(() => root.render(shellWithPanel(true)));
    await vi.waitFor(() => expect(container.querySelector('.cd-ask-claude')?.getAttribute('role')).toBe('dialog'));
    expect([width, content().getAnimations().length, slot()?.getAnimations().length]).toEqual([width, 0, 0]);
    expect(left(content())).toBe(closed);
    act(() => root.render(shellWithPanel(false)));
    expect([width, content().getAnimations().length, slot()]).toEqual([width, 0, null]);
  }
});

it('a_panel_that_becomes_a_sheet_mid_move_lands_at_once', async () => {
  // The window narrows under 1024 px while the panel is still sliding in: it is a sheet now, so the
  // move ends there, and the sheet sits at the window's right edge, not off by the slide's rest.
  await motion();
  await page.viewport(LAPTOP.width, LAPTOP.height);
  act(() => root.render(shellWithPanel(false)));
  act(() => root.render(shellWithPanel(true)));
  heldAtStart(slot() as HTMLElement);
  heldAtStart(content());
  await page.viewport(960, 900);
  await vi.waitFor(() => expect(container.querySelector('.cd-ask-claude')?.getAttribute('role')).toBe('dialog'));
  expect([slot()?.getAnimations().length, content().getAnimations().length]).toEqual([0, 0]);
  expect(left(container.querySelector('.cd-ask-claude') as HTMLElement)).toBe(960 - 400);
});
