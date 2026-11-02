/**
 * AppShell switches between the sidebar column and the compact top bar as the window crosses
 * 768 px. The page inside must survive the switch: resizing a window or turning a phone keeps an
 * unsent draft and every other bit of page state.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { motion } from '../../test/reducedMotion.ts';
import { coarsePointer, expectHitAreaLands, expectUnseen, hitArea } from '../../test/touch.ts';
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

it('phone_menu_has_an_unseen_centred_44_px_touch_area_without_moving_or_scrolling', async () => {
  await page.viewport(390, 844);
  act(() => root.render(
    <AppShell sidebar={<nav aria-label="Main">Today</nav>} business="Turner Plumbing">
      <p>Safety</p>
    </AppShell>,
  ));
  const menu = page.getByRole('button', { name: 'Menu', exact: true }).element();
  const visible = () => [...container.querySelectorAll('.cd-app-shell__topbar, .cd-app-shell__topbar svg, .cd-app-shell__business, .cd-app-shell__menu, main')]
    .map((element) => element.getBoundingClientRect().toJSON());
  const scroll = () => [document.documentElement.scrollWidth, document.documentElement.scrollHeight, container.scrollWidth, container.scrollHeight];
  const fine = { visible: visible(), scroll: scroll() };
  expect(getComputedStyle(menu, '::after').content, 'no hit area under a fine pointer').toBe('none');
  expect([menu.getBoundingClientRect().width, menu.getBoundingClientRect().height]).toEqual([32, 32]);

  await coarsePointer();
  expect({ visible: visible(), scroll: scroll() }, 'the top bar, glyphs and page keep their boxes and scroll extents').toEqual(fine);
  const own = menu.getBoundingClientRect();
  const area = hitArea(menu);
  expect([area.width, area.height], '44 px on both axes').toEqual([44, 44]);
  expect([own.top - area.top, area.bottom - own.bottom, own.left - area.left, area.right - own.right], 'centred').toEqual([6, 6, 6, 6]);
  expectHitAreaLands(menu);
  expectUnseen(menu);
});

it('fill_never_changes_the_sidebar', () => {
  // The sidebar looks the same on every page: the panel, its seam, the window's height. `fill`
  // sets only the main area, so moving between a padded page and a filled one leaves it as it is.
  const shell = (fill: boolean) => (
    <AppShell sidebar={<nav aria-label="Main">Today</nav>} business="Turner Plumbing" fill={fill}>
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

it('skip_link_is_the_first_stop_and_moves_focus_to_the_page', async () => {
  // "Skip to content" is the first Tab stop, before the banner's Reset demo and the navigation.
  // Hidden until keyboard focus, it shows at the top left over the sidebar with the standard focus
  // ring; Enter moves focus to the page, and the next Tab continues inside it. A mouse never shows it.
  for (const layout of ['auto', 'compact'] as const) {
    act(() =>
      root.render(
        <AppShell
          layout={layout}
          banner={<button type="button">Reset demo</button>}
          sidebar={
            <nav aria-label="Main">
              <a href="#today">Today</a>
            </nav>
          }
          business="Turner Plumbing"
        >
          <button type="button">First on the page</button>
        </AppShell>,
      ),
    );
    const skip = page.getByRole('link', { name: 'Skip to content' }).element() as HTMLAnchorElement;
    const hidden = () => {
      const box = skip.getBoundingClientRect();
      return box.width <= 1 && box.height <= 1;
    };
    expect([layout, hidden()]).toEqual([layout, true]);

    // Tab from the start of the document, as on a page just opened: from a control just before
    // the shell, gone before the Tab.
    const start = document.createElement('button');
    container.before(start);
    start.focus();
    start.remove();
    await userEvent.tab();
    expect([layout, document.activeElement]).toEqual([layout, skip]);
    expect([layout, hidden()]).toEqual([layout, false]);
    // At the top left, over the banner and the sidebar: nothing covers it.
    const box = skip.getBoundingClientRect();
    expect([layout, box.left < 24, box.top < 24]).toEqual([layout, true, true]);
    expect(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('a')).toBe(skip);
    // The focus edge inside it, 1 px of line-focus, and no ring outside it.
    const edge = getComputedStyle(skip);
    expect([edge.outlineStyle, edge.boxShadow]).toEqual(['none', 'rgba(250, 249, 245, 0.64) 0px 0px 0px 1px inset']);

    // Enter moves focus to the page, leaving the address as it is, and the next Tab is inside it.
    const address = window.location.href;
    await userEvent.keyboard('{Enter}');
    const main = container.querySelector('main') as HTMLElement;
    expect([layout, document.activeElement]).toEqual([layout, main]);
    // The main region isn't a control: with focus from the keyboard it draws nothing.
    expect([layout, main.matches(':focus-visible'), getComputedStyle(main).outlineStyle, getComputedStyle(main).boxShadow]).toEqual([layout, true, 'none', 'none']);
    expect(skip.getAttribute('href')).toBe(`#${main.id}`);
    expect(window.location.href).toBe(address);
    expect(hidden()).toBe(true);
    await userEvent.tab();
    expect(document.activeElement).toBe(page.getByRole('button', { name: 'First on the page' }).element());

    // After a click, focus a script puts on it doesn't show it: only the keyboard does.
    await userEvent.click(page.getByRole('button', { name: 'Reset demo' }));
    skip.focus();
    expect([layout, document.activeElement, hidden()]).toEqual([layout, skip, true]);
  }
});

it('page_state_survives_the_breakpoint', async () => {
  act(() =>
    root.render(
      <AppShell sidebar={<nav aria-label="Main">Today</nav>} business="Turner Plumbing">
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
          <AppShell sidebar={<nav aria-label="Main">Today</nav>} business="Turner Plumbing" fill={fill}>
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
      <AppShell sidebar={longList} business="Turner Plumbing">
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
        business="Turner Plumbing"
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
function shellWithPanel(open: boolean, onClose: () => void = () => {}, page: ReactNode = <p>Rules</p>) {
  return (
    <AppShell
      sidebar={<nav aria-label="Main">Today</nav>}
      business="Turner Plumbing"
      panel={
        open ? (
          <AskClaudePanel onClose={onClose} onSend={() => {}}>
            <p>Stop quoting on weekends</p>
          </AskClaudePanel>
        ) : undefined
      }
    >
      {page}
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
  // The exit names only where the panel goes, so it starts from wherever the panel is drawn:
  // fully open here.
  const frames = (slide.effect as KeyframeEffect).getKeyframes();
  expect(frames.map((frame) => [frame.transform, frame.opacity])).toEqual([['translateX(24px)', '0']]);
  expect([left(panel), getComputedStyle(panel).opacity]).toEqual([LAPTOP.width - 400, '1']);
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

/** Where the panel and the page are drawn right now: the panel's opacity and left edge, and the page's left edge. */
function drawn(): { opacity: number; panel: number; page: number } {
  const panel = slot();
  if (!panel) throw new Error('No panel slot');
  return { opacity: Number(getComputedStyle(panel).opacity), panel: left(panel), page: left(content()) };
}

