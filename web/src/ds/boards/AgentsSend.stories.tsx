import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { Button } from '../components/Button/Button.tsx';
import { SignedLimitPanel } from '../components/SignedLimitPanel/SignedLimitPanel.tsx';
import { SuggestionChips } from '../components/SuggestionChips/SuggestionChips.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { AgentsCard, AgentsFrame, brandOf } from './parts.tsx';
import { expectAgentsDisclosure, expectFooter, expectFooterAtFoot, expectTabOrder } from './spec.ts';

/** The agents page's static words for the built-in agent's limit; the panel's story checks them against the seed's mandate. */
const LIMIT = { perCharge: '$20', total: '$100', duration: 'One hour', source: 'Signed limit from Alex Kim’s demo wallet' } as const;

/** The tasks to send the agent on, as the board words them (the web app's `DEMO_TASK_COPY`). */
const TASKS = [
  ['Book the earliest visit', 'Ask about heater flushes'],
  ['Get a quote and pay the service call deposit', 'Try to pay more than its limit'],
];

function AgentsSend() {
  return (
    <AgentsFrame brand={brandOf(rivera.publicDesk.en)}>
      <AgentsCard
        title="Try it with a demo key"
        lead="Simulated in this demo: the built-in agent and its wallet stand in for someone else’s. Neither key is a business credential."
      >
        <div>
          <Button variant="secondary" size="main" onClick={fn()}>
            Get a demo key
          </Button>
        </div>
      </AgentsCard>
      <AgentsCard title="Send an agent" lead="A built-in agent visits Turner Plumbing for Alex Kim. It’s simulated.">
        <SignedLimitPanel {...LIMIT} language="en" />
        <div className="board-agents__tasks">
          {TASKS.map((row) => <SuggestionChips key={row[0]} label="Tasks for the agent" suggestions={row} onPick={fn()} />)}
        </div>
      </AgentsCard>
    </AgentsFrame>
  );
}

const meta = {
  title: 'Boards/Agents page, send an agent',
  render: () => <AgentsSend />,
  // Drawn at a 14-inch laptop's window, so the play measures it there.
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Agents-03-Send',
    canvasNote: [
      'Signed on 2026-10-30.',
      'Sending the built-in agent: its signed spending limit is SignedLimitPanel, with the page’s words for the seed’s mandate ($20 a charge, $100 in all, for one hour), on the card’s own fill as the board nests it; four tasks use two SuggestionChips rows, tasks without money first and payment tasks second, 8 px apart, each wrapping independently.',
      'The column, the cards and the demo key’s button are page layout the web app (plan 04) owns, composed as on the agents page’s other boards.',
      'The AI disclosure under the title is DisclosureLine, as the agents boards say it since a ruling on 2026-10-30; it is 18 px where the renders draw an earlier 17 px line, so everything under it sits 1 px lower than the render.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    await expectAgentsDisclosure(canvasElement);
    const send = canvas.getByRole('region', { name: 'Send an agent' });
    const demoKey = canvas.getByRole('region', { name: 'Try it with a demo key' });
    // The two cards, 16 px apart; the send card adds a second 28 px chip row and an 8 px gap.
    const box = (el: HTMLElement) => el.getBoundingClientRect();
    await expect([Math.round(box(demoKey).top), Math.round(box(demoKey).height)]).toEqual([226, 124]);
    await expect([Math.round(box(send).top), Math.round(box(send).height)]).toEqual([366, 221]);

    // The limit inside the card: 726 px by 63, 10 px under the card's line, on the card's fill.
    const limit = within(send).getByRole('region', { name: 'Signed limit' });
    await expect([Math.round(box(limit).left), Math.round(box(limit).top), Math.round(box(limit).width), Math.round(box(limit).height)]).toEqual([393, 433, 726, 63]);
    expectComputed(limit, { backgroundColor: 'rgba(250, 249, 245, 0.03)', borderTopColor: 'rgba(250, 249, 245, 0.14)' });
    await expect([...limit.querySelectorAll('dd')].map((value) => value.textContent)).toEqual(['$20', '$100', 'One hour']);
    const source = within(limit).getByText('Signed limit from Alex Kim’s demo wallet');
    await expect(Math.round(box(source).right)).toBe(1102);

    // The tasks 10 px under it: tasks without money, then payments, each row 28 px tall.
    const rows = within(send).getAllByRole('group', { name: 'Tasks for the agent' });
    await expect(rows).toHaveLength(2);
    const chips = rows.flatMap((row, index) => {
      expectComputed(row, { display: 'flex', flexWrap: 'wrap', gap: '8px' });
      const buttons = within(row).getAllByRole('button');
      expect(buttons.map((chip) => chip.textContent)).toEqual(TASKS[index]);
      return buttons;
    });
    for (const [index, chip] of chips.entries()) {
      await expect([Math.round(box(chip).top), Math.round(box(chip).height)]).toEqual([index < 2 ? 506 : 542, 28]);
    }
    await expect(box(rows[1]!).top - box(rows[0]!).bottom).toBe(8);

    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);
    await expectTabOrder(userEvent, [
      canvas.getByRole('link', { name: 'Back to the chat' }),
      within(demoKey).getByRole('button', { name: 'Get a demo key' }),
      ...chips,
    ]);
  },
};
