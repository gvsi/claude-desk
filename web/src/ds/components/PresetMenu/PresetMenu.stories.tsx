import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useRef, useState } from 'react';
import { expect, fn, waitFor, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { PRESET_WORDS } from '../OutcomeMenu/outcomeWords.ts';
import { PresetMenu, type PresetMenuProps } from './PresetMenu.tsx';

const meta = {
  title: 'Rules/PresetMenu',
  component: PresetMenu,
  args: { onPick: fn() },
  // The page header's right edge, as the board places the menu there.
  render: (args) => (
    <div style={{ display: 'flex', justifyContent: 'flex-end', maxWidth: 960, minHeight: 260 }}>
      <PresetMenu {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Conn-17-Presets' },
} satisfies Meta<typeof PresetMenu>;

export default meta;

type Story = StoryObj<typeof meta>;

const BUTTON = 'Start from a preset';

/** The open menu, named by its button. */
function theMenu(canvasElement: HTMLElement) {
  return within(canvasElement).getByRole('menu', { name: BUTTON });
}

export const Closed: Story = {
  parameters: { canvasNote: 'The menu shut; the board draws it open.' },
  play: async ({ canvas }) => {
    // A secondary menu button at a screen's main height, with its chevron.
    const button = canvas.getByRole('button', { name: BUTTON });
    await expect(button).toHaveClass('cd-button--secondary');
    await expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button.querySelector('.cd-button__chevron')).not.toBeNull();
    expectComputed(button, { height: '40px', backgroundColor: 'rgba(250, 249, 245, 0.1)' });
    await expect(canvas.queryByRole('menu')).toBeNull();
  },
};

export const Open: Story = {
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const button = canvas.getByRole('button', { name: BUTTON });
    await userEvent.click(button);
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    const menu = theMenu(canvasElement);
    // Two items, each named by its label and described by its description; nothing is checked or current.
    const items = within(menu).getAllByRole('menuitem');
    await expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual([null, null]);
    for (const [i, preset] of PRESET_WORDS.entries()) {
      await expect(items[i]).toHaveAccessibleName(preset.label);
      await expect(items[i]).toHaveAccessibleDescription(preset.description);
    }
    await expect(within(menu).queryAllByRole('menuitemradio')).toEqual([]);
    await expect(menu.querySelector('[aria-current], [aria-selected]')).toBeNull();
    await expect(items[0]).toHaveFocus();
    // A popover 6 px under the button, 360 px wide, its right edge on the button's.
    const box = menu.getBoundingClientRect();
    const at = button.getBoundingClientRect();
    await expect(box.top - at.bottom).toBe(6);
    await expect(box.width).toBe(360);
    await expect(box.right).toBe(at.right);
    expectComputed(menu, { backgroundColor: 'rgb(42, 41, 39)', borderTopColor: 'rgba(250, 249, 245, 0.14)', borderTopLeftRadius: '12px' });
    const title = within(items[1] as HTMLElement).getByText(PRESET_WORDS[1].label);
    const line = within(items[1] as HTMLElement).getByText(PRESET_WORDS[1].description);
    expectComputed(title, { fontSize: '15px', color: 'rgba(250, 249, 245, 0.92)' });
    expectComputed(line, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(args.onPick).not.toHaveBeenCalled();
  },
};

export const PickOnce: Story = {
  parameters: { canvasNote: 'A preset picked; the board draws the menu open.' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // preset_pick_calls_once: choosing an item calls onPick once with its preset and closes the
    // menu, focus back on the button; a second press lands on the page, not on the item.
    const button = canvas.getByRole('button', { name: BUTTON });
    await userEvent.click(button);
    const recommended = within(theMenu(canvasElement)).getByRole('menuitem', { name: 'Recommended rules' });
    await userEvent.dblClick(recommended);
    await expect(args.onPick).toHaveBeenCalledTimes(1);
    await expect(args.onPick).toHaveBeenCalledWith('auto');
    await expect(canvas.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(button).toHaveFocus());
    await userEvent.click(button);
    await userEvent.click(within(theMenu(canvasElement)).getByRole('menuitem', { name: 'Ask me first' }));
    await expect(args.onPick).toHaveBeenCalledTimes(2);
    await expect(args.onPick).toHaveBeenLastCalledWith('ask_first');
  },
};

export const ByKeyboard: Story = {
  parameters: { canvasNote: 'The menu by keyboard; the board draws it open.' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // menu_by_keyboard: Tab to the button; Enter opens on the first item; Down moves and wraps;
    // Escape closes with no call and focus on the button; Up opens on the last; Enter chooses.
    const button = canvas.getByRole('button', { name: BUTTON });
    await userEvent.tab();
    await expect(button).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const first = within(theMenu(canvasElement)).getByRole('menuitem', { name: 'Ask me first' });
    await expect(first).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await expect(first).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(button).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    await expect(within(theMenu(canvasElement)).getByRole('menuitem', { name: 'Recommended rules' })).toHaveFocus();
    await expect(args.onPick).not.toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
    await expect(args.onPick).toHaveBeenCalledTimes(1);
    await expect(args.onPick).toHaveBeenCalledWith('auto');
    await expect(button).toHaveFocus();
  },
};

export const TabCloses: Story = {
  parameters: { canvasNote: 'The menu by keyboard; the board draws it open.' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // tab_closes_the_menu: Tab in the open menu closes it, chooses nothing, and leaves focus on the button.
    const button = canvas.getByRole('button', { name: BUTTON });
    button.focus();
    await userEvent.keyboard('{Enter}');
    await expect(within(theMenu(canvasElement)).getByRole('menuitem', { name: 'Ask me first' })).toHaveFocus();
    await userEvent.keyboard('{Tab}');
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(button).toHaveFocus();
    await expect(args.onPick).not.toHaveBeenCalled();
  },
};

export const SpaceChooses: Story = {
  parameters: { canvasNote: 'The menu by keyboard; the board draws it open.' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // space_chooses: Space on an item chooses it once, as Enter does, and focus goes back to the button.
    const button = canvas.getByRole('button', { name: BUTTON });
    button.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{ArrowDown}');
    await expect(within(theMenu(canvasElement)).getByRole('menuitem', { name: 'Recommended rules' })).toHaveFocus();
    await userEvent.keyboard(' ');
    await expect(args.onPick).toHaveBeenCalledTimes(1);
    await expect(args.onPick).toHaveBeenCalledWith('auto');
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(button).toHaveFocus();
  },
};

/**
 * The menu as the Rules page holds it, whose draft can start while the menu is open (a pick from
 * another tab, say): the event `draft-started` on the wrapper turns `pending` on, as the screen would.
 */
function PendingLater(props: PresetMenuProps) {
  const [pending, setPending] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current;
    const start = () => setPending(true);
    element?.addEventListener('draft-started', start);
    return () => element?.removeEventListener('draft-started', start);
  }, []);
  return (
    <div ref={root} className="preset-menu-story-pending">
      <PresetMenu {...props} pending={pending} />
    </div>
  );
}