/** Every animation now playing on the panel and the page, paused at `time`. */
function holdPlaying(time: number): void {
  for (const animation of [...content().getAnimations(), ...(slot()?.getAnimations() ?? [])]) {
    if (animation.playState !== 'running') continue;
    animation.pause();
    animation.currentTime = time;
  }
}

/** The panel and the page are drawn where they were: no flash, no snap. */
function expectDrawnAt(was: { opacity: number; panel: number; page: number }): void {
  const now = drawn();
  expect(Math.abs(now.opacity - was.opacity), `opacity ${now.opacity}, was ${was.opacity}`).toBeLessThanOrEqual(0.01);
  expect(Math.abs(now.panel - was.panel), `panel at ${now.panel}, was ${was.panel}`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(now.page - was.page), `page at ${now.page}, was ${was.page}`).toBeLessThanOrEqual(0.5);
}

it('closing_mid_entrance_starts_from_where_it_is', async () => {
  await motion();
  await page.viewport(LAPTOP.width, LAPTOP.height);
  act(() => root.render(shellWithPanel(false)));
  act(() => root.render(shellWithPanel(true)));
  // Closed 20 ms into the entrance: the panel is partly faded in and still sliding.
  holdPlaying(20);
  const was = drawn();
  expect(was.opacity).toBeGreaterThan(0);
  expect(was.opacity).toBeLessThan(1);
  act(() => root.render(shellWithPanel(false)));
  // The exit and the page's glide back start where they were.
  holdPlaying(0);
  expectDrawnAt(was);
});

