import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { AgentMessage } from '../components/AgentMessage/AgentMessage.tsx';
import { ClaudeMessage } from '../components/ClaudeMessage/ClaudeMessage.tsx';
import { MarginReceipt } from '../components/MarginReceipt/MarginReceipt.tsx';
import { SystemLine } from '../components/SystemLine/SystemLine.tsx';
import { Transcript } from '../components/Transcript/Transcript.tsx';
import { TranscriptRow } from '../components/TranscriptRow/TranscriptRow.tsx';
import { cardBlock, proseBlock, rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { AgentsCard, AgentsFrame, brandOf } from './parts.tsx';
import { SPEC, expectAgentsDisclosure, expectConversationType, expectFooter, expectReceiptsUnderMessages } from './spec.ts';

/** The agent, as the run names it: Alex Kim's assistant, every request signed. */
const AGENT = 'Alex Kim’s assistant';

/** The Desk's two answers, as the board draws them: open times, then the booking, each a typed card. */
const OPEN_TIMES = [
  proseBlock('These times are open on Mike’s calendar.'),
  cardBlock('booking_options', {
    fact_id: 'slots:earliest',
    title: 'Times that are open',
    options: [
      { option_id: 'S-20261029-1400', label: 'Thursday, October 29, 2:00 pm' },
      { option_id: 'S-20261030-0800', label: 'Friday, October 30, 8:00 am' },
    ],
  }),
];
const BOOKED = [
  proseBlock('Here are the details.'),
  cardBlock('booking_confirmed', { fact_id: 'booking:B-81', title: 'Thursday, October 29', lines: ['Arriving 2:00 pm to 4:00 pm', 'With Mike Turner'] }),
];

/** "Book the earliest visit", sent and finished: two signed requests, each answered with a card. */
function AgentsRun() {
  return (
    <AgentsFrame brand={brandOf(rivera.publicDesk.en)}>
      <AgentsCard title="Send an agent" lead="Book the earliest visit" holdsCards>
        <Transcript label="Agent run">
          <TranscriptRow>
            <AgentMessage agentName={AGENT} signed title="Book the earliest visit" meta="Request 1" />
          </TranscriptRow>
          <TranscriptRow
            margin={<MarginReceipt source={{ kind: 'decision', state: 'executed' }} plain="Times read from Mike Turner’s calendar" ledgerSeq={41} />}
          >
            <ClaudeMessage blocks={OPEN_TIMES} language="en" ownerName={rivera.business.ownerName} />
          </TranscriptRow>
          <TranscriptRow>
            <AgentMessage agentName={AGENT} signed title="Signed request" meta="Request 2" />
          </TranscriptRow>
          <TranscriptRow
            margin={
              <MarginReceipt source={{ kind: 'decision', state: 'executed' }} plain="Booked within Mike Turner’s weekday hours" ledgerSeq={42} drawCheck />
            }
          >
            <ClaudeMessage blocks={BOOKED} language="en" ownerName={rivera.business.ownerName} />
          </TranscriptRow>
          <SystemLine text="The agent finished." />
        </Transcript>
      </AgentsCard>
    </AgentsFrame>
  );
}

const meta = {
  title: 'Boards/Agents page, the agent’s run',
  render: () => <AgentsRun />,
  // Drawn at a 14-inch laptop's width and the page's own 1150 px, so the play measures it there.
  globals: { viewport: { value: 'laptop-1150', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Agents-04-Run',
    canvasNote: [
      'Signed on 2026-10-30.',
      'The built-in agent’s run inside the “Send an agent” card, which holds cards (Card’s holdsCards), so the Desk’s reply cards sit in it: each signed request an AgentMessage built by the page, each answer a ClaudeMessage from the Desk’s blocks with its read-only receipt, then “The agent finished.”.',
      'The cards, the column and the run’s order are the web app’s page layout (plan 04); the receipts are the kernel’s lines as the board writes them.',
      'The AI disclosure under the title is DisclosureLine, as the agents boards say it since a ruling on 2026-10-30; it is 18 px where the renders draw an earlier 17 px line, so everything under it sits 1 px lower than the render.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 1150]);
    await expectAgentsDisclosure(canvasElement);
    const box = (el: Element) => el.getBoundingClientRect();
    // The card holds the run: 226 px down (the render's 225, under the 1 px taller disclosure), 681 px tall.
    const send = canvas.getByRole('region', { name: 'Send an agent' });
    await expect([Math.round(box(send).top), Math.round(box(send).height)]).toEqual([226, 681]);
    const run = within(send).getByRole('log', { name: 'Agent run' });
    expectConversationType(run);
    await expect(await expectReceiptsUnderMessages(run)).toBe(2);

    // Each signed request on the right, ending 640 px into the run; each reply card 520 px from its left.
    const requests = [...run.querySelectorAll('.cd-agent-message__bubble')];
    await expect(requests.map((request) => [Math.round(box(request).top), Math.round(box(request).right)])).toEqual([
      [317, 1033],
      [613, 1033],
    ]);
    const cards = [...run.querySelectorAll<HTMLElement>('.cd-card')];
    await expect(cards.map((card) => [Math.round(box(card).left), Math.round(box(card).top), Math.round(box(card).width), Math.round(box(card).height)])).toEqual([
      [393, 423, 520, 127],
      [393, 719, 520, 115],
    ]);
    for (const card of cards) expectComputed(card, { backgroundColor: SPEC.card.backgroundColor, borderTopColor: SPEC.card.borderTopColor });
    // The signed board draws each request as the page's title and its count; the page now quotes
    // the agent's words under the title too, as the review board UXC-P901-After draws them.
    await expect(requests.map((request) => request.textContent)).toEqual(['Book the earliest visitRequest 1', 'Signed requestRequest 2']);
    await expect(within(run).getByText('The agent finished.')).toBeVisible();
    await expectFooter(canvasElement);
  },
};
