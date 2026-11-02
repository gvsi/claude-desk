import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { SituationRow, type SituationRowProps } from './SituationRow.tsx';

/** Real situations as the setup interview's check returns them for Turner Plumbing's draft rules. */
const SITUATIONS: SituationRowProps[] = [
  { title: 'A visitor wants a drain cleared on Tuesday afternoon', who: 'A visitor, not verified', outcome: 'allow', dependsOnReview: false, reason: 'Books weekday visits in your hours.', matches: true },
  { title: 'A visitor asks for 10% off if they pay cash', who: 'A visitor, not verified', outcome: 'hold', dependsOnReview: false, reason: 'Discounts ask you first.', matches: true },
  { title: 'An agent pays the service call deposit', who: 'Alex Kim’s assistant, signed limit', outcome: 'allow', dependsOnReview: true, reason: 'Within its signed limit, checked by the reviewer.', matches: true },
  { title: 'A visitor wants a Saturday morning visit for a slow drain', who: 'A visitor, not verified', outcome: 'allow', dependsOnReview: false, reason: 'Books weekday visits in your hours.', matches: false },
  { title: 'Someone asks for Bob’s address', who: 'A visitor, not verified', outcome: 'refuse', dependsOnReview: false, reason: 'Private data only to its verified owner.', matches: true },
];

const meta = {
  title: 'Setup/SituationRow',
  component: SituationRow,
  args: SITUATIONS[0]!,
  render: () => (
    <ul aria-label="Real situations" style={{ maxWidth: 686, margin: 0, padding: 0, listStyle: 'none' }}>
      {SITUATIONS.map((situation) => (
        <li key={situation.title}>
          <SituationRow {...situation} />
        </li>
      ))}
    </ul>
  ),
  parameters: { layout: 'padded', canvas: 'N-R2-Setup-09-Situations' },
} satisfies Meta<typeof SituationRow>;

export default meta;

type Story = StoryObj<typeof meta>;

const PRIMARY = 'rgba(250, 249, 245, 0.92)';
const SECONDARY = 'rgba(250, 249, 245, 0.64)';

export const Situations: Story = {
  parameters: { canvasNote: 'The situations card’s rows at its inner width, 686 px: each outcome, the second look, and one not as planned.' },
  play: async ({ canvas }) => {
    const rows = within(canvas.getByRole('list', { name: 'Real situations' })).getAllByRole('listitem').map((item) => item.firstElementChild as HTMLElement);

    // situation_row_says_the_outcome_in_words: each outcome's words beside its dot, in its tone.
    const outcomes = rows.map((row) => row.querySelector('.cd-situation-row__outcome')?.textContent);
    await expect(outcomes).toEqual(['Does it', 'Asks you', 'Does it if Claude’s second look agrees', 'Does it', 'Never']);
    const tones = rows.map((row) => row.querySelector('.cd-situation-row__outcome .cd-status-dot')?.className.replace('cd-status-dot cd-status-dot--', ''));
    await expect(tones).toEqual(['handled', 'held', 'handled', 'handled', 'refused']);

    // Hairlines only between rows, padded 14 px top and bottom; the situation and who it is on the
    // left, the outcome and the kernel's reason in a 300 px column at the right, both from the top.
    const [first] = rows as [HTMLElement];
    for (const [index, row] of rows.entries()) {
      expectComputed(row, { borderTopWidth: index === 0 ? '0px' : '1px' });
      if (index > 0) expectComputed(row, { borderTopColor: 'rgba(250, 249, 245, 0.12)' });
    }
    expectComputed(first, { paddingTop: '14px', paddingBottom: '14px' });
    const title = within(first).getByText(SITUATIONS[0]!.title);
    expectComputed(title, { fontSize: '15px', lineHeight: '21px', fontWeight: '520', color: PRIMARY });
    expectComputed(within(first).getByText('A visitor, not verified'), { fontSize: '14px', lineHeight: '19px', color: SECONDARY });
    const outcome = first.querySelector<HTMLElement>('.cd-situation-row__outcome')!;
    expectComputed(outcome, { fontSize: '14px', lineHeight: '19px', color: PRIMARY });
    expectComputed(within(first).getByText('Books weekday visits in your hours.'), { fontSize: '14px', lineHeight: '19px', color: SECONDARY });
    await expect(first.getBoundingClientRect().height).toBe(70);
    const right = first.querySelector<HTMLElement>('.cd-situation-row__result')!;
    await expect(right.getBoundingClientRect().width).toBe(300);
    await expect(Math.round(right.getBoundingClientRect().right)).toBe(Math.round(first.getBoundingClientRect().right));
    await expect(Math.round(right.getBoundingClientRect().top)).toBe(Math.round(title.getBoundingClientRect().top));

    // situation_row_flags_a_surprise: "Not what we planned" only where the outcome isn't the one
    // planned, as words beside a thin held bar, never colored text.
    const flags = rows.map((row) => row.querySelector('.cd-situation-row__flag')?.textContent ?? null);
    await expect(flags).toEqual([null, null, null, 'Not what we planned', null]);
    const flag = rows[3]!.querySelector<HTMLElement>('.cd-situation-row__flag')!;
    expectComputed(flag, { fontSize: '13px', lineHeight: '18px', color: PRIMARY, borderLeftWidth: '2px', borderLeftColor: 'rgb(218, 190, 74)', paddingLeft: '8px' });
  },
};