export const PendingClosesTheMenu: Story = {
  render: (args) => (
    <div style={{ display: 'flex', justifyContent: 'flex-end', maxWidth: 960, minHeight: 260 }}>
      <PendingLater {...args} />
    </div>
  ),
  parameters: { canvasNote: "A preset's draft that starts while the menu is open; the board draws the menu open." },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // pending_closes_the_menu: when the draft starts, the open menu shuts, focus goes back to the
    // button, which turns busy, and nothing is chosen.
    const button = canvas.getByRole('button', { name: BUTTON });
    button.focus();
    await userEvent.keyboard('{Enter}');
    await expect(within(theMenu(canvasElement)).getByRole('menuitem', { name: 'Ask me first' })).toHaveFocus();
    canvasElement.querySelector('.preset-menu-story-pending')?.dispatchEvent(new Event('draft-started'));
    await waitFor(() => expect(canvas.queryByRole('menu')).toBeNull());
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toHaveFocus();
    await expect(args.onPick).not.toHaveBeenCalled();
  },
};

export const Pending: Story = {
  args: { pending: true },
  parameters: { canvasNote: "A preset's draft in flight; the board draws the menu open." },
  play: async ({ args, canvas, userEvent }) => {
    // While the screen drafts the picked preset, the button keeps its label under the busy spinner
    // and the menu stays shut.
    const button = canvas.getByRole('button', { name: BUTTON });
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(button);
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(args.onPick).not.toHaveBeenCalled();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  render: (args) => (
    <div style={{ minHeight: 320 }}>
      <PresetMenu {...args} />
    </div>
  ),
  parameters: { canvas: 'N-Conn-22-Phone-Presets' },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(390);
    // On a phone the button fills its line, its words at the left and the chevron at the right,
    // and the menu opens under it at the same width.
    const button = canvas.getByRole('button', { name: BUTTON });
    const line = canvasElement.querySelector('.cd-preset-menu')?.parentElement;
    if (!line) throw new Error('No line');
    await expect(button.getBoundingClientRect().width).toBe(line.getBoundingClientRect().width);
    const words = button.querySelector('.cd-button__label');
    if (!words) throw new Error('No label');
    await expect(words.getBoundingClientRect().left - button.getBoundingClientRect().left).toBe(14);
    const chevron = button.querySelector('.cd-button__chevron');
    if (!chevron) throw new Error('No chevron');
    await expect(button.getBoundingClientRect().right - chevron.getBoundingClientRect().right).toBe(10);
    await userEvent.click(button);
    const menu = theMenu(canvasElement);
    await expect(menu.getBoundingClientRect().width).toBe(button.getBoundingClientRect().width);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
