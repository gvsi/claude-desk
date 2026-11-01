import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { Button } from './Button.tsx';

/** The signed-off deny answers: the refused rose at 16% behind #eba3ae words. */
const DANGER_FILL = 'rgba(220, 130, 144, 0.16)';
const DANGER_TEXT = 'rgb(235, 163, 174)';
const ANSWERS_NOTE =
  "The signed-off answer board (N-Answers-TwoButtons, option 2) replaces this board's four secondary answers: Deny is the soft red danger button. Danger-ghost is the same refusal's quieter look, red words with no fill.";

const meta = {
  title: 'Actions/Button',
  component: Button,
  args: { variant: 'secondary', children: 'Allow this time', onClick: fn() },
  parameters: { layout: 'padded', canvas: 'N-Today-Run1' },
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
    // busy_colors_keep_contrast: a busy button is drawn in token colors, never dimmed as a whole, so
    // its spinner, in its label's color, is a listed contrast pair: button-primary-text on
    // button-primary-hover, 12.2:1.
    expectComputed(button, { opacity: '1', backgroundColor: 'rgb(221, 217, 207)', color: 'rgb(28, 27, 25)' });
  },
};

export const BusySecondary: Story = {
  args: { busy: true, children: 'Keep it' },
  parameters: {
    canvasNote:
      "The board shows no button mid-request; this is a secondary button on a dialog's raised surface while its own request is in flight.",
  },
  decorators: [
    (Story) => (
      <div style={{ background: 'var(--bg-surface)', padding: 'var(--space-20)' }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas }) => {
    const button = canvas.getByRole('button', { name: 'Keep it' });
    await expect(button).toHaveAttribute('aria-busy', 'true');
    // The label's color steps down to text-secondary on the button's own fill, and the spinner takes it:
    // 5.3:1 on bg-surface, where dimming the whole button left it at 4.48:1.
    expectComputed(button, { opacity: '1', backgroundColor: 'rgba(250, 249, 245, 0.1)', color: 'rgba(250, 249, 245, 0.64)' });
  },
};

export const BusyGhost: Story = {
  args: { variant: 'ghost', busy: true, children: 'Start over' },
  parameters: { canvasNote: 'The board shows no button mid-request; this is a ghost button while its request is in flight.' },
  play: async ({ canvas }) => {
    const button = canvas.getByRole('button', { name: 'Start over' });
    expectComputed(button, { opacity: '1', backgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgba(250, 249, 245, 0.64)' });
  },
};

/** Each variant's busy colors: what it steps to while its request is in flight. */
const BUSY_LOOKS = [
  { variant: 'primary', children: 'Send counter-offer', backgroundColor: 'rgb(221, 217, 207)', color: 'rgb(28, 27, 25)' },
  { variant: 'secondary', children: 'Keep it', backgroundColor: 'rgba(250, 249, 245, 0.1)', color: 'rgba(250, 249, 245, 0.64)' },
  { variant: 'ghost', children: 'Start over', backgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgba(250, 249, 245, 0.64)' },
  { variant: 'danger', children: 'Deny this time', backgroundColor: 'rgba(220, 130, 144, 0.24)', color: DANGER_TEXT },
  { variant: 'danger-ghost', children: 'Deny always', backgroundColor: 'rgba(250, 249, 245, 0.06)', color: DANGER_TEXT },
] as const;

export const BusyAndDisabled: Story = {
  render: (args) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}>
      {BUSY_LOOKS.map(({ variant, children }) => (
        <Button key={variant} variant={variant} busy disabled onClick={args.onClick}>
          {children}
        </Button>
      ))}
    </div>
  ),
  parameters: {
    canvasNote:
      'The board shows no button that is busy and disabled at once; busy wins, so each variant keeps its busy colors at full opacity instead of dimming to 40%.',
  },
  play: async ({ args, canvas, userEvent }) => {
    for (const { children, backgroundColor, color } of BUSY_LOOKS) {
      const button = canvas.getByRole('button', { name: children });
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute('aria-busy', 'true');
      // busy_colors_keep_contrast: disabled as well doesn't dim it below its busy pair.
      expectComputed(button, { opacity: '1', backgroundColor, color });
      await userEvent.click(button);
    }
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

/**
 * busy_shows_spinner: a busy button's spinner where its label was: a 16 px ring, a faint track with
 * a quarter arc drawn 2 px wide in its busy label color. The label keeps its place in the layout,
 * unseen, and still names the button; the spinner is hidden from screen readers.
 */
async function expectBusySpinner(button: HTMLElement, name: string): Promise<SVGElement> {
  await expect(button).toHaveAccessibleName(name);
  await expect(button).toHaveAttribute('aria-busy', 'true');
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  const label = button.querySelector<HTMLElement>('.cd-button__label');
  if (!label) throw new Error('no label in the busy button');
  expectComputed(label, { opacity: '0' });
  await expect(label.getBoundingClientRect().width).toBeGreaterThan(0);
  const spinners = button.querySelectorAll<SVGElement>('svg.cd-button__spinner');
  await expect(spinners).toHaveLength(1);
  const spinner = spinners[0] as SVGElement;
  await expect(spinner).toHaveAttribute('aria-hidden', 'true');
  await expect(spinner.textContent).toBe('');
  // In the button's busy label color: the arc at full strength, the track behind it faint.
  const { color } = getComputedStyle(button);
  expectComputed(spinner, { width: '16px', height: '16px', color });
  const track = spinner.querySelector('circle');
  const arc = spinner.querySelector('path');
  if (!track || !arc) throw new Error('the spinner has no track or arc');
  for (const part of [track, arc]) {
    await expect(part).toHaveAttribute('stroke', 'currentColor');
    await expect(part).toHaveAttribute('stroke-width', '2');
  }
  await expect(track).toHaveAttribute('stroke-opacity', '0.3');
  await expect(arc).not.toHaveAttribute('stroke-opacity');
  await expect(arc).toHaveAttribute('stroke-linecap', 'round');
  // Centered in the button, where the label was.
  const box = button.getBoundingClientRect();
  const ring = spinner.getBoundingClientRect();
  await expect(Math.abs((ring.left + ring.right) / 2 - (box.left + box.right) / 2)).toBeLessThan(1);
  await expect(Math.abs((ring.top + ring.bottom) / 2 - (box.top + box.bottom) / 2)).toBeLessThan(1);
  return spinner;
}

/** The spinner turns at an even speed, a whole turn every motion-spin, without end. */
function expectSpins(spinner: SVGElement): void {
  expectComputed(spinner, {
    animationName: /^(?!none$).+/,
    animationDuration: '0.8s',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'linear',
  });
}

export const BusySpinner: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'max-content max-content', gap: 'var(--space-8)', justifyItems: 'start' }}>
      {BUSY_LOOKS.flatMap(({ variant, children }) => [
        <Button key={`${variant}-rest`} variant={variant} size="main">
          {children}
        </Button>,
        <Button key={`${variant}-busy`} variant={variant} size="main" busy>
          {children}
        </Button>,
      ])}
    </div>
  ),
  parameters: {
    canvasNote:
      "The owner's busy-button decision after the N-Typing-Owner-Busy board: each variant at rest, then busy, with a small spinner in its busy colors in place of its label, at the same width.",
  },
  play: async ({ canvas }) => {
    for (const { children, backgroundColor, color } of BUSY_LOOKS) {
      const [rest, busy] = canvas.getAllByRole('button', { name: children }) as [HTMLElement, HTMLElement];
      await expect(rest).not.toHaveAttribute('aria-busy');
      // The same size as at rest, so nothing around it moves.
      const [before, after] = [rest.getBoundingClientRect(), busy.getBoundingClientRect()];
      await expect(Math.abs(after.width - before.width)).toBeLessThan(0.5);
      await expect(after.height).toBe(before.height);
      expectComputed(busy, { opacity: '1', backgroundColor, color });
      expectSpins(await expectBusySpinner(busy, children));
      await expect(rest.querySelector('.cd-button__spinner')).toBeNull();
    }
  },
};