it('reopening_mid_exit_starts_from_where_it_is', async () => {
  await motion();
  await page.viewport(LAPTOP.width, LAPTOP.height);
  act(() => root.render(shellWithPanel(false)));
  act(() => root.render(shellWithPanel(true)));
  for (const animation of [...content().getAnimations(), ...(slot()?.getAnimations() ?? [])]) animation.finish();
  act(() => root.render(shellWithPanel(false)));
  // Opened again 20 ms into the exit: the new panel slides in from where the last one was drawn.
  holdPlaying(20);
  const was = drawn();
  expect(was.opacity).toBeGreaterThan(0);
  expect(was.opacity).toBeLessThan(1);
  act(() => root.render(shellWithPanel(true)));
  holdPlaying(0);
  expectDrawnAt(was);
});

it('a_late_exit_never_cancels_the_next_panels_fallback', async () => {
  // Closed, opened again and closed again: the first exit's end, arriving late, leaves the second
  // panel's own way out, so it goes even when its exit's end never comes.
  await motion();
  await page.viewport(LAPTOP.width, LAPTOP.height);
  act(() => root.render(shellWithPanel(true)));
  act(() => root.render(shellWithPanel(false)));
  const first = slot()?.getAnimations()[0];
  if (!first) throw new Error('No exit');
  first.pause();
  act(() => root.render(shellWithPanel(true)));
  act(() => root.render(shellWithPanel(false)));
  for (const animation of slot()?.getAnimations() ?? []) animation.pause();
  await act(async () => {
    first.finish();
    await first.finished;
  });
  await vi.waitFor(() => expect(slot()).toBeNull(), { timeout: 1000 });
});

/**
 * A page whose first block is as tall as an eighth of its width, as a header whose subtitle takes
 * a second line in a narrower column is taller: 120 px at the page's 960 px, 96 px at 768 px. What
 * sits under it moves up or down as the panel opens or closes.
 */
const reflowingPage = (
  <div>
    <div style={{ aspectRatio: '8 / 1' }} />
    {/* Its own transform, which the glide must not scale. */}
    <p data-testid="below" style={{ transform: 'scale(0.5)' }}>
      Quotes
    </p>
  </div>
);

/** The same page in a fixed-height box, as a fill page's columns are: the box keeps its height, and what is in it still moves. */
const fixedHeightPage = (
  <div style={{ height: '240px' }}>
    <div style={{ aspectRatio: '8 / 1' }} />
    <p data-testid="below">Quotes</p>
  </div>
);

/** Every animation now playing in the shell, paused at `time`; or finished, with `time` null. */
function holdAll(time: number | null): void {
  for (const animation of container.getAnimations({ subtree: true })) {
    if (time === null) {
      animation.finish();
      continue;
    }
    if (animation.playState !== 'running') continue;
    animation.pause();
    animation.currentTime = time;
  }
}

/**
 * Opens and closes the panel beside `pageWith`, checking that what is under the reflowing block
 * glides from where it was on the first frame of each, on the `translate` transform property, and
 * lands where the new layout puts it.
 */
