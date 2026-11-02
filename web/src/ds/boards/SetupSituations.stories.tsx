import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { Button } from '../components/Button/Button.tsx';
import { PageHeader } from '../components/PageHeader/PageHeader.tsx';
import { SituationRow, type SituationRowProps } from '../components/SituationRow/SituationRow.tsx';
import { rivera } from '../fixtures/index.ts';
import { setupSituationSentences as sentences } from '../fixtures/setupSituationSentences.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { SetupFrame } from './parts.tsx';
import { SPEC, expectFooter, expectTabOrder, one } from './spec.ts';

/** The situations the check ran on Turner Plumbing's draft rules, as the board writes them. */
const SITUATIONS: SituationRowProps[] = [
  { title: 'A visitor wants a drain cleared on Tuesday afternoon', who: 'A visitor, not verified', outcome: 'allow', dependsOnReview: false, reason: 'Books weekday visits in your hours.', sentence: sentences.booking, matches: true },
  { title: 'A visitor asks for 10% off if they pay cash', who: 'A visitor, not verified', outcome: 'hold', dependsOnReview: false, reason: 'Discounts ask you first.', matches: true },
  { title: 'An agent pays the service call deposit', who: 'Alex Kim’s assistant, signed limit', outcome: 'allow', dependsOnReview: true, reason: 'Within its signed limit, checked by the reviewer.', sentence: sentences.deposit, matches: true },
  { title: 'Dana asks for her last invoice', who: 'Dana Whitfield, verified', outcome: 'allow', dependsOnReview: false, reason: 'Sends customers their own documents.', sentence: sentences.documents, matches: true },
  { title: 'A visitor wants a Saturday morning visit for a slow drain', who: 'A visitor, not verified', outcome: 'allow', dependsOnReview: false, reason: 'Books weekday visits in your hours.', sentence: sentences.booking, matches: false },
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
  globals: { viewport: { value: 'desktop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Setup-09-Situations',
    canvasNote: [
      'Signed on 2026-10-30.',
      'The setup interview’s situations step: each situation is a SituationRow, with the outcome in words beside its dot, and “Not what we planned” beside a thin held bar.',
      'By the owner’s ruling of 2026-10-30, “Looks right” is the only answer: the board’s “Change a rule” is removed, as on the board updated on the canvas.',
      'The step list in the bar (“Questions, Tools, Rules, Safety check, Live”) is left out of the setup frame, so the bar has a gap where it goes; the bar, the column and the button are page layout the web app (plan 04) owns.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    expectComputed(canvas.getByRole('heading', { level: 1, name: 'Real situations' }), SPEC.pageTitle);

    // The card of rows: 720 px, centered, hairlines between rows and the outcome column at 300 px.
    const list = canvas.getByRole('list', { name: 'Real situations' });
    const box = list.getBoundingClientRect();
    await expect(Math.round(box.width)).toBeLessThanOrEqual(720);
    await expect(Math.round(box.left + box.width / 2)).toBe(Math.round(window.innerWidth / 2));
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    expectComputed(list, { ...SPEC.card, paddingTop: '16px', paddingLeft: '16px' });
    const rows = within(list).getAllByRole('listitem').map((item) => item.firstElementChild as HTMLElement);
    await expect(rows.map((row) => one(row, '.cd-situation-row__outcome').textContent)).toEqual([
      'Allow',
      'Ask me first',
      'Allow',
      'Allow',
      'Allow',
      'Never',
    ]);
    // A row a card decided reads that card's sentence; one no card decided keeps the kernel's words.
    await expect(rows.map((row) => row.querySelector('.cd-rule-sentence__sentence')?.textContent ?? one(row, '.cd-situation-row__reason').textContent)).toEqual([
      'Claude can book visits on weekdays, 8:00 am to 6:00 pm',
      'Discounts ask you first.',
      'Claude can take a visiting agent’s payment, up to $20, from its signed limit',
      'Claude can share customers’ own documents',
      'Claude can book visits on weekdays, 8:00 am to 6:00 pm',
      'Private data only to its verified owner.',
    ]);
    expectComputed(one(rows[0]!, 'strong'), { fontWeight: '520', fontVariantNumeric: 'tabular-nums' });

    for (const row of rows) {
      for (const key of row.querySelectorAll('strong')) expectComputed(key, { fontWeight: '520', fontVariantNumeric: 'tabular-nums' });
    }
    await expect(rows.filter((row) => row.querySelector('.cd-situation-row__flag'))).toEqual([rows[4]]);

    // The answer 20 px under the card: Looks right, the one primary and the only answer (owner
    // ruling, 2026-10-30: there is no "Change a rule" on this step).
    const looksRight = canvas.getByRole('button', { name: 'Looks right' });
    expectComputed(looksRight, SPEC.primary);
    await expect(canvas.queryByRole('button', { name: 'Change a rule' })).toBeNull();
    await expect(Math.round(looksRight.getBoundingClientRect().top - box.bottom)).toBe(20);
    await expectFooter(canvasElement);
    const footer = one(canvasElement, '[data-ds="concept-footer"]');
    await expect(footer.getBoundingClientRect().top).toBeGreaterThan(box.bottom);

    // focus_order_is_logical: Save and exit, then the answer.
    await expectTabOrder(userEvent, [canvas.getByRole('button', { name: 'Save and exit' }), looksRight]);
  },
};

export const Phone: Story = { ...Board, globals: { viewport: { value: 'phone', isRotated: false } } };