export const BusyMenuButton: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 'var(--space-8)' }}>
      <Button variant="secondary" size="main" menuOpen={false}>
        Allow
      </Button>
      <Button variant="secondary" size="main" menuOpen={false} busy>
        Allow
      </Button>
    </div>
  ),
  parameters: {
    canvasNote:
      "The owner's busy-button decision after the N-Typing-Owner-Busy board: a busy menu button shows the spinner in place of its words and its chevron, at the same width, and can't open.",
  },
  play: async ({ canvas }) => {
    const [rest, busy] = canvas.getAllByRole('button', { name: 'Allow' }) as [HTMLElement, HTMLElement];
    await expect(Math.abs(busy.getBoundingClientRect().width - rest.getBoundingClientRect().width)).toBeLessThan(0.5);
    await expect(busy).toHaveAttribute('aria-haspopup', 'menu');
    await expect(busy).toHaveAttribute('aria-expanded', 'false');
    await expectBusySpinner(busy, 'Allow');
    // The chevron keeps its place, unseen.
    const chevron = busy.querySelector<SVGElement>('.cd-button__chevron');
    if (!chevron) throw new Error('no chevron in the busy menu button');
    expectComputed(chevron, { visibility: 'hidden' });
    expectComputed(rest.querySelector('.cd-button__chevron') as SVGElement, { visibility: 'visible' });
  },
};