async function expectGlidesUpAndDown(pageWith: ReactNode, name: string): Promise<void> {
  const below = () => container.querySelector('[data-testid="below"]') as HTMLElement;
  const top = () => below().getBoundingClientRect().top;
  act(() => root.render(shellWithPanel(false, () => {}, pageWith)));
  const closed = top();

  act(() => root.render(shellWithPanel(true, () => {}, pageWith)));
  holdAll(0);
  expect(Math.abs(top() - closed), `${name}, opening: the first frame at ${top()}, was ${closed}`).toBeLessThanOrEqual(0.5);
  const lifts = below().getAnimations();
  expect(lifts, name).toHaveLength(1);
  expect(properties(lifts[0] as Animation), name).toEqual(['translate']);
  expect(lifts[0]?.effect?.getTiming().duration, name).toBe(Number.parseFloat(token('--motion-base')));
  expect(easing(lifts[0]?.effect?.getTiming().easing ?? ''), name).toBe(easing(token('--motion-ease-emphasis')));
  holdAll(null);
  const opened = top();
  expect(closed - opened, name).toBeCloseTo(24, 0);

  act(() => root.render(shellWithPanel(false, () => {}, pageWith)));
  holdAll(0);
  expect(Math.abs(top() - opened), `${name}, closing: the first frame at ${top()}, was ${opened}`).toBeLessThanOrEqual(0.5);
  expect(below().getAnimations()[0]?.effect?.getTiming().duration, name).toBe(Number.parseFloat(token('--motion-fast')));
  holdAll(null);
  expect(top(), name).toBeCloseTo(closed, 0);
}

it('what_the_new_width_moves_up_or_down_glides_too', async () => {
  // Laid out at its new width at once, the page changes height where its text or blocks reflow,
  // and what is under them moves: it glides there on a transform, as the page glides sideways, so
  // nothing jumps on the first frame of the open or the close. A block with its own transform
  // glides by the same distance on screen.
  await motion();
  await page.viewport(LAPTOP.width, LAPTOP.height);
  await expectGlidesUpAndDown(reflowingPage, 'a scaled block');
});

it('what_moves_inside_a_fixed_height_box_glides_too', async () => {
  // A box that keeps its height (a fill page's column) still lays out what is in it anew.
  await motion();
  await page.viewport(LAPTOP.width, LAPTOP.height);
  await expectGlidesUpAndDown(fixedHeightPage, 'a fixed-height box');
});

it('a_long_page_glides_at_most_200_blocks', async () => {
  // A thousand rows that each change height: only what can be seen moving glides, and never more
  // than 200 blocks; the rest land in place, as the page itself does.
  await motion();
  await page.viewport(LAPTOP.width, LAPTOP.height);
  const rows = (
    <div>
      {Array.from({ length: 1000 }, (_, index) => (
        <div key={index} data-row="" style={{ aspectRatio: '480 / 1' }} />
      ))}
    </div>
  );
  act(() => root.render(shellWithPanel(false, () => {}, rows)));
  act(() => root.render(shellWithPanel(true, () => {}, rows)));
  const lifted = [...container.querySelectorAll('[data-row]')].filter((row) => row.getAnimations().length > 0);
  expect(lifted.length).toBeGreaterThan(0);
  expect(lifted.length).toBeLessThanOrEqual(200);
  // Rows out of sight neither before nor after never glide.
  const last = container.querySelectorAll('[data-row]')[999] as HTMLElement;
  expect(last.getAnimations()).toHaveLength(0);
});

/** Where an element is drawn: its box's left and top. */
const at = (el: Element) => {
  const box = el.getBoundingClientRect();
  return { left: Math.round(box.left * 10) / 10, top: Math.round(box.top * 10) / 10 };
};

