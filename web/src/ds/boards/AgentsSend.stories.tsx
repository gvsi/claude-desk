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
const TASKS = ['Book the earliest visit', 'Get a quote and pay the service call deposit', 'Try to pay more than its limit'];

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
        <SuggestionChips label="Tasks for the agent" suggestions={TASKS} onPick={fn()} />
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
      'Sending the built-in agent: its signed spending limit is SignedLimitPanel, with the page’s words for the seed’s mandate ($20 a charge, $100 in all, for one hour), on the card’s own fill as the board nests it; the tasks are SuggestionChips.',
      'The column, the cards and the demo key’s button are page layout the web app (plan 04) owns, composed as on the agents page’s other boards.',
      'The AI disclosure under the title is DisclosureLine, as the agents boards say it since a ruling on 2026-10-30; it is 19 px where the renders draw an earlier 17 px line, and the title above it is larger too, so everything under it sits lower than the render.',
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
    // The two cards under the disclosure, 145 and 189 px (the demo key's line takes two lines), 16 px apart.
    const box = (el: HTMLElement) => el.getBoundingClientRect();
    await expect([Math.round(box(demoKey).top), Math.round(box(demoKey).height)]).toEqual([230, 145]);
    await expect([Math.round(box(send).top), Math.round(box(send).height)]).toEqual([391, 189]);

    // The limit inside the card: 726 px by 65, 10 px under the card's line, on the card's fill.
    const limit = within(send).getByRole('region', { name: 'Signed limit' });
    await expect([Math.round(box(limit).left), Math.round(box(limit).top), Math.round(box(limit).width), Math.round(box(limit).height)]).toEqual([393, 460, 726, 65]);
    expectComputed(limit, { backgroundColor: 'rgba(250, 249, 245, 0.03)', borderTopColor: 'rgba(250, 249, 245, 0.14)' });
    await expect([...limit.querySelectorAll('dd')].map((value) => value.textContent)).toEqual(['$20', '$100', 'One hour']);
    const source = within(limit).getByText('Signed limit from Alex Kim’s demo wallet');
    await expect(Math.round(box(source).right)).toBe(1102);

    // The tasks 10 px under it, one 28 px line of chips.
    const tasks = within(send).getByRole('group', { name: 'Tasks for the agent' });
    const chips = within(tasks).getAllByRole('button');
    await expect(chips.map((chip) => chip.textContent)).toEqual(TASKS);
    for (const chip of chips) {
      await expect([Math.round(box(chip).top), Math.round(box(chip).height)]).toEqual([535, 28]);
    }

    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);
    await expectTabOrder(userEvent, [
      canvas.getByRole('link', { name: 'Back to the chat' }),
      within(demoKey).getByRole('button', { name: 'Get a demo key' }),
      ...chips,
    ]);
  },
};