/** The kernel reports a planned reviewer-conditional situation as a hold that depends on review. */
const HELD_FOR_REVIEW: SituationRowProps = {
  title: 'An agent pays the service call deposit',
  who: 'Alex Kim’s assistant, signed limit',
  outcome: 'hold',
  dependsOnReview: true,
  reason: 'Within its signed limit, checked by the reviewer.',
  matches: true,
};

export const Landing: Story = {
  render: () => (
    <ul aria-label="Real situations" style={{ maxWidth: 686, margin: 0, padding: 0, listStyle: 'none' }}>
      {SITUATIONS.map((situation, index) => (
        <li key={situation.title}>
          <SituationRow {...situation} index={index} live />
        </li>
      ))}
    </ul>
  ),
  parameters: {
    canvasNote: 'Situations just tried, landing one by one in the order tried, as the safety check’s tricks do: each rises 4 px and fades in, its dot scaling in, motion-stagger after the one before it. Under reduced motion they are there at once.',
  },
  play: async ({ canvas }) => {
    const rows = within(canvas.getByRole('list', { name: 'Real situations' })).getAllByRole('listitem').map((item) => item.firstElementChild as HTMLElement);

    // situation_rows_land_one_by_one: each row lands motion-stagger after the one before it, the
    // first at once, rising space-4 as it fades in over motion-base on the emphasis ease; its dot
    // scales in on the same beat.
    await expect(rows.map((row) => getComputedStyle(row).animationDelay)).toEqual(['0s', '0.15s', '0.3s', '0.45s', '0.6s']);
    for (const row of rows) {
      expectComputed(row, {
        animationName: 'cd-situation-row-land',
        animationDuration: '0.2s',
        animationTimingFunction: 'cubic-bezier(0.165, 0.84, 0.44, 1)',
        animationFillMode: 'backwards',
      });
      const dot = row.querySelector<HTMLElement>('.cd-status-dot')!;
      expectComputed(dot, { animationName: 'cd-situation-row-dot', animationDelay: getComputedStyle(row).animationDelay, animationDuration: '0.2s' });
    }
  },
};

export const HeldForReview: Story = {
  render: () => (
    <ul aria-label="Real situations" style={{ maxWidth: 686, margin: 0, padding: 0, listStyle: 'none' }}>
      <li>
        <SituationRow {...HELD_FOR_REVIEW} />
      </li>
    </ul>
  ),
  parameters: {
    canvasNote: 'The board’s second-look row, as the kernel reports it: a hold that depends on Claude’s second look (`allow_if_reviewed`).',
  },
  play: async ({ canvas }) => {
    // second_look_whatever_the_outcome: the second-look words and the board's handled dot come from
    // `dependsOnReview` alone, so a reviewer-conditional hold doesn't read "Asks you".
    const row = within(canvas.getByRole('list', { name: 'Real situations' })).getByRole('listitem').firstElementChild as HTMLElement;
    const outcome = row.querySelector<HTMLElement>('.cd-situation-row__outcome')!;
    await expect(outcome.textContent).toBe('Does it if Claude’s second look agrees');
    await expect(outcome.querySelector('.cd-status-dot--handled')).not.toBeNull();
    await expect(row).not.toHaveTextContent('Asks you');
  },
};

export const Phone: Story = {
  render: () => (
    <ul aria-label="Real situations" style={{ maxWidth: 326, margin: 0, padding: 0, listStyle: 'none' }}>
      {SITUATIONS.slice(2, 4).map((situation) => (
        <li key={situation.title}>
          <SituationRow {...situation} />
        </li>
      ))}
    </ul>
  ),
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'none', canvasNote: 'No board draws a situation on a phone (N-R2-Setup-09-Situations is a laptop): the outcome drops under who it is, from the same edge.' },
  play: async ({ canvas }) => {
    const rows = within(canvas.getByRole('list', { name: 'Real situations' })).getAllByRole('listitem').map((item) => item.firstElementChild as HTMLElement);
    for (const row of rows) {
      const who = row.querySelector<HTMLElement>('.cd-situation-row__who')!;
      const result = row.querySelector<HTMLElement>('.cd-situation-row__result')!;
      await expect(Math.round(result.getBoundingClientRect().left)).toBe(Math.round(who.getBoundingClientRect().left));
      await expect(result.getBoundingClientRect().top).toBeGreaterThanOrEqual(who.getBoundingClientRect().bottom);
    }
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
