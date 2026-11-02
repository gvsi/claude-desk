import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { expectDrawsShortArmFirst } from '../../test/expectDrawsShortArmFirst.ts';
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

/** Drawn on N-R2-Setup-16-Phone-Questions, signed on 2026-10-30 and not yet in the reference set. */
const PHONE_NOTE =
  'Drawn on N-R2-Setup-16-Phone-Questions, signed on 2026-10-30. Under 480 px the steps are one line, "Step 1 of 5: Questions", and screen readers still hear the list.';

/** The line drawn in place of the circles under 480 px; screen readers hear the list instead. */
function compactLine(root: HTMLElement): HTMLElement {
  const line = root.querySelector<HTMLElement>('.cd-steps__compact');
  if (!line) throw new Error('No compact line');
  return line;
}

/** At 390 px: the list is read but not drawn, and nothing scrolls sideways. */
async function expectPhoneSteps(canvasElement: HTMLElement, label: string): Promise<HTMLElement[]> {
  const width = window.innerWidth;
  await expect(width).toBe(390);
  const list = within(canvasElement).getByRole('list', { name: label });
  expectComputed(list, { position: 'absolute', width: '1px' });
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width);
  await expect(tooWide).toEqual([]);
  return within(list).getAllByRole('listitem');
}

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'none', canvasNote: PHONE_NOTE },
  play: async ({ canvasElement }) => {
    const items = await expectPhoneSteps(canvasElement, 'Connect Google Calendar');
    // Every name is still read, the current step marked.
    await expect(items[0]).toHaveTextContent('Choose, done');
    await expect(items[2]).toHaveAttribute('aria-current', 'step');
    await expect(items[3]).toHaveTextContent('Confirm');
    // phone_steps_one_line: the steps are drawn as one line, its count in secondary ink and the
    // current step's name in primary, hidden from screen readers, which hear the list.
    const line = compactLine(canvasElement);
    await expect(line.textContent).toBe('Step 3 of 4: Review tools');
    await expect(line).toHaveAttribute('aria-hidden', 'true');
    await expect(line).toBeVisible();
    expectComputed(line, { color: 'rgba(250, 249, 245, 0.64)', fontSize: '14px', lineHeight: '19px' });
    expectComputed(line.querySelector('.cd-steps__compact-name') as HTMLElement, { color: 'rgba(250, 249, 245, 0.92)' });
  },
};

export const SetupPhone: Story = {
  args: { label: 'Set up your Desk', steps: ['Questions', 'Tools', 'Rules', 'Safety check', 'Live'], current: 0 },
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'none', canvasNote: PHONE_NOTE },
  play: async ({ canvasElement }) => {
    const items = await expectPhoneSteps(canvasElement, 'Set up your Desk');
    await expect(items[0]).toHaveAttribute('aria-current', 'step');
    await expect(compactLine(canvasElement).textContent).toBe('Step 1 of 5: Questions');
  },
};

export const Unknown: Story = {
  args: { current: null },
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'none', canvasNote: 'While the step is read, none is marked and the phone line keeps its place without naming a step.' },
  play: async ({ canvasElement }) => {
    await expectPhoneSteps(canvasElement, 'Connect Google Calendar');
    await expect(canvasElement.querySelector('[aria-current]')).toBeNull();
    // toBeVisible does not account for clipping: every list name is inside this fully clipped box.
    expectComputed(within(canvasElement).getByRole('list', { name: 'Connect Google Calendar' }), {
      height: '1px', overflow: 'hidden', clipPath: 'inset(50%)',
    });
    const line = compactLine(canvasElement);
    await expect(line).toBeVisible();
    await expect(line).toHaveAttribute('aria-hidden', 'true');
    await expect(line.textContent?.trim()).toBe('');
    await expect(line.getBoundingClientRect().height).toBe(19);
  },
};

export const LaptopHasNoLine: Story = {
  args: { label: 'Set up your Desk', steps: ['Questions', 'Tools', 'Rules', 'Safety check', 'Live'], current: 2 },
  parameters: { canvas: 'none', canvasNote: PHONE_NOTE },
  play: async ({ canvas, canvasElement }) => {
    // At 480 px of its own width and over, the steps are the row of circles, and the line isn't drawn.
    await expect(canvas.getByRole('list', { name: 'Set up your Desk' })).toBeVisible();
    await expect(compactLine(canvasElement)).not.toBeVisible();
  },
};