export const BusyReducedMotion: Story = {
  args: { busy: true },
  parameters: {
    canvasNote:
      "The owner's busy-button decision after the N-Typing-Owner-Busy board: under reduced motion the spinner is a still arc. Storybook shows the motion your system asks for; the design system's browser tests render this story under reduced motion.",
  },
  play: async ({ canvas }) => {
    const button = canvas.getByRole('button', { name: 'Allow this time' });
    const spinner = await expectBusySpinner(button, 'Allow this time');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // busy_spinner_still_under_reduced_motion: no turning, the arc stays where it is.
      expectComputed(spinner, { animationName: 'none' });
    } else {
      expectSpins(spinner);
    }
  },
};

export const WaitingForAnother: Story = {
  render: (args) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}>
      {BUSY_LOOKS.map(({ variant, children }) => (
        <Button key={variant} variant={variant} waiting onClick={args.onClick}>
          {children}
        </Button>
      ))}
    </div>
  ),
  parameters: {
    canvasNote:
      "The owner's busy-button decision after the N-Typing-Owner-Busy board: while a held request's chosen answer is sent, the other answer steps to its busy colors without a spinner and can't be pressed; here every variant does.",
  },
  play: async ({ args, canvas, userEvent }) => {
    for (const { children, backgroundColor, color } of BUSY_LOOKS) {
      const button = canvas.getByRole('button', { name: children });
      // waiting_steps_without_spinner: the busy colors, its words still shown, no spinner and no aria-busy,
      // since its own request isn't the one in flight; it can't be pressed.
      expectComputed(button, { opacity: '1', backgroundColor, color });
      expectComputed(button.querySelector('.cd-button__label') as HTMLElement, { opacity: '1' });
      await expect(button.querySelector('.cd-button__spinner')).toBeNull();
      await expect(button).not.toHaveAttribute('aria-busy');
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(button).toBeEnabled();
      await userEvent.click(button);
    }
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

/** A phone's line: 390 px less the 16 px gutter on each side. */
const PHONE_LINE = 358;

/** A label whose name has no break opportunity and is wider than a 220 px column on its own. */
const UNBROKEN_LABEL = 'Pedir hablar con MaximilianAlexanderMontgomerySmith';

/** The text's line boxes inside a button, from the browser's layout. */
function lineBoxes(button: HTMLElement): DOMRect[] {
  const range = document.createRange();
  range.selectNodeContents(button);
  return [...range.getClientRects()].filter((box) => box.width > 0);
}

export const LongLabel: Story = {
  args: { children: 'Pedir hablar con María Guadalupe Fernández de la Torre' },
  render: (args) => (
    <div style={{ display: 'grid', rowGap: 'var(--space-24)' }}>
      {/* The public page's ask button on a phone, with a long owner's name. */}
      <div data-testid="narrow" style={{ width: PHONE_LINE, maxWidth: '100%' }}>
        <Button {...args} />
      </div>
      {/* The take-over bar's controls column: full-width main buttons, one above the other. */}
      <div data-testid="narrow" style={{ display: 'flex', flexDirection: 'column', width: 'var(--size-margin)' }}>
        <Button {...args} size="main" />
      </div>
      {/* A name with no spaces, wider than the take-over bar's 220 px controls column, in its
          wrapping row of buttons: the name itself breaks inside the button. */}
      <div data-testid="narrow" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)', width: 'var(--size-margin)' }}>
        <Button {...args} size="main">
          {UNBROKEN_LABEL}
        </Button>
      </div>
      {/* A short label keeps the control heights. */}
      <div data-testid="short" style={{ display: 'flex', gap: 'var(--space-8)', alignItems: 'flex-start' }}>
        <Button variant="secondary">Keep it</Button>
        <Button variant="primary" size="main">
          Join the chat
        </Button>
      </div>
    </div>
  ),
  parameters: {
    canvas: 'none',
    canvasNote:
      "No board shows a label wider than its line; on a phone, or in the take-over bar's controls column, a long label wraps inside the button instead of running past it, and a name with no spaces breaks inside it.",
  },
  play: async ({ canvas }) => {
    for (const container of canvas.getAllByTestId('narrow')) {
      const button = container.querySelector<HTMLElement>('.cd-button');
      if (!button) throw new Error('no button in the narrow container');
      const box = button.getBoundingClientRect();
      const edge = container.getBoundingClientRect();
      // long_label_wraps_inside_the_button: nothing runs past the button or its line.
      await expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth);
      await expect(box.left).toBeGreaterThanOrEqual(edge.left - 0.5);
      await expect(box.right).toBeLessThanOrEqual(edge.right + 0.5);
      // The label takes more than one line, and every line keeps the button's side padding.
      const lines = lineBoxes(button);
      await expect(new Set(lines.map((line) => Math.round(line.top))).size).toBeGreaterThan(1);
      const padding = Number.parseFloat(getComputedStyle(button).paddingLeft);
      await expect(padding).toBeGreaterThanOrEqual(12);
      for (const line of lines) {
        await expect(line.left).toBeGreaterThanOrEqual(box.left + padding - 0.5);
        await expect(line.right).toBeLessThanOrEqual(box.right - padding + 0.5);
        await expect(line.top).toBeGreaterThanOrEqual(box.top);
        await expect(line.bottom).toBeLessThanOrEqual(box.bottom);
      }
    }
    // One line of label is still exactly a control's height: 32 px inline, 40 px main.
    expectComputed(canvas.getByRole('button', { name: 'Keep it' }), { height: '32px' });
    expectComputed(canvas.getByRole('button', { name: 'Join the chat' }), { height: '40px' });
  },
};

