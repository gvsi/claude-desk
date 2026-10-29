import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { Button } from './Button.tsx';

/** The signed-off deny answers: the refused rose at 16% behind #eba3ae words. */
const DANGER_FILL = 'rgba(220, 130, 144, 0.16)';
const DANGER_TEXT = 'rgb(235, 163, 174)';
const ANSWERS_NOTE =
  "The signed-off answer boards (N-Answers-Final, N-Answers-Verified) replace this board's four secondary answers: Deny this time is the soft red danger button, Deny always the red-text danger-ghost.";

const meta = {
  title: 'Actions/Button',
  component: Button,
  args: { variant: 'secondary', children: 'Allow this time', onClick: fn() },
  parameters: { layout: 'padded', canvas: 'N-Today-NeedsYou' },
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Primary: Story = {
  args: { variant: 'primary', children: 'Send counter-offer' },
  play: async ({ args, canvas, userEvent }) => {
    // The control for Disabled and Busy: an enabled button does call its handler.
    const button = canvas.getByRole('button', { name: 'Send counter-offer' });
    await userEvent.click(button);
    await expect(args.onClick).toHaveBeenCalledTimes(1);
    // A plain button says nothing about a menu.
    await expect(button).not.toHaveAttribute('aria-haspopup');
    await expect(button).not.toHaveAttribute('aria-expanded');
    await expect(button.querySelector('svg')).toBeNull();
  },
};

export const Secondary: Story = {};

export const Ghost: Story = {
  args: { variant: 'ghost', children: 'Start over' },
};

export const Main: Story = {
  args: { variant: 'primary', size: 'main', children: 'Join the chat' },
};

export const Disabled: Story = {
  args: { disabled: true },
  parameters: { canvasNote: 'The board shows no disabled button; this is the approval button while it cannot be used.' },
  play: async ({ args, canvas, userEvent }) => {
    const button = canvas.getByRole('button', { name: 'Allow this time' });
    await expect(button).toBeDisabled();
    await userEvent.click(button);
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

export const Busy: Story = {
  args: { variant: 'primary', busy: true, children: 'Send counter-offer' },
  parameters: { canvasNote: 'The board shows no button mid-request; this is the counter-offer button while it sends.' },
  play: async ({ args, canvas, userEvent }) => {
    const button = canvas.getByRole('button', { name: 'Send counter-offer' });
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(button);
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

export const AsLink: Story = {
  args: { href: '/pay/k7Hq2vX9', children: 'Open payment page' },
  parameters: { canvasNote: 'The board has no link styled as a button; payment and document cards end with one.' },
  play: async ({ canvas }) => {
    const links = canvas.getAllByRole('link');
    await expect(links).toHaveLength(1);
    await expect(links[0]).toHaveAccessibleName('Open payment page');
    await expect(links[0]).toHaveAttribute('href', '/pay/k7Hq2vX9');
    await expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(canvas.queryByRole('button')).toBeNull();
  },
};

export const Danger: Story = {
  args: { variant: 'danger', size: 'main', children: 'Deny this time' },
  parameters: { canvasNote: ANSWERS_NOTE },
  play: async ({ args, canvas, userEvent }) => {
    const button = canvas.getByRole('button', { name: 'Deny this time' });
    expectComputed(button, { backgroundColor: DANGER_FILL, color: DANGER_TEXT, fontWeight: '420', height: '40px', opacity: '1' });
    await userEvent.click(button);
    await expect(args.onClick).toHaveBeenCalledTimes(1);
  },
};

export const DangerGhost: Story = {
  args: { variant: 'danger-ghost', size: 'main', children: 'Deny always' },
  parameters: { canvasNote: ANSWERS_NOTE },
  play: async ({ canvas }) => {
    expectComputed(canvas.getByRole('button', { name: 'Deny always' }), {
      backgroundColor: 'rgba(0, 0, 0, 0)',
      color: DANGER_TEXT,
      fontWeight: '420',
      height: '40px',
    });
  },
};

export const DangerBusy: Story = {
  args: { variant: 'danger', size: 'main', busy: true, children: 'Deny this time' },
  parameters: {
    canvasNote: `${ANSWERS_NOTE} No board shows it mid-request; it fades to 80%, less than the neutral buttons, so its red words still read at 4.5:1.`,
  },
  play: async ({ args, canvas, userEvent }) => {
    const button = canvas.getByRole('button', { name: 'Deny this time' });
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    expectComputed(button, { backgroundColor: DANGER_FILL, color: DANGER_TEXT, opacity: '0.8' });
    await userEvent.click(button);
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

export const DangerDisabled: Story = {
  args: { variant: 'danger', size: 'main', disabled: true, children: 'Deny this time' },
  parameters: { canvasNote: `${ANSWERS_NOTE} No board shows it disabled; it dims like every disabled button and keeps its fill.` },
  play: async ({ args, canvas, userEvent }) => {
    const button = canvas.getByRole('button', { name: 'Deny this time' });
    await expect(button).toBeDisabled();
    expectComputed(button, { backgroundColor: DANGER_FILL, opacity: '0.4' });
    await userEvent.click(button);
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

const MENU_NOTE =
  'N-Answers-TwoButtons, option 2: a side of a held request with two answers is a menu button, its words and then a chevron. The card owns the menu.';

export const OpensAMenu: Story = {
  args: { variant: 'danger', size: 'main', menuOpen: false, id: 'deny-answers', onKeyDown: fn(), children: 'Deny' },
  parameters: { canvasNote: MENU_NOTE },
  play: async ({ args, canvas, userEvent }) => {
    // Named by its words alone; it says it opens a menu, and that the menu is closed.
    const button = canvas.getByRole('button', { name: 'Deny' });
    await expect(button).toHaveAttribute('id', 'deny-answers');
    await expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await expect(button).toHaveAttribute('aria-expanded', 'false');

    // The chevron follows the words: a 16 px line icon, hidden from assistive tech, in the words' color.
    const chevron = button.lastElementChild;
    if (!(chevron instanceof SVGElement)) throw new Error('no chevron after the words');
    await expect(chevron).toHaveAttribute('aria-hidden', 'true');
    await expect(chevron).toHaveAttribute('width', '16');
    expectComputed(chevron, { color: DANGER_TEXT });
    // The chevron's own margin sits inside the icon, so the button's right edge is a little tighter.
    expectComputed(button, { backgroundColor: DANGER_FILL, color: DANGER_TEXT, height: '40px', paddingLeft: '14px', paddingRight: '10px' });

    // It is still a button: a click and its keys reach the screen.
    await userEvent.click(button);
    await expect(args.onClick).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{ArrowDown}');
    await expect(args.onKeyDown).toHaveBeenCalled();
  },
};

export const MenuOpen: Story = {
  args: { variant: 'secondary', size: 'main', menuOpen: true, children: 'Allow' },
  parameters: { canvasNote: `${MENU_NOTE} Here its menu is open; the card draws the menu under it.` },
  play: async ({ canvas }) => {
    const button = canvas.getByRole('button', { name: 'Allow' });
    await expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await expect(button).toHaveAttribute('aria-expanded', 'true');
  },
};
