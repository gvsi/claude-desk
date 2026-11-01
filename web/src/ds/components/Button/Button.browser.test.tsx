/**
 * A busy button under prefers-reduced-motion: reduce, which this project's browser context
 * emulates. The BusyReducedMotion story runs with its play, so its reduced-motion branch is the one
 * checked: the spinner is a still arc, and the button is still named by its label. And the button's
 * ref, which lets go while the button is still on the page, and, on a touch screen, the unseen hit
 * area that takes a tap just beside it without ever overlapping a neighbour's.
 */
import { composeStory } from '@storybook/react-vite';
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';

import { coarsePointer, expectApart, expectHitAreaLands, expectUnseen, hitArea } from '../../test/touch.ts';
import { Card } from '../Card/Card.tsx';
import { Button } from './Button.tsx';
import meta, { BusyReducedMotion } from './Button.stories.tsx';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

it('busy_spinner_still_under_reduced_motion', async () => {
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  const story = composeStory(BusyReducedMotion, meta);
  await story.run();

  const spinners = [...document.querySelectorAll<SVGElement>('svg.cd-button__spinner')];
  expect(spinners).toHaveLength(1);
  const spinner = spinners[0] as SVGElement;
  const style = getComputedStyle(spinner);
  expect(style.animationName).toBe('none');
  // Still an arc, in the busy label color, where it would start turning.
  expect(style.color).toBe('rgba(250, 249, 245, 0.64)');
  expect(spinner.querySelector('path')).not.toBeNull();
});

it('button_ref_lets_go_while_the_button_is_on_the_page', () => {
  // `buttonRef` is the <button> itself, and React lets go of it (calls it with null) before it takes
  // the button off the page, so a screen can still read then whether the button had focus.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const calls: { element: string; connected?: boolean; focused?: boolean }[] = [];
  const held: { button: HTMLButtonElement | null } = { button: null };
  const ref = (element: HTMLButtonElement | null) => {
    const { button } = held;
    if (element === null) calls.push({ element: 'null', connected: button?.isConnected, focused: button !== null && document.activeElement === button });
    else calls.push({ element: element.localName });
    held.button = element;
  };
  try {
    act(() => root.render(<Button variant="secondary" buttonRef={ref}>Ask for Mike Turner</Button>));
    held.button?.focus();
    act(() => root.render(null));
    expect(calls).toEqual([{ element: 'button' }, { element: 'null', connected: true, focused: true }]);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

/** Renders `ui` into a fresh host on the page; the returned function takes it off again. */
function mount(ui: ReactElement): { host: HTMLDivElement; unmount: () => void } {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(ui));
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('touch_hit_area_reaches_44_px_unseen', async () => {
  // On a touch phone a 32 px button gets an unseen hit area, centred on it, 44 px tall: a finger
  // that lands just above or below it still presses it. The button itself doesn't move or grow.
  const { host, unmount } = mount(
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 40, padding: 40 }}>
      <Button variant="secondary">Open your public page</Button>
      <Button variant="primary" size="main">
        Send counter-offer
      </Button>
    </div>,
  );
  try {
    const [inline, main] = [...host.querySelectorAll<HTMLElement>('.cd-button')] as [HTMLElement, HTMLElement];
    const fine = [inline.getBoundingClientRect().toJSON(), main.getBoundingClientRect().toJSON()];
    expect(getComputedStyle(inline, '::after').content, 'no hit area under a fine pointer').toBe('none');

    await coarsePointer();
    expect([inline.getBoundingClientRect().toJSON(), main.getBoundingClientRect().toJSON()], 'the buttons keep their boxes').toEqual(fine);
    for (const button of [inline, main]) {
      const own = button.getBoundingClientRect();
      const area = hitArea(button);
      expect(area.height, `${button.textContent}: 44 px tall`).toBe(44);
      expect(area.width, `${button.textContent}: as wide as the button, already over 44 px`).toBe(own.width);
      expect(own.top - area.top, `${button.textContent}: centred`).toBe(area.bottom - own.bottom);
      expectHitAreaLands(button);
      expectUnseen(button);
    }
  } finally {
    unmount();
  }
});

it('touch_hit_areas_of_neighbours_never_overlap', async () => {
  // Side by side, 8 px apart as an approval's answers are: each button is wider than 44 px, so its
  // hit area only grows up and down, and a tap between them lands on the nearer one or on neither.
  // Stacked 8 px apart, where 6 px each way would meet in the gap, the layout caps the reach at
  // half its gap (--cd-touch-reach-block), so the two hit areas meet in its middle and never overlap.
  const { host, unmount } = mount(
    <div style={{ display: 'flex', flexDirection: 'column', gap: 40, padding: 40 }}>
      <div className="row" style={{ display: 'flex', gap: 'var(--space-8)' }}>
        <Button variant="secondary">Allow this time</Button>
        <Button variant="danger">Deny this time</Button>
      </div>
      <div className="stack" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 'var(--space-8)' }}>
        <Button variant="ghost" size="inline">
          Share your Desk
        </Button>
        <Button variant="ghost" size="inline">
          Start over
        </Button>
      </div>
    </div>,
  );
  try {
    await coarsePointer();
    const [allow, deny] = [...host.querySelectorAll<HTMLElement>('.row .cd-button')] as [HTMLElement, HTMLElement];
    expect(hitArea(allow).height, 'side by side: still 44 px tall').toBe(44);
    expectApart(hitArea(allow), hitArea(deny), 'side by side');

    const stack = host.querySelector<HTMLElement>('.stack');
    stack?.style.setProperty('--cd-touch-reach-block', 'calc(var(--space-8) / 2)');
    const [share, start] = [...host.querySelectorAll<HTMLElement>('.stack .cd-button')] as [HTMLElement, HTMLElement];
    expect(hitArea(share).bottom, 'stacked: the hit area stops halfway across the gap').toBe(share.getBoundingClientRect().bottom + 4);
    expectApart(hitArea(share), hitArea(start), 'stacked');
    for (const button of [allow, deny, share, start]) expectHitAreaLands(button);
  } finally {
    unmount();
  }
});

