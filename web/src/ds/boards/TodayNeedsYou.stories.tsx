import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { RECORDED_HISTORY_HREF, TodayNeedsYou } from './parts.tsx';
import { SPEC, expectFooter, expectOwnerFrame, expectTabOrder, one } from './spec.ts';

const meta = {
  title: 'Boards/Today, needs you',
  render: () => <TodayNeedsYou />,
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Today-Run1',
    canvasNote: [
      "The reviewer's first visit and Today in one board: the reviewer bar, the sidebar and the greeting, after the first-visit dialog (N-Intro-D) closes.",
      'Things to try, Last 7 days, Live now and the short briefing are page layout the web app (plan 04) owns, composed here from Card, Button, StatusDot, StatusLabel, TextLink, RecordedHistoryLink, ConversationListItem and the tokens.',
      'The held quote is held by its card’s discount limit, not by the tool, so its answers are the two plain buttons of the signed answer board (N-Answers-TwoButtons), with no Deny always; the board draws three neutral answers from before that sign-off.',
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

    // The reviewer arrival: the bar across the top, then the greeting in Claude's serif voice.
    const bar = canvas.getByRole('note');
    await expect(bar).toHaveTextContent(`You're ${rivera.business.ownerName} today. This is a concept prototype.`);
    await expect(bar.getBoundingClientRect().width).toBe(document.documentElement.clientWidth);
    expectComputed(canvas.getByRole('heading', { level: 1, name: 'Good morning, Mike' }), SPEC.greeting);

    // The held row says what is waiting with the held item's own rule.
    await expect(
      canvas.getByText(`A request is waiting for your answer: ${rivera.ruleCards['rv-quote'].reason}`),
    ).toBeVisible();

    // The right column is "Last 7 days"; recorded history is named there and at Since last night.
    // Both are the one caption link, in its quiet look, to the ledger's explanation.
    const week = canvas.getByRole('region', { name: 'Last 7 days' });
    const since = canvas.getByRole('region', { name: 'Since last night' });
    for (const region of [week, since]) {
      const caption = within(region).getByRole('link', { name: 'Includes recorded history' });
      await expect(caption).toBeVisible();
      await expect(caption).toHaveAttribute('href', RECORDED_HISTORY_HREF);
      expectComputed(caption, SPEC.recordedLink);
    }
    await expect(week.getBoundingClientRect().left).toBeGreaterThan(canvas.getByRole('heading', { level: 1 }).getBoundingClientRect().right);
    // Its figures, at the two sizes the board draws: the booked total in the figure style, the
    // stopped count in the smaller one, both with tabular figures.
    const booked = within(week).getByText('$1,860');
    await expect(booked).toHaveClass('cd-type-figure');
    expectComputed(booked, SPEC.figure);
    const stopped = within(week).getByText('14');
    await expect(stopped).toHaveClass('cd-type-figure-small');
    expectComputed(stopped, SPEC.figureSmall);

    // The held request: a card, its answers the signed plain buttons for a limit hold.
    const card = one(canvasElement, '.cd-approval-card__top').closest<HTMLElement>('.cd-card') as HTMLElement;
    expectComputed(card, SPEC.card);
    const allow = within(card).getByRole('button', { name: 'Allow this time' });
    const deny = within(card).getByRole('button', { name: 'Deny this time' });
    expectComputed(allow, SPEC.secondaryMain);
    await expect(within(card).queryByRole('button', { name: /always/i })).toBeNull();
    await expect(deny).not.toHaveAttribute('aria-haspopup');
    expectComputed(one(since, '.cd-card'), SPEC.card);

    await expectFooter(canvasElement);

    // focus_order_is_logical: the bar, the business, the pages in order, Claude acts for you, then the page.
    const sidebar = canvas.getByRole('complementary', { name: 'Claude Desk' });
    const nav = within(sidebar).getByRole('navigation', { name: 'Main' });
    await expectTabOrder(userEvent, [
      within(bar).getByRole('button', { name: 'Reset demo' }),
      within(sidebar).getByRole('button', { name: `Switch business, current: ${rivera.business.name}` }),
      ...within(nav).getAllByRole('link'),
      within(sidebar).getByRole('switch', { name: 'Claude acts for you' }),
      canvas.getByRole('button', { name: 'Copy your Desk link' }),
      canvas.getByRole('button', { name: 'Hide this list' }),
      canvas.getByRole('button', { name: 'Open your public page' }),
      canvas.getByRole('button', { name: 'Open the request' }),
      allow,
      deny,
      within(week).getByRole('button', { name: 'Chat as a customer' }),
    ]);
  },
};