/** Setup's going-live board, signed on 2026-10-30 as an addition to N-R2-Setup-14-Live. */
const FINISHED_NOTE =
  "Drawn on setup's going-live board, signed on 2026-10-30 as an addition to N-R2-Setup-14-Live and not yet in the reference set: once the Desk is live, step 5's number gives way to a check, so all five steps read done.";

const SETUP_STEPS = ['Questions', 'Tools', 'Rules', 'Safety check', 'Live'];

/** The last step of a finished setup: done and current, its check on the current step's fill. */
async function expectFinishedLast(canvasElement: HTMLElement): Promise<SVGPathElement> {
  const items = within(within(canvasElement).getByRole('list', { name: 'Set up your Desk' })).getAllByRole('listitem');
  await expect(items).toHaveLength(5);
  for (const item of items) await expect(item.textContent).toMatch(/, done$/);
  const last = items[4] as HTMLElement;
  await expect(last).toHaveTextContent('Live, done');
  await expect(last).toHaveAttribute('aria-current', 'step');
  const circle = last.querySelector('.cd-steps__circle');
  if (!circle) throw new Error('No circle on the last step');
  await expect(circle.textContent).toBe('');
  expectComputed(circle, { width: '22px', height: '22px', backgroundColor: 'rgb(239, 236, 228)', color: 'rgb(28, 27, 25)' });
  expectComputed(within(last).getByText('Live'), { color: 'rgba(250, 249, 245, 0.92)' });
  const path = circle.querySelector<SVGPathElement>('svg path');
  if (!path) throw new Error('No check on the last step');
  return path;
}

export const SetupFinished: Story = {
  args: { label: 'Set up your Desk', steps: SETUP_STEPS, current: 4, finished: true },
  parameters: { canvas: 'none', canvasNote: `${FINISHED_NOTE} Opened on a live Desk, the check is drawn from the start.` },
  play: async ({ canvasElement }) => {
    // finished_check_drawn: nothing draws when the page opens on a finished flow.
    const path = await expectFinishedLast(canvasElement);
    expectComputed(path, { animationName: 'none', strokeDashoffset: '0px' });
  },
};

export const SetupFinishedDrawsCheck: Story = {
  args: { label: 'Set up your Desk', steps: SETUP_STEPS, current: 4, finished: true, drawCheck: true },
  parameters: {
    canvas: 'none',
    canvasNote: `${FINISHED_NOTE} Reached live, the check draws once. Under reduced motion it doesn't move: it is drawn from the start, with no animation and its stroke whole. Storybook shows the motion your system asks for, and the design system's browser tests render this story under reduced motion.`,
  },
  play: async ({ canvasElement }) => {
    const path = await expectFinishedLast(canvasElement);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // finished_check_still_under_reduced_motion: no draw, the check whole from the start.
      expectComputed(path, { animationName: 'none', strokeDashoffset: '0px' });
      return;
    }
    // finished_check_draws_once: motion-base on the emphasis ease, once, ending drawn.
    expectComputed(path, {
      animationName: 'cd-steps-draw',
      animationDuration: '0.2s',
      animationIterationCount: '1',
      animationTimingFunction: 'cubic-bezier(0.165, 0.84, 0.44, 1)',
      animationFillMode: 'forwards',
    });
    // Short arm first, as a hand writes a check, ending whole.
    await expectDrawsShortArmFirst(path);
    // Only the last step's check draws: the steps done before it are drawn already.
    const done = canvasElement.querySelectorAll('.cd-steps__step--done svg path');
    await expect(done).toHaveLength(4);
    for (const check of done) expectComputed(check, { animationName: 'none' });
  },
};

export const PastTheEnd: Story = {
  args: { label: 'Set up your Desk', steps: ['Questions', 'Tools', 'Live'], current: 3 },
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'none', canvasNote: `${PHONE_NOTE} A step past the last one is read and drawn as the last.` },
  play: async ({ canvasElement }) => {
    // steps_clamped_alike: the list marks the step the line names, so both say the same.
    const items = await expectPhoneSteps(canvasElement, 'Set up your Desk');
    await expect(items.map((item) => item.getAttribute('aria-current'))).toEqual([null, null, 'step']);
    await expect(compactLine(canvasElement).textContent).toBe('Step 3 of 3: Live');
  },
};

export const NoSteps: Story = {
  args: { label: 'Set up your Desk', steps: [], current: 0 },
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'none', canvasNote: `${PHONE_NOTE} With no steps there is no line.` },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('.cd-steps__compact')).toBeNull();
  },
};
