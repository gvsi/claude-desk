/**
 * Touch targets keep the track, labels and inline baseline exactly where they were, and the chosen
 * segment shows by its edge, not by its ink alone.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { coarsePointer, expectApart, expectHitAreaLands, expectUnseen, hitArea } from '../../test/touch.ts';
import { chooseTheme } from '../../test/theme.ts';
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

it('the_chosen_segment_has_a_field_edge_and_choosing_moves_nothing', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const options = [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }];
  const draw = (value: string) => act(() => root.render(<SegmentedControl label="Appearance" options={options} value={value} onChange={() => {}} />));
  const segments = () => [...host.querySelectorAll<HTMLElement>('.cd-segmented__option')];
  const edges = () => segments().map((segment) => {
    const style = getComputedStyle(segment);
    return [style.borderTopWidth, style.borderTopStyle, style.borderTopColor].join(' ');
  });
  const boxes = () => [host.querySelector('.cd-segmented'), ...segments()].map((element) => element!.getBoundingClientRect().toJSON());
  const field = () => getComputedStyle(host.querySelector('.cd-segmented')!).getPropertyValue('--line-field').trim();
  const resolved = (color: string) => {
    const probe = document.createElement('span');
    probe.style.color = color;
    host.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  };
  try {
    for (const theme of ['dark', 'light'] as const) {
      chooseTheme(theme);
      draw('system');
      // The chosen segment's edge is the field outline, which reads 3:1 on the track in both themes
      // (contrast.ts); the others keep a clear edge of the same width, so nothing shifts.
      const chosen = `1px solid ${resolved(field())}`;
      const clear = '1px solid rgba(0, 0, 0, 0)';
      expect(edges(), theme).toEqual([chosen, clear, clear]);
      const before = boxes();
      draw('dark');
      expect(edges(), theme).toEqual([clear, clear, chosen]);
      expect(boxes(), `${theme}: choosing moves no segment and no track`).toEqual(before);
    }
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('keyboard_focus_draws_a_2px_focus_edge_unlike_the_chosen_segments_field_edge', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const options = [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }];
  const resolved = (color: string) => {
    const probe = document.createElement('span');
    probe.style.color = color;
    host.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  };
  const before = document.createElement('button');
  before.textContent = 'Before';
  host.before(before);
  try {
    for (const theme of ['dark', 'light'] as const) {
      chooseTheme(theme);
      act(() => root.render(<SegmentedControl label="Appearance" options={options} value="light" onChange={() => {}} />));
      const chosen = host.querySelector<HTMLElement>('.cd-segmented__option[aria-checked="true"]')!;
      const box = chosen.getBoundingClientRect().toJSON();
      const focus = resolved(getComputedStyle(chosen).getPropertyValue('--line-focus').trim());
      // Reached by keyboard: the border and base.css's inset, both line-focus, a 2 px edge that
      // differs from the chosen segment's 1 px line-field edge in colour and width, and nothing moves.
      before.focus();
      await userEvent.keyboard('{Tab}');
      expect(document.activeElement, theme).toBe(chosen);
      const style = getComputedStyle(chosen);
      expect(style.borderTopColor, theme).toBe(focus);
      expect(style.boxShadow, theme).toBe(`${focus} 0px 0px 0px 1px inset`);
      expect(chosen.getBoundingClientRect().toJSON(), `${theme}: focus moves nothing`).toEqual(box);
      // Hovered too, the chosen option keeps its fill and the focus edge stays one colour.
      await userEvent.hover(chosen);
      expect(getComputedStyle(chosen).borderTopColor, `${theme}: hovered with focus`).toBe(focus);
      expect(getComputedStyle(chosen).boxShadow, `${theme}: hovered with focus`).toBe(`${focus} 0px 0px 0px 1px inset`);
      await userEvent.unhover(chosen);
      chosen.blur();
    }
  } finally {
    act(() => root.unmount());
    host.remove();
    before.remove();
  }
});