export const LabelWithAName: Story = {
  args: {
    children: (
      <>
        Allow only for{' '}
        <span className="cd-user-name" data-copy="user">
          Dana Whitfield
        </span>
        , always
      </>
    ),
  },
  parameters: {
    canvasNote:
      "The board shows no label around a person's name; a held request's card shows one when Allow offers only Allow only for Dana, always, her name set off as her own words.",
  },
  play: async ({ canvas }) => {
    // The words and the name are one run of text: no gap opens around the name, and the comma
    // follows it straight on.
    const button = canvas.getByRole('button', { name: 'Allow only for Dana Whitfield, always' });
    const name = canvas.getByText('Dana Whitfield');
    const comma = document.createRange();
    const after = name.nextSibling;
    if (!after) throw new Error('no words after the name');
    comma.setStart(after, 0);
    comma.setEnd(after, 1);
    await expect(Math.abs(comma.getBoundingClientRect().left - name.getBoundingClientRect().right)).toBeLessThan(1);
    expectComputed(button, { height: '32px' });
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
    // It opens in place.
    await expect(links[0]).not.toHaveAttribute('target');
    await expect(canvas.queryByRole('button')).toBeNull();
  },
};

export const OpensInANewTab: Story = {
  args: { href: '/d/turner-plumbing-k3x9q2', external: true, children: 'Open your public page' },
  parameters: {
    canvasNote:
      "Today's \"Open your public page\" and \"Chat as a customer\" open the Desk's public page in a new tab, so Today stays where it was; they look like any secondary button.",
  },
  play: async ({ canvas }) => {
    const link = canvas.getByRole('link', { name: 'Open your public page' });
    await expect(link).toHaveAttribute('href', '/d/turner-plumbing-k3x9q2');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // Nothing about its look changes: it is the secondary button.
    expectComputed(link, { backgroundColor: 'rgba(250, 249, 245, 0.1)', color: 'rgba(250, 249, 245, 0.92)', height: '32px' });
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
    canvasNote: `${ANSWERS_NOTE} No board shows it mid-request; it takes its hover fill and keeps its red words, never dimmed, so they still read at 4.5:1.`,
  },
  play: async ({ args, canvas, userEvent }) => {
    const button = canvas.getByRole('button', { name: 'Deny this time' });
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    expectComputed(button, { backgroundColor: 'rgba(220, 130, 144, 0.24)', color: DANGER_TEXT, opacity: '1' });
    await userEvent.click(button);
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

export const DangerGhostBusy: Story = {
  args: { variant: 'danger-ghost', size: 'main', busy: true, children: 'Deny always' },
  parameters: {
    canvasNote: `${ANSWERS_NOTE} No board shows it mid-request; it takes the hover ground under its red words, never dimmed, so they still read at 4.5:1.`,
  },
  play: async ({ args, canvas, userEvent }) => {
    const button = canvas.getByRole('button', { name: 'Deny always' });
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    // busy_colors_keep_contrast: its red color on the hover ground is a listed pair.
    expectComputed(button, { backgroundColor: 'rgba(250, 249, 245, 0.06)', color: DANGER_TEXT, opacity: '1' });
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
    // While its menu is open it keeps its hover fill, so the menu reads as its own.
    expectComputed(button, { backgroundColor: 'rgba(250, 249, 245, 0.15)' });
  },
};
