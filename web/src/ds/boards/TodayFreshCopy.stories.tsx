import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { Card } from '../components/Card/Card.tsx';
import { ConceptFooter } from '../components/ConceptFooter/ConceptFooter.tsx';
import { EmptyState } from '../components/EmptyState/EmptyState.tsx';
import { Greeting } from '../components/Greeting/Greeting.tsx';
import { SectionHeader } from '../components/SectionHeader/SectionHeader.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { LastSevenDays, PUBLIC_LINK, RiveraFrame, THINGS_TO_TRY, ThingsToTry } from './parts.tsx';
import { SPEC, expectFooter, expectOwnerFrame, expectTabOrder, one } from './spec.ts';

/** Today on a fresh copy, before the recorded night replays into it or for a new owner: every empty state. */
function TodayFreshCopy() {
  return (
    <RiveraFrame current="today" reviewer counts={{}}>
      <div className="board-today">
        <div className="board-today__main">
          <Greeting text="Good morning, Mike" presence={{ line: 'Quiet right now.', people: [] }} link={{ label: PUBLIC_LINK, onCopy: fn() }} />
          <ThingsToTry things={[THINGS_TO_TRY.chat, THINGS_TO_TRY.breakIt, THINGS_TO_TRY.ownDesk]} />
          <section className="board-section" aria-labelledby="board-since-last-night">
            <SectionHeader id="board-since-last-night" title="Since last night" />
            <Card padding={20}>
              <EmptyState title="A quiet night" body="No conversations since you were last here." />
            </Card>
          </section>
          <ConceptFooter />
        </div>
        <LastSevenDays bars={null} />
      </div>
    </RiveraFrame>
  );
}

const meta = {
  title: 'Boards/Today, fresh copy',
  render: () => <TodayFreshCopy />,
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Today-Empty-Run1',
    canvasNote: [
      'Today with nothing recorded yet: no held request, so no "Answer a held request" row and no Needs you; "A quiet night" under Since last night; and "Last 7 days" saying there is nothing in each part, with no "Includes recorded history".',
      'The empty card under Since last night is EmptyState in a Card; the rest of the page is composed as on the Today board.',
      'The public link reads desk.example/rivera where the board writes “[prototype-domain]/rivera”; the board’s numbered pins are canvas notes.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expectOwnerFrame(canvasElement, 'Today');
    await expect(canvas.getByText('Your public page opens in a new tab. Ask about a price or a time.')).toBeVisible();
    expectComputed(canvas.getByRole('heading', { level: 1, name: 'Good morning, Mike' }), SPEC.greeting);

    // Nothing is held, so neither the held row nor Needs you shows; nothing counts in the sidebar.
    await expect(canvas.queryByText('Answer a held request')).toBeNull();
    await expect(canvas.queryByRole('heading', { name: 'Needs you' })).toBeNull();
    const sidebar = canvas.getByRole('complementary', { name: 'Claude Desk' });
    await expect(sidebar.querySelector('.cd-count-pill')).toBeNull();

    // Each empty state says what isn't there yet, in words.
    const since = canvas.getByRole('region', { name: 'Since last night' });
    await expect(within(since).getByText('A quiet night')).toBeVisible();
    await expect(within(since).getByText('No conversations since you were last here.')).toBeVisible();
    expectComputed(one(since, '.cd-card'), SPEC.card);
    const week = canvas.getByRole('region', { name: 'Last 7 days' });
    for (const line of ['No bookings in the last 7 days.', 'No conversations in the last 7 days.', 'No attempts in the last 7 days.']) {
      await expect(within(week).getByText(line)).toBeVisible();
    }
    // No recorded history is in it, so none is claimed.
    await expect(canvas.queryByRole('link', { name: 'Includes recorded history' })).toBeNull();

    await expectFooter(canvasElement);

    // focus_order_is_logical.
    const nav = within(sidebar).getByRole('navigation', { name: 'Main' });
    await expectTabOrder(userEvent, [
      canvas.getByRole('button', { name: 'Start over' }),
      within(sidebar).getByRole('button', { name: `Switch business, current: ${rivera.business.name}` }),
      ...within(nav).getAllByRole('link'),
      within(sidebar).getByRole('switch', { name: 'Answering' }),
      canvas.getByRole('button', { name: 'Copy your Desk link' }),
      canvas.getByRole('button', { name: 'Hide this list' }),
      canvas.getByRole('button', { name: 'Start a Desk' }),
      within(week).getByRole('button', { name: 'Chat as a customer' }),
      within(week).getByRole('link', { name: 'Open Safety' }),
    ]);
  },
};
