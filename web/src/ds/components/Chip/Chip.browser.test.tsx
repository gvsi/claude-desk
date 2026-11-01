/** Chip touch targets, including Safety's wrapping filter rows. */
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';

import { coarsePointer, expectApart, expectHitAreaLands, expectUnseen, hitArea } from '../../test/touch.ts';
import { Chip } from './Chip.tsx';

import '../../../owner/safety/Safety.css';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

function mount(ui: ReactElement) {
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

const boxes = (host: HTMLElement) => [...host.querySelectorAll('*')].map((element) => element.getBoundingClientRect().toJSON());

it('a_chip_with_room_has_an_unseen_centred_44_px_touch_area_and_keeps_its_inline_baseline', async () => {
  const { host, unmount } = mount(
    <div style={{ padding: 40 }}>
      <p className="cd-type-body">
        <span>Try </span><Chip onClick={() => {}}>All</Chip><span> attempts</span>
      </p>
      <p style={{ marginTop: 40 }}><Chip onClick={() => {}}>I</Chip></p>
    </div>,
  );
  try {
    const chips = [...host.querySelectorAll<HTMLElement>('.cd-chip')];
    const fine = boxes(host);
    const scroll = [document.documentElement.scrollWidth, document.documentElement.scrollHeight];
    for (const chip of chips) expect(getComputedStyle(chip, '::after').content).toBe('none');
    await coarsePointer();
    expect(boxes(host), 'the chips, words and inline baseline keep their places').toEqual(fine);
    expect([document.documentElement.scrollWidth, document.documentElement.scrollHeight], 'no added scroll').toEqual(scroll);
    for (const chip of chips) {
      const own = chip.getBoundingClientRect();
      const area = hitArea(chip);
      expect(area.height, '44 px tall').toBe(44);
      expect(area.width, 'at least 44 px wide, allowing subpixel rounding').toBeCloseTo(Math.max(44, own.width), 1);
      expect(own.top - area.top, 'centred vertically').toBe(area.bottom - own.bottom);
      expect(own.left - area.left, 'centred horizontally').toBeCloseTo(area.right - own.right, 4);
      expectHitAreaLands(chip);
      expectUnseen(chip);
    }
  } finally {
    unmount();
  }
});

it('filter_chip_rows_cap_both_axes_at_half_the_gap_without_moving_or_adding_scroll', async () => {
  const { host, unmount } = mount(
    <div style={{ padding: 40, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 40 }}>
      <div className="cd-attempts__filters" role="group" aria-label="Show attempts" style={{ width: 358 }}>
        {['All', 'Money', 'Codes'].map((label, i) => <Chip key={label} selected={i === 0} onClick={() => {}}>{label}</Chip>)}
      </div>
      <div className="cd-attempts__filters" role="group" aria-label="Narrow filters" style={{ width: 80 }}>
        {['I', 'II', 'I', 'II'].map((label, i) => <Chip key={i} onClick={() => {}}>{label}</Chip>)}
      </div>
      <div className="scroller" style={{ width: 80, height: 100, overflowY: 'auto' }}>
        <div style={{ height: 160 }} />
        <div className="board-chips" role="radiogroup" aria-label="Kind of attempt" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}>
          {['I', 'II', 'I', 'II'].map((label, i) => <Chip key={i} asRadio selected={false} onClick={() => {}}>{label}</Chip>)}
        </div>
      </div>
    </div>,
  );
  try {
    const groups = [...host.querySelectorAll<HTMLElement>('[role="group"], [role="radiogroup"]')];
    const scroller = host.querySelector<HTMLElement>('.scroller') as HTMLElement;
    const fine = boxes(host);
    const scroll = [scroller.scrollWidth, scroller.scrollHeight, document.documentElement.scrollWidth, document.documentElement.scrollHeight];
    expect(new Set([...groups[0]!.children].map((chip) => chip.getBoundingClientRect().top)).size, 'one row').toBe(1);
    for (const group of groups.slice(1)) {
      expect(new Set([...group.children].map((chip) => chip.getBoundingClientRect().top)).size, 'two rows').toBe(2);
    }
    await coarsePointer();
    expect(boxes(host), 'the pills, selected check and rows keep their boxes').toEqual(fine);
    expect([scroller.scrollWidth, scroller.scrollHeight, document.documentElement.scrollWidth, document.documentElement.scrollHeight], 'no added scroll even at a flush edge').toEqual(scroll);
    for (const group of groups) {
      const chips = [...group.querySelectorAll<HTMLElement>('.cd-chip')];
      for (let i = 0; i < chips.length; i += 1) {
        const chip = chips[i]!;
        const own = chip.getBoundingClientRect();
        const area = hitArea(chip);
        expect([own.top - area.top, area.bottom - own.bottom], '4 px past each border, halfway across the 8 px row gap').toEqual([4, 4]);
        if (own.width < 36) expect([own.left - area.left, area.right - own.right], 'half the inline gap too').toEqual([4, 4]);
        expectUnseen(chip);
        if (group !== groups[2]) expectHitAreaLands(chip);
        for (const next of chips.slice(i + 1)) expectApart(area, hitArea(next), `${chip.textContent} and ${next.textContent}`);
      }
    }
    // The last row ends the scroll region flush. Its hit area must not extend the scroll range,
    // while taps just above it still land after scrolling it into view.
    scroller.scrollTop = scroller.scrollHeight;
    for (const chip of groups[2]!.querySelectorAll<HTMLElement>('.cd-chip')) {
      const own = chip.getBoundingClientRect();
      expect(chip.contains(document.elementFromPoint(own.left + own.width / 2, own.top - 3)), 'the extension still takes a tap inside the scroller').toBe(true);
    }
  } finally {
    unmount();
  }
});
