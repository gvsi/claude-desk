/**
 * Suggestion chips on a touch screen. A chip is 28 px tall and its neighbours are 8 px away, beside
 * it and, once the row wraps on a phone, above and below it, so its unseen hit area reaches halfway
 * across each gap and no further: a tap between two chips lands on the nearer one, and nothing about
 * the chips moves or shows.
 */
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';

import { coarsePointer, expectApart, expectHitAreaLands, expectUnseen, hitArea } from '../../test/touch.ts';
import { SuggestionChips } from './SuggestionChips.tsx';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** Setup's three examples, which wrap onto their own lines in a phone's 358 px column. */
const EXAMPLES = ['A plumber in Oakland', 'A bakery that takes custom orders', 'A tax preparer'];

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

it('touch_hit_areas_reach_halfway_to_each_neighbour', async () => {
  const { host, unmount } = mount(
    <div style={{ width: 358, padding: 16 }}>
      <SuggestionChips label="Examples" suggestions={EXAMPLES} onPick={() => {}} />
    </div>,
  );
  try {
    const chips = [...host.querySelectorAll<HTMLElement>('.cd-chip')];
    const fine = chips.map((chip) => chip.getBoundingClientRect().toJSON());
    const group = host.querySelector<HTMLElement>('.cd-suggestion-chips')?.getBoundingClientRect().toJSON();
    expect(getComputedStyle(chips[0] as HTMLElement, '::after').content, 'no hit area under a fine pointer').toBe('none');
    // The row wraps: the second chip starts a line under the first, 8 px below it.
    const [first, second] = fine as [DOMRect, DOMRect];
    expect(second.top - first.bottom, 'the rows are 8 px apart').toBe(8);

    await coarsePointer();
    expect(chips.map((chip) => chip.getBoundingClientRect().toJSON()), 'the chips keep their boxes').toEqual(fine);
    expect(host.querySelector<HTMLElement>('.cd-suggestion-chips')?.getBoundingClientRect().toJSON(), 'the row keeps its box').toEqual(group);
    for (const chip of chips) {
      const own = chip.getBoundingClientRect();
      const area = hitArea(chip);
      // 4 px past each edge, half the gap: 36 px tall where 44 would reach into the next row.
      expect([own.top - area.top, area.bottom - own.bottom], `${chip.textContent}: halfway to the rows above and below`).toEqual([4, 4]);
      expect(area.width, `${chip.textContent}: as wide as the chip, already over 44 px`).toBe(own.width);
      expectHitAreaLands(chip);
      expectUnseen(chip);
    }
    for (let i = 0; i < chips.length; i += 1) {
      for (let j = i + 1; j < chips.length; j += 1) {
        const [a, b] = [chips[i] as HTMLElement, chips[j] as HTMLElement];
        expectApart(hitArea(a), hitArea(b), `${a.textContent} and ${b.textContent}`);
      }
    }
  } finally {
    unmount();
  }
});

it('touch_hit_areas_side_by_side_stay_apart', async () => {
  // Short suggestions share a line, 8 px apart: the hit areas meet in the middle of the gap.
  const { host, unmount } = mount(
    <div style={{ width: 600, padding: 16 }}>
      <SuggestionChips label="Suggestions" suggestions={['Book a visit', 'Get a quote', 'Hours']} onPick={() => {}} />
    </div>,
  );
  try {
    await coarsePointer();
    const chips = [...host.querySelectorAll<HTMLElement>('.cd-chip')];
    expect(new Set(chips.map((chip) => chip.getBoundingClientRect().top)).size, 'one line').toBe(1);
    for (let i = 1; i < chips.length; i += 1) {
      const [a, b] = [chips[i - 1] as HTMLElement, chips[i] as HTMLElement];
      expect(b.getBoundingClientRect().left - a.getBoundingClientRect().right, 'side by side, 8 px apart').toBe(8);
      expectApart(hitArea(a), hitArea(b), `${a.textContent} and ${b.textContent}`);
    }
    for (const chip of chips) expectHitAreaLands(chip);
  } finally {
    unmount();
  }
});