it('a_turned_or_3d_block_lands_in_place', async () => {
  // A glide is converted only through scaling and moving. A block that is turned, or under a box
  // with a perspective (in 3D), takes no glide: on the first frame it is already where the new
  // layout puts it, never somewhere else.
  await motion();
  await page.viewport(LAPTOP.width, LAPTOP.height);
  const turnedPage = (
    <div>
      <div style={{ aspectRatio: '8 / 1' }} />
      <div data-testid="turned" style={{ transform: 'rotate(30deg)' }}>
        <div data-testid="turned-child">Quotes</div>
      </div>
      <div data-testid="deep" style={{ perspective: '500px' }}>
        <div data-testid="deep-child" style={{ transform: 'translateZ(100px)' }}>
          Bookings
        </div>
      </div>
    </div>
  );
  const parts = ['turned', 'turned-child', 'deep', 'deep-child'].map((id) => () => container.querySelector(`[data-testid="${id}"]`) as HTMLElement);
  // Within the page, which glides sideways as a whole and carries every block with it.
  const inPage = (el: Element) => {
    const { left, top } = at(el);
    return { left: Math.round((left - content().getBoundingClientRect().left) * 10) / 10, top };
  };
  act(() => root.render(shellWithPanel(false, () => {}, turnedPage)));
  for (const open of [true, false]) {
    act(() => root.render(shellWithPanel(open, () => {}, turnedPage)));
    holdAll(0);
    expect(parts.map((part) => part().getAnimations().length), `${open ? 'opening' : 'closing'}: no glide`).toEqual([0, 0, 0, 0]);
    const first = parts.map((part) => inPage(part()));
    holdAll(null);
    expect(first, `${open ? 'opening' : 'closing'}: already in the new layout`).toEqual(parts.map((part) => inPage(part())));
  }
});

it('a_block_drawn_outside_its_box_is_judged_on_its_own', async () => {
  // A block whose own box is out of sight can draw what is in it in sight: unless it clips what is
  // inside it, what it draws in sight still glides from where it was.
  await motion();
  await page.viewport(LAPTOP.width, LAPTOP.height);
  // Far below the window, drawn 1,900 px up into it: the reflow above moves it up 24 px on opening.
  const farPage = (
    <div>
      <div style={{ aspectRatio: '8 / 1' }} />
      <div style={{ marginTop: '2000px' }}>
        <div data-testid="drawn-up" style={{ transform: 'translateY(-1900px)' }}>
          Quotes
        </div>
      </div>
    </div>
  );
  const drawnUp = () => container.querySelector('[data-testid="drawn-up"]') as HTMLElement;
  act(() => root.render(shellWithPanel(false, () => {}, farPage)));
  const closed = at(drawnUp()).top;
  expect(closed).toBeGreaterThan(0);
  expect(closed).toBeLessThan(LAPTOP.height);
  act(() => root.render(shellWithPanel(true, () => {}, farPage)));
  holdAll(0);
  expect(Math.abs(at(drawnUp()).top - closed), 'drawn up into sight: the first frame').toBeLessThanOrEqual(0.5);
  holdAll(null);

  // Out of sight above the window when the panel is open, and in sight once it has closed: its
  // box is out of sight both times, and it still glides into sight from where it was.
  const intoSight = (
    <div>
      <div style={{ aspectRatio: '1 / 1' }} />
      <div style={{ marginTop: '300px' }}>
        <div data-testid="into-sight" style={{ height: '20px', transform: 'translateY(-1188px)' }} />
      </div>
    </div>
  );
  const into = () => container.querySelector('[data-testid="into-sight"]') as HTMLElement;
  act(() => root.render(shellWithPanel(true, () => {}, intoSight)));
  holdAll(null);
  const opened = at(into()).top;
  expect(opened + 20).toBeLessThanOrEqual(0);
  act(() => root.render(shellWithPanel(false, () => {}, intoSight)));
  holdAll(0);
  expect(Math.abs(at(into()).top - opened), 'into sight: the first frame').toBeLessThanOrEqual(0.5);
  holdAll(null);
  expect(at(into()).top).toBeGreaterThan(0);
});
