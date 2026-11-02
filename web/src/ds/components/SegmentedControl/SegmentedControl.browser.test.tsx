/** Touch targets keep the track, labels and inline baseline exactly where they were. */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { chooseTheme } from '../../test/theme.ts';
import { pairContrast } from '../../contrast.ts';
import { expect, it } from 'vitest';

import { coarsePointer, expectApart, expectHitAreaLands, expectUnseen, hitArea } from '../../test/touch.ts';
import { SegmentedControl } from './SegmentedControl.tsx';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

it('touch_segments_reach_44_px_and_cap_their_shared_gap_without_moving', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(
    <div style={{ padding: 40, display: 'flex', flexDirection: 'column', gap: 40 }}>
      <div className="cd-type-body">
        <span>Show </span>
        <SegmentedControl label="What to show" options={[{ value: 'attempts', label: 'Attempts' }, { value: 'entries', label: 'Every entry' }]} value="attempts" onChange={() => {}} />
        <span> in Safety</span>
      </div>
      <SegmentedControl label="Short options" options={[{ value: 'a', label: 'I' }, { value: 'b', label: 'II' }]} value="a" onChange={() => {}} />
      <SegmentedControl label="One option" options={[{ value: 'a', label: 'I' }]} value="a" onChange={() => {}} />
    </div>,
  ));
  try {
    const options = [...host.querySelectorAll<HTMLElement>('.cd-segmented__option')];
    const visible = () => [...host.querySelectorAll('*')].map((element) => element.getBoundingClientRect().toJSON());
    const fine = visible();
    const scroll = [document.documentElement.scrollWidth, document.documentElement.scrollHeight];
    for (const option of options) expect(getComputedStyle(option, '::after').content).toBe('none');

    await coarsePointer();
    expect(visible(), 'the tracks, labels and surrounding text keep their boxes and baseline').toEqual(fine);
    expect([document.documentElement.scrollWidth, document.documentElement.scrollHeight], 'no added scroll').toEqual(scroll);
    for (const option of options) {
      const own = option.getBoundingClientRect();
      const area = hitArea(option);
      expect(area.height, `${option.textContent}: 44 px tall`).toBe(44);
      expect(own.top - area.top, 'centred vertically').toBe(area.bottom - own.bottom);
      expect(own.left - area.left, 'centred horizontally').toBe(area.right - own.right);
      expectHitAreaLands(option);
      expectUnseen(option);
    }
    for (const group of host.querySelectorAll('.cd-segmented')) {
      const [first, second] = [...group.querySelectorAll<HTMLElement>('button')];
      if (!first || !second) continue;
      expect(second.getBoundingClientRect().left - first.getBoundingClientRect().right, 'the shared gap').toBe(2);
      expectApart(hitArea(first), hitArea(second), 'adjacent segments');
    }
    const [short, next, alone] = options.slice(2) as [HTMLElement, HTMLElement, HTMLElement];
    expect(short.getBoundingClientRect().width).toBeLessThan(44);
    expect(hitArea(short).right - short.getBoundingClientRect().right, 'half the 2 px gap').toBe(1);
    expect(next.getBoundingClientRect().left - hitArea(next).left, 'half the 2 px gap').toBe(1);
    // Fractional text widths round the two CSS insets to Chromium's subpixel grid.
    expect(hitArea(alone).width, '44 px wide where there is room').toBeCloseTo(44, 1);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});


it.each(['dark', 'light'] as const)('the_selected_thumb_has_a_visible_edge_in_%s', async (theme) => {
  chooseTheme(theme);
  const screen = await render(<SegmentedControl label="Appearance" options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} value="dark" onChange={() => {}} />);
  try {
    const selected = screen.getByRole('radio', { name: 'Dark' }).element() as HTMLElement;
    const track = selected.parentElement!;
    const probe = document.createElement('span');
    probe.style.color = 'var(--line-focus)';
    track.append(probe);
    const edge = getComputedStyle(probe).color;
    probe.remove();
    const style = () => getComputedStyle(selected);
    const bounds = selected.getBoundingClientRect().toJSON();
    expect(style().boxShadow).toBe(`${edge} 0px 0px 0px 1px inset`);
    expect(pairContrast({ fg: edge, fgGround: style().backgroundColor, ground: getComputedStyle(track).backgroundColor, over: getComputedStyle(document.body).backgroundColor })).toBeGreaterThanOrEqual(3);
    await userEvent.hover(selected);
    expect(style().boxShadow).toBe(`${edge} 0px 0px 0px 1px inset`);
    await userEvent.keyboard('{Tab}');
    selected.focus();
    expect(selected.matches(':focus-visible')).toBe(true);
    expect(style().boxShadow).toBe(`${edge} 0px 0px 0px 2px inset`);
    expect(selected.getBoundingClientRect().toJSON()).toEqual(bounds);
  } finally {
    await screen.unmount();
    chooseTheme('dark');
  }
});
