/**
 * IconButton on a touch screen: a 32 px button takes a tap anywhere in the 44 px square centred on
 * it, through an unseen hit area, and its box, look and place stay as they are. Where the composer
 * puts its controls closer together than that, each hit area stops halfway across the gap.
 */
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';

import { coarsePointer, expectApart, expectHitAreaLands, expectUnseen, hitArea } from '../../test/touch.ts';
import { Composer } from '../Composer/Composer.tsx';
import { IconButton } from './IconButton.tsx';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

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

it('touch_hit_area_is_a_44_px_square_unseen', async () => {
  const { host, unmount } = mount(
    <div style={{ display: 'flex', gap: 40, padding: 40 }}>
      <IconButton label="Close" icon="close" />
      <IconButton label="Send" icon="send" variant="primary" shape="round" />
    </div>,
  );
  try {
    const buttons = [...host.querySelectorAll<HTMLElement>('.cd-icon-button')];
    const fine = buttons.map((button) => button.getBoundingClientRect().toJSON());
    expect(getComputedStyle(buttons[0] as HTMLElement, '::after').content, 'no hit area under a fine pointer').toBe('none');

    await coarsePointer();
    expect(
      buttons.map((button) => button.getBoundingClientRect().toJSON()),
      'the buttons keep their boxes',
    ).toEqual(fine);
    for (const button of buttons) {
      const own = button.getBoundingClientRect();
      const area = hitArea(button);
      const label = button.getAttribute('aria-label') ?? '';
      expect([area.width, area.height], `${label}: a 44 px square`).toEqual([44, 44]);
      expect([own.left - area.left, own.top - area.top], `${label}: centred`).toEqual([6, 6]);
      expectHitAreaLands(button, label);
      expectUnseen(button);
    }
  } finally {
    unmount();
  }
});

it('touch_hit_area_of_a_sole_composer_send_reaches_44_px', async () => {
  const { host, unmount } = mount(
    <div style={{ width: 358, padding: 40 }}>
      <Composer
        variant="owner"
        label="Ask Claude about your rules"
        placeholder="Ask Claude about your rules"
        helper="Rule changes are shown to you before they apply."
        onSend={() => {}}
      />
    </div>,
  );
  try {
    const buttons = host.querySelectorAll<HTMLElement>('.cd-icon-button');
    expect(buttons).toHaveLength(1);
    const send = buttons[0] as HTMLElement;
    const fine = send.getBoundingClientRect().toJSON();
    await coarsePointer();
    expect(send.getBoundingClientRect().toJSON(), 'Send keeps its visible box').toEqual(fine);
    const area = hitArea(send);
    expect([area.width, area.height], 'a sole Send has no neighbouring button to cap its reach').toEqual([44, 44]);
    expectHitAreaLands(send, 'Send');
    expectUnseen(send);
  } finally {
    unmount();
  }
});

it('touch_hit_areas_in_the_composer_stay_apart', async () => {
  // The owner composer's speak and send buttons sit 4 px apart, and the visitor composer's controls
  // 8 px apart on one row with its text box: each hit area reaches halfway across its gap, and the
  // full 6 px up and down, so a tap between two of them lands on the nearer one.
  const tools = { onSend: () => {}, onAttach: () => {}, onSpeak: () => {} };
  const { host, unmount } = mount(
    <div style={{ display: 'grid', gap: 40, width: 640, padding: 40 }}>
      <Composer
        variant="owner"
        label="Ask Claude about your Desk, or change a rule"
        placeholder="Ask Claude about your Desk, or change a rule"
        helper="Rule changes are shown to you before they apply."
        {...tools}
      />
      <Composer variant="visitor" label="Message Turner Plumbing" placeholder="Message Turner Plumbing" {...tools} />
    </div>,
  );
  try {
    await coarsePointer();
    const [owner, visitor] = [...host.querySelectorAll<HTMLElement>('.cd-composer')] as [HTMLElement, HTMLElement];
    const ownerButtons = [...owner.querySelectorAll<HTMLElement>('.cd-composer__tools > .cd-icon-button')];
    const visitorRow = [...visitor.querySelectorAll<HTMLElement>('.cd-composer__box > .cd-icon-button, .cd-composer__box > textarea')];
    for (const [row, gap] of [
      [ownerButtons, 4],
      [visitorRow, 8],
    ] as const) {
      for (let i = 1; i < row.length; i += 1) {
        const [before, after] = [row[i - 1] as HTMLElement, row[i] as HTMLElement];
        // Neighbours only: the owner's attach button is at the other end of its row.
        if (before.nextElementSibling !== after) continue;
        const name = (el: HTMLElement) => el.getAttribute('aria-label') ?? el.localName;
        const label = `${name(before)} and ${name(after)}`;
        expect(Math.round(after.getBoundingClientRect().left - before.getBoundingClientRect().right), `${label}: ${gap} px apart`).toBe(gap);
        expectApart(hitArea(before), hitArea(after), label);
      }
    }
    for (const button of [...ownerButtons, ...visitor.querySelectorAll<HTMLElement>('.cd-icon-button')]) {
      expect(hitArea(button).height, `${button.getAttribute('aria-label')}: 44 px tall`).toBe(44);
      expectHitAreaLands(button, button.getAttribute('aria-label') ?? '');
    }
  } finally {
    unmount();
  }
});
