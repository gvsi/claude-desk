import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { Button } from '../components/Button/Button.tsx';
import { PageHeader } from '../components/PageHeader/PageHeader.tsx';
import { SituationRow, type SituationRowProps } from '../components/SituationRow/SituationRow.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { SetupFrame } from './parts.tsx';
import { SPEC, expectFooter, expectFooterAtFoot, expectTabOrder, one } from './spec.ts';

/** The situations the check ran on Turner Plumbing's draft rules, as the board writes them. */
const SITUATIONS: SituationRowProps[] = [
  { title: 'A visitor wants a drain cleared on Tuesday afternoon', who: 'A visitor, not verified', outcome: 'allow', dependsOnReview: false, reason: 'Books weekday visits in your hours.', matches: true },
  { title: 'A visitor asks for 10% off if they pay cash', who: 'A visitor, not verified', outcome: 'hold', dependsOnReview: false, reason: 'Discounts ask you first.', matches: true },
  { title: 'An agent pays the service call deposit', who: 'Alex Kim’s assistant, signed limit', outcome: 'allow', dependsOnReview: true, reason: 'Within its signed limit, checked by the reviewer.', matches: true },
  { title: 'Dana asks for her last invoice', who: 'Dana Whitfield, verified', outcome: 'allow', dependsOnReview: false, reason: 'Sends customers their own documents.', matches: true },
  { title: 'A visitor wants a Saturday morning visit for a slow drain', who: 'A visitor, not verified', outcome: 'allow', dependsOnReview: false, reason: 'Books weekday visits in your hours.', matches: false },
  { title: 'Someone asks for Bob’s address', who: 'A visitor, not verified', outcome: 'refuse', dependsOnReview: false, reason: 'Private data only to its verified owner.', matches: true },
];

function SetupSituations() {
  return (
    <SetupFrame business={rivera.business.name}>
      <PageHeader title="Real situations" subtitle="How your rules will handle things that really happen at Turner Plumbing. Nothing here is real." />
      <ul role="list" className="board-setup__rows" aria-label="Real situations">
        {SITUATIONS.map((situation) => (
          <li key={situation.title}>
            <SituationRow {...situation} />
          </li>
        ))}
      </ul>
      {/* "Looks right" is the step's only answer (owner ruling, 2026-10-30). */}
      <div className="board-setup__actions">
        <Button variant="primary" size="main" onClick={fn()}>
          Looks right
        </Button>
      </div>
    </SetupFrame>
  );
}

const meta = {
  title: 'Boards/Setup, real situations',
  render: () => <SetupSituations />,
  // Drawn at a 14-inch laptop's width and the page's own 1100 px, so the play measures it there.
  globals: { viewport: { value: 'laptop-1100', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Setup-09-Situations',
    canvasNote: [
      'Signed on 2026-10-30.',
      'The setup interview’s situations step: each situation is a SituationRow, with the outcome in words beside its dot, the second look, and “Not what we planned” beside a thin held bar.',
      'By the owner’s ruling of 2026-10-30, “Looks right” is the only answer: the board’s “Change a rule” is removed, as on the board updated on the canvas.',
      'The step list in the bar (“Questions, Tools, Rules, Safety check, Live”) is left out of the setup frame, so the bar has a gap where it goes; the bar, the column and the button are page layout the web app (plan 04) owns.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 1100]);
    expectComputed(canvas.getByRole('heading', { level: 1, name: 'Real situations' }), SPEC.pageTitle);

    // The card of rows: 720 px, centered, hairlines between rows and the outcome column at 300 px.
    const list = canvas.getByRole('list', { name: 'Real situations' });
    const box = list.getBoundingClientRect();
    await expect([Math.round(box.left), Math.round(box.width)]).toEqual([396, 720]);
    expectComputed(list, { ...SPEC.card, paddingTop: '16px', paddingLeft: '16px' });
    const rows = within(list).getAllByRole('listitem').map((item) => item.firstElementChild as HTMLElement);
    await expect(rows.map((row) => one(row, '.cd-situation-row__outcome').textContent)).toEqual([
      'Does it',
      'Asks you',
      'Does it if Claude’s second look agrees',
      'Does it',
      'Does it',
      'Never',
    ]);
    // One line each side: 68 px first, then 69 px with the hairline. (The flagged row grows by its line; its long
    // title can wrap where the fonts load late, so only the others are measured.)
    await expect(rows.filter((_, index) => index !== 4).map((row) => Math.round(row.getBoundingClientRect().height))).toEqual([68, 69, 69, 69, 69]);
    await expect(Math.round(one(rows[0]!, '.cd-situation-row__result').getBoundingClientRect().left)).toBe(799);
    await expect(rows.filter((row) => row.querySelector('.cd-situation-row__flag'))).toEqual([rows[4]]);

    // The answer 20 px under the card: Looks right, the one primary and the only answer (owner
    // ruling, 2026-10-30: there is no "Change a rule" on this step).
    const looksRight = canvas.getByRole('button', { name: 'Looks right' });
    expectComputed(looksRight, SPEC.primary);
    await expect(canvas.queryByRole('button', { name: 'Change a rule' })).toBeNull();
    await expect(Math.round(looksRight.getBoundingClientRect().top - box.bottom)).toBe(20);
    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);

    // focus_order_is_logical: Save and exit, then the answer.
    await expectTabOrder(userEvent, [canvas.getByRole('button', { name: 'Save and exit' }), looksRight]);
  },
};
