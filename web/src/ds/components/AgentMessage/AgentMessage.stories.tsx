import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { AgentMessage } from './AgentMessage.tsx';

/** What Alex Kim's assistant sent, in order (the agent's own words, untrusted text). */
const requests = rivera.conversations.alexAgent.turns.flatMap((turn) => (turn.kind === 'agent' ? [turn.text] : []));
const [firstRequest = '', secondRequest = ''] = requests;

const meta = {
  title: 'Conversation/AgentMessage',
  component: AgentMessage,
  args: {
    agentName: rivera.conversations.alexAgent.name,
    signed: true,
    title: 'Quote the service call deposit',
    text: firstRequest,
    meta: 'Request 1',
    time: '11:42:03',
  },
  parameters: { layout: 'padded', canvas: 'N-Conv-Agent' },
} satisfies Meta<typeof AgentMessage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const SignedRequest: Story = {
  parameters: {
    canvasNote: "The board's request is a diagnostic visit; the fixture's agent asks for the service call deposit and adds its own words under the title.",
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvasElement.querySelector('.cd-agent-message__who')).toHaveTextContent(/^Alex Kim's assistant, signed request$/);
    // The agent glyph is decorative; the line says who sent it and whether it was signed.
    await expect(canvasElement.querySelector('.cd-agent-message__who svg')).toHaveAttribute('aria-hidden', 'true');
    // The bubble: a 1 px card border at the control radius, on the right, like the board's.
    const bubble = canvasElement.querySelector('.cd-agent-message__bubble') as HTMLElement;
    expectComputed(bubble, { borderTopStyle: 'solid', borderTopWidth: '1px', borderTopLeftRadius: '8px', paddingLeft: '14px' });
    const column = canvasElement.querySelector('.cd-agent-message') as HTMLElement;
    await expect(Math.abs(bubble.getBoundingClientRect().right - column.getBoundingClientRect().right)).toBeLessThanOrEqual(0.5);
    await expect(canvas.getByText('Quote the service call deposit')).toBeVisible();
    // The agent's text keeps its line breaks and is marked as someone else's words.
    const text = canvasElement.querySelector('.cd-agent-message__text') as HTMLElement;
    await expect(text.textContent).toBe(firstRequest);
    await expect(text).toHaveAttribute('data-copy', 'user');
    expectComputed(text, { whiteSpace: 'pre-wrap' });
    // The meta line: the consumer's words, then the time as given.
    await expect(canvasElement.querySelector('.cd-agent-message__meta')).toHaveTextContent(/^Request 1\s*11:42:03$/);
  },
};

export const SignedRequestNoTime: Story = {
  args: { title: 'Signed request', text: secondRequest, meta: 'Request 2', time: undefined },
  parameters: { canvasNote: "The board's request rows each end with a time; a request with no time drops it, and the meta line keeps its words." },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('.cd-agent-message__meta')?.textContent).toBe('Request 2');
    await expect(canvasElement.querySelector('.cd-agent-message__time')).toBeNull();
    await expect(canvasElement.querySelector('.cd-agent-message__text')?.textContent).toBe(secondRequest);
  },
};
