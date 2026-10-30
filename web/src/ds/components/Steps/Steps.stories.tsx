import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import { Steps } from './Steps.tsx';

const meta = {
  title: 'Navigation/Steps',
  component: Steps,
  args: {
    label: 'Connect Google Calendar',
    steps: ['Choose', 'Sign in', 'Review tools', 'Confirm'],
    current: 2,
  },
  parameters: { layout: 'padded', canvas: 'N-Conn-09-GCal-Review' },
} satisfies Meta<typeof Steps>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ReviewToolsOfFour: Story = {
  play: async ({ canvas, canvasElement }) => {
    // list_semantics_kept: a list drawn without markers says role="list", so Safari keeps it a list.
    await expect(expectListsKeepTheirRole(canvasElement)).toBeGreaterThanOrEqual(1);
    // current_step_marked: an ordered list named by its label, one item per step.
    const list = canvas.getByRole('list', { name: 'Connect Google Calendar' });
    await expect(list.tagName).toBe('OL');
    const items = within(list).getAllByRole('listitem');
    await expect(items).toHaveLength(4);
    // Done steps read "{name}, done" and show a check; the current one has aria-current="step".
    await expect(items[0]).toHaveTextContent('Choose, done');
    await expect(items[1]).toHaveTextContent('Sign in, done');
    await expect(items[0]?.querySelector('svg')).not.toBeNull();
    await expect(items[2]).toHaveAttribute('aria-current', 'step');
    await expect(items[2]).toHaveTextContent('Review tools');
    await expect(items[2]).not.toHaveTextContent('done');
    for (const index of [0, 1, 3]) await expect(items[index]).not.toHaveAttribute('aria-current');
    // The circles are drawn only: 22 px, the current one filled with its number.
    const circle = items[2]?.querySelector('.cd-steps__circle');
    if (!circle) throw new Error('No circle on the current step');
    await expect(circle).toHaveAttribute('aria-hidden', 'true');
    await expect(circle).toHaveTextContent('3');
    expectComputed(circle, { width: '22px', height: '22px', backgroundColor: 'rgb(239, 236, 228)', color: 'rgb(28, 27, 25)' });
    // A later step is a quiet numbered circle.
    const later = items[3]?.querySelector('.cd-steps__circle');
    if (!later) throw new Error('No circle on the last step');
    await expect(later).toHaveTextContent('4');
    expectComputed(later, { backgroundColor: 'rgba(250, 249, 245, 0.1)', color: 'rgba(250, 249, 245, 0.64)' });
    // The current name in primary text, the others in secondary.
    expectComputed(within(items[2] as HTMLElement).getByText('Review tools'), { color: 'rgba(250, 249, 245, 0.92)' });
    expectComputed(within(items[3] as HTMLElement).getByText('Confirm'), { color: 'rgba(250, 249, 245, 0.64)' });
    // Joined by hairlines.
    const joins = list.querySelectorAll('.cd-steps__join');
    await expect(joins).toHaveLength(3);
    expectComputed(joins[0] as Element, { height: '1px', backgroundColor: 'rgba(250, 249, 245, 0.12)' });
  },
};

export const SetupThirdOfFive: Story = {
  args: { label: 'Set up your Desk', steps: ['Questions', 'Tools', 'Rules', 'Safety check', 'Live'], current: 2 },
  parameters: {
    canvas: 'none',
    canvasNote: "Setup's five steps; no setup board is in the reference set, so it follows the add-a-connector steps on N-Conn-09-GCal-Review.",
  },
  play: async ({ canvas }) => {
    const items = within(canvas.getByRole('list', { name: 'Set up your Desk' })).getAllByRole('listitem');
    await expect(items).toHaveLength(5);
    await expect(items[0]).toHaveTextContent('Questions, done');
    await expect(items[1]).toHaveTextContent('Tools, done');
    await expect(items[2]).toHaveAttribute('aria-current', 'step');
    await expect(items[2]).toHaveTextContent('Rules');
    await expect(items[4]).toHaveTextContent('Live');
    await expect(items[4]).not.toHaveTextContent('done');
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    canvas: 'none',
    canvasNote: 'No board draws the steps on a phone (nearest: N-Conn-09-GCal-Review). Under 480 px only the current step keeps its name on screen; screen readers still hear every name.',
  },
  play: async ({ canvas, canvasElement }) => {
    const width = window.innerWidth;
    await expect(width).toBe(390);
    const items = within(canvas.getByRole('list', { name: 'Connect Google Calendar' })).getAllByRole('listitem');
    // Every name is still read.
    await expect(items[0]).toHaveTextContent('Choose, done');
    await expect(items[3]).toHaveTextContent('Confirm');
    // The current step's name shows; the others' names are read but not drawn, so the row fits.
    await expect(within(items[2] as HTMLElement).getByText('Review tools')).toBeVisible();
    expectComputed(within(items[3] as HTMLElement).getByText('Confirm'), { position: 'absolute', width: '1px' });
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width);
    await expect(tooWide).toEqual([]);
  },
};
