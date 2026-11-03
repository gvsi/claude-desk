import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { VISION_INERT_LINE } from '../VisionBar/visionInert.tsx';
import { SuggestionChips } from './SuggestionChips.tsx';

const TODAY = ['Why was the 50% request held?', 'Raise my cash discount limit to 15%', 'What happened overnight?'];

const meta = {
  title: 'Controls/SuggestionChips',
  component: SuggestionChips,
  args: { label: 'Suggestions', suggestions: TODAY, onPick: fn() },
  parameters: { layout: 'padded', canvas: 'N-Today-Run1' },
} satisfies Meta<typeof SuggestionChips>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Today: Story = {
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const group = canvas.getByRole('group', { name: 'Suggestions' });
    const chips = canvas.getAllByRole('button');
    await expect(chips.map((chip) => chip.textContent)).toEqual(TODAY);
    for (const chip of chips) await expect(group).toContainElement(chip);
    // Suggestions have no state, and a long one wraps inside a narrow line instead of overflowing it.
    await expect(chips[0]).not.toHaveAttribute('aria-pressed');
    expectComputed(chips[0] as HTMLElement, { height: '28px', whiteSpace: 'normal', maxWidth: '100%' });
    expectComputed(group, { columnGap: '8px', rowGap: '8px', flexWrap: 'wrap' });

    // A pick hands its words to the screen, once.
    await userEvent.click(canvas.getByRole('button', { name: 'Raise my cash discount limit to 15%' }));
    await expect(args.onPick).toHaveBeenCalledTimes(1);
    await expect(args.onPick).toHaveBeenCalledWith('Raise my cash discount limit to 15%');
    // Real suggestions have no vision line, before or after a pick.
    await expect(canvasElement.querySelector('.cd-vision-inert-line')).toBeNull();
  },
};

/** Setup's four starters wrap two and two in the phone's content column. */
export const SetupStarters: Story = {
  args: {
    label: 'Examples',
    suggestions: ['A hair salon in Oakland', 'A plumber in Oakland', 'Apartments in Sacramento', 'A CPA firm in San Jose'],
    max: 4,
  },
  render: (args) => (
    <div style={{ maxWidth: 358 }}>
      <SuggestionChips {...args} />
    </div>
  ),
  parameters: {
    canvas: 'none',
    canvasNote: 'Setup’s four starters replace the three examples on the nearest board, UXC-P602-After; this story checks their phone wrapping.',
  },
  play: async ({ args, canvas, userEvent }) => {
    const chips = canvas.getAllByRole('button');
    await expect(chips.map((chip) => chip.textContent)).toEqual(args.suggestions);
    const boxes = chips.map((chip) => chip.getBoundingClientRect());
    await expect(boxes[0]?.top).toBe(boxes[1]?.top);
    await expect(boxes[2]?.top).toBe(boxes[3]?.top);
    await expect(boxes[2]?.top).toBeGreaterThan(boxes[0]?.top ?? 0);
    await userEvent.click(chips[3] as HTMLElement);
    await expect(args.onPick).toHaveBeenCalledWith('A CPA firm in San Jose');
  },
};

/** On a vision page, which makes no requests: the chips look and focus as ever, and a pick does nothing. */
export const InertSuggestions: Story = {
  args: { label: 'Try asking', suggestions: ['Book an inspection', 'Pay the fee', 'Talk to staff'], inertSuggestions: true },
  parameters: {
    canvas: 'N-R2-Vision-CityOffice-Resident',
    canvasNote: 'The suggestions under the city office vision page’s conversation: they keep their look and tab order, and picking one sends nothing.',
  },
  play: async ({ args, canvas, userEvent }) => {
    // inert_suggestions_send_nothing: a click and a key press each leave the chips as they were.
    const group = canvas.getByRole('group', { name: 'Try asking' });
    const chips = canvas.getAllByRole('button');
    await expect(chips.map((chip) => chip.textContent)).toEqual(['Book an inspection', 'Pay the fee', 'Talk to staff']);
    expectComputed(chips[0] as HTMLElement, { height: '28px', whiteSpace: 'normal', maxWidth: '100%' });
    // A polite live region waits under the chips, empty and taking no room until the first press.
    const status = canvas.getByRole('status');
    await expect(status).toHaveTextContent(/^$/);
    await expect(status.getBoundingClientRect().height).toBeLessThanOrEqual(1);
    await expect(group).not.toContainElement(status);
    await userEvent.click(chips[1] as HTMLElement);
    await expect(chips[1]).toHaveFocus();
    await expect(args.onPick).not.toHaveBeenCalled();
    // vision_inert_line_on_first_press: the first press fills it with the one line, in a secondary
    // caption 8 px under the chips.
    await expect(status).toHaveTextContent(VISION_INERT_LINE);
    expectComputed(status, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(Math.round(status.getBoundingClientRect().top - group.getBoundingClientRect().bottom)).toBe(8);
    // Tab goes on to the next chip, as ever, and Enter on it sends nothing either.
    await userEvent.tab();
    await expect(chips[2]).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onPick).not.toHaveBeenCalled();
    // A second press changes nothing: still the one line, in the one region.
    await expect(canvas.getAllByRole('status')).toEqual([status]);
    await expect(canvas.getAllByText(VISION_INERT_LINE)).toHaveLength(1);
  },
};

/** Off while what a pick would change can't change, as setup's examples are while a start is being settled. */
export const Disabled: Story = {
  args: { label: 'Examples', suggestions: ['A plumber in Oakland', 'A bakery that takes custom orders', 'A tax preparer'], disabled: true },
  parameters: {
    canvas: 'none',
    canvasNote:
      'No board draws the chips off. Setup’s start step turns its examples off while a start is being settled; they stay in place, dimmed as a disabled button is.',
  },
  play: async ({ args, canvas, userEvent }) => {
    const chips = canvas.getAllByRole('button');
    await expect(chips.map((chip) => chip.textContent)).toEqual(['A plumber in Oakland', 'A bakery that takes custom orders', 'A tax preparer']);
    for (const chip of chips) await expect(chip).toBeDisabled();
    // Dimmed well down, in place at their 28 px, and a hover changes nothing.
    expectComputed(chips[0] as HTMLElement, { opacity: '0.4', cursor: 'default', height: '28px' });
    await userEvent.hover(chips[0] as HTMLElement);
    expectComputed(chips[0] as HTMLElement, { backgroundColor: 'rgba(0, 0, 0, 0)' });
    // A press does nothing.
    await userEvent.click(chips[0] as HTMLElement);
    await expect(args.onPick).not.toHaveBeenCalled();
  },
};