it('touch_hit_areas_past_card_edges_stay_apart', async () => {
  // Rules cards sit 16 px apart on phones (20 px on desktop). Zero padding puts these controls
  // right against the facing edges: both hit areas must work beyond their cards without meeting.
  const { host, unmount } = mount(
    <div style={{ display: 'grid', gap: 'var(--space-16)', width: 358, padding: 40 }}>
      <Card padding={0} label="First card">
        <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
          <Button variant="secondary">Open first rule</Button>
        </div>
      </Card>
      <Card padding={0} label="Next card">
        <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
          <Button variant="secondary">Open next rule</Button>
        </div>
      </Card>
    </div>,
  );
  try {
    const cards = [...host.querySelectorAll<HTMLElement>('.cd-card')];
    const buttons = [...host.querySelectorAll<HTMLElement>('.cd-button')];
    const [firstCard, nextCard] = cards as [HTMLElement, HTMLElement];
    const [first, next] = buttons as [HTMLElement, HTMLElement];
    const visibleBoxes = () => [...cards, ...buttons].map((element) => element.getBoundingClientRect().toJSON());
    const fine = visibleBoxes();
    expect(nextCard.getBoundingClientRect().top - firstCard.getBoundingClientRect().bottom, 'the usual phone card gap').toBe(16);

    await coarsePointer();
    expect(visibleBoxes(), 'the cards and controls keep their visible boxes').toEqual(fine);
    const firstArea = hitArea(first);
    const nextArea = hitArea(next);
    expect(firstArea.bottom, 'the first hit area extends below its card').toBeGreaterThan(firstCard.getBoundingClientRect().bottom);
    expect(nextArea.top, 'the next hit area extends above its card').toBeLessThan(nextCard.getBoundingClientRect().top);
    expectApart(firstArea, nextArea, 'controls across the card gap');
    for (const button of buttons) {
      expect(hitArea(button).height, 'the full 44 px target is available across the card edge').toBe(44);
      expectHitAreaLands(button);
      expectUnseen(button);
    }
  } finally {
    unmount();
  }
});
