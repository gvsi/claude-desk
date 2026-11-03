import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { AgentMessage } from '../components/AgentMessage/AgentMessage.tsx';
import { ClaudeMessage } from '../components/ClaudeMessage/ClaudeMessage.tsx';
import { MarginReceipt } from '../components/MarginReceipt/MarginReceipt.tsx';
import { SignedLimitPanel } from '../components/SignedLimitPanel/SignedLimitPanel.tsx';
import { SystemLine } from '../components/SystemLine/SystemLine.tsx';
import { Transcript } from '../components/Transcript/Transcript.tsx';
import { TranscriptRow } from '../components/TranscriptRow/TranscriptRow.tsx';
import { proseBlock, rivera } from '../fixtures/index.ts';
import { AgentsCard, AgentsFrame, brandOf } from './parts.tsx';
import { expectAgentsDisclosure, expectConversationType, expectFooter, expectReceiptsUnderMessages } from './spec.ts';

/** The agents page's static words for the built-in agent's limit; the panel's story checks them against the seed's mandate. */
const LIMIT = { perCharge: '$20', total: '$100', duration: 'One hour', source: 'Signed limit from Alex Kim’s demo wallet' } as const;

/** The kernel's line for the charge it refused, as the board writes it: the visitor's `visitor_plain`. */
const REFUSED = 'Refused: over the signed limit for this agent';

/** "Try to pay more than its limit": the agent's one signed request, refused by the kernel. */
function AgentsOverLimit() {
  return (
    <AgentsFrame brand={brandOf(rivera.publicDesk.en)}>
      <AgentsCard title="Send an agent" lead="Try to pay more than its limit" holdsCards>
        <SignedLimitPanel {...LIMIT} language="en" />
        <Transcript label="Agent run">
          <TranscriptRow>
            <AgentMessage agentName="Alex Kim’s assistant" signed title="Try to pay more than its limit" meta="Request 1" />
          </TranscriptRow>
          <TranscriptRow margin={<MarginReceipt source={{ kind: 'decision', state: 'refused' }} plain={REFUSED} ledgerSeq={43} />}>
            <ClaudeMessage blocks={[proseBlock('I can’t take that payment: it’s over the limit the agent’s owner signed.')]} language="en" ownerName={rivera.business.ownerName} />
          </TranscriptRow>
          <SystemLine text="The agent finished." />
        </Transcript>
      </AgentsCard>
    </AgentsFrame>
  );
}

const meta = {
  title: 'Boards/Agents page, over the limit',
  render: () => <AgentsOverLimit />,
  // Drawn at a 14-inch laptop's window, so the play measures it there.
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Agents-05-Over-Limit',
    canvasNote: [
      'Signed on 2026-10-30.',
      'The agent sent to pay more than its limit: the signed limit stays above the run (SignedLimitPanel), and the kernel’s refusal is the receipt under Claude’s words, in the refused tone.',
      'The cards, the column and the run’s order are the web app’s page layout (plan 04).',
      'The AI disclosure under the title is DisclosureLine, as the agents boards say it since a ruling on 2026-10-30; it is 19 px where the renders draw an earlier 17 px line, and the title above it is larger too, so everything under it sits lower than the render.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    await expectAgentsDisclosure(canvasElement);
    const box = (el: Element) => el.getBoundingClientRect();
    const send = canvas.getByRole('region', { name: 'Send an agent' });
    await expect([Math.round(box(send).top), Math.round(box(send).height)]).toEqual([230, 342]);
    // The limit above the run, 65 px, 10 px under the card's line; the request 35 px under it.
    const limit = within(send).getByRole('region', { name: 'Signed limit' });
    await expect([Math.round(box(limit).top), Math.round(box(limit).height)]).toEqual([299, 65]);
    const run = within(send).getByRole('log', { name: 'Agent run' });
    expectConversationType(run);
    await expect(await expectReceiptsUnderMessages(run)).toBe(1);
    const request = run.querySelector('.cd-agent-message__bubble') as HTMLElement;
    await expect([Math.round(box(request).top), Math.round(box(request).height)]).toEqual([398, 59]);
    // over_limit_shows_the_kernel_line: the refusal is the kernel's line, beside the refused dot.
    const receipt = within(run).getByText(REFUSED);
    await expect(receipt.closest('.cd-margin-line')?.querySelector('.cd-status-dot--refused')).not.toBeNull();
    await expect(within(run).getByText('The agent finished.')).toBeVisible();
    await expectFooter(canvasElement);
  },
};
