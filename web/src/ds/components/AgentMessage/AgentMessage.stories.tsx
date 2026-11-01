import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectSetOffName } from '../../test/expectSetOffName.ts';
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
  parameters: { layout: 'padded', canvas: 'N-Conv-Agent-Run1' },
} satisfies Meta<typeof AgentMessage>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The line above the bubble: the agent's name as its own run of user text, then the signed status
 * as a separate pill with its dot, never one run of text a name could imitate.
 */
async function expectWho(root: HTMLElement, name: string, status: 'Signed' | 'Not signed' | 'Firmado' | 'Sin firma', tone: 'handled' | 'refused') {
  const who = root.querySelector<HTMLElement>('.cd-agent-message__who');
  if (!who) throw new Error('no line above the bubble');
  const nameEl = who.querySelector<HTMLElement>('.cd-user-name');
  const pill = who.querySelector<HTMLElement>('.cd-pill');
  if (!nameEl || !pill) throw new Error('the name and the status are not separate elements');
  await expectSetOffName(who, name);
  await expect(pill.textContent).toBe(status);
  await expect(pill.hasAttribute('data-copy')).toBe(false);
  await expect(nameEl.contains(pill) || pill.contains(nameEl)).toBe(false);
  const dots = pill.querySelectorAll('.cd-status-dot');
  await expect(dots).toHaveLength(1);
  await expect(dots[0]).toHaveClass(`cd-status-dot--${tone}`);
  // Nothing else in the line: no comma or words joining the name to the status.
  await expect(who.textContent).toBe(`${name}${status}`);
}

export const SignedRequest: Story = {
  parameters: {
    canvasNote: "The board's request is a diagnostic visit; the fixture's agent asks for the service call deposit and adds its own words under the title.",
  },
  play: async ({ canvas, canvasElement }) => {
    await expectWho(canvasElement, "Alex Kim's assistant", 'Signed', 'handled');
    // The agent glyph is decorative; the line says who sent it and whether it was signed.
    await expect(canvasElement.querySelector('.cd-agent-message__who svg')).toHaveAttribute('aria-hidden', 'true');
    // The bubble: a 1 px card border at the control radius, on the right, like the board's.
    const bubble = canvasElement.querySelector('.cd-agent-message__bubble') as HTMLElement;
    expectComputed(bubble, { borderTopStyle: 'solid', borderTopWidth: '1px', borderTopLeftRadius: '8px', paddingLeft: '14px' });
    const column = canvasElement.querySelector('.cd-agent-message') as HTMLElement;
    await expect(Math.abs(bubble.getBoundingClientRect().right - column.getBoundingClientRect().right)).toBeLessThanOrEqual(0.5);
    await expect(canvas.getByText('Quote the service call deposit')).toBeVisible();
    // The agent's text keeps its line breaks and is marked as someone else's words, quoted under
    // the screen's title with a rule at its left, so the title and meta line read as the screen's.
    const text = canvasElement.querySelector('.cd-agent-message__text') as HTMLElement;
    await expect(text.textContent).toBe(firstRequest);
    await expect(text).toHaveAttribute('data-copy', 'user');
    await expect(text.tagName).toBe('BLOCKQUOTE');
    expectComputed(text, { whiteSpace: 'pre-wrap', borderLeftStyle: 'solid', borderLeftWidth: '2px', paddingLeft: '10px' });
    const title = canvasElement.querySelector('.cd-agent-message__title') as HTMLElement;
    const meta = canvasElement.querySelector('.cd-agent-message__meta') as HTMLElement;
    for (const own of [title, meta]) {
      await expect(own.hasAttribute('data-copy') || own.closest('[data-copy="user"]') !== null).toBe(false);
      await expect(text.contains(own) || own.contains(text)).toBe(false);
    }
    await expect(text.getBoundingClientRect().top).toBeGreaterThanOrEqual(title.getBoundingClientRect().bottom);
    await expect(meta.getBoundingClientRect().top).toBeGreaterThanOrEqual(text.getBoundingClientRect().bottom);
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

export const NotSigned: Story = {
  args: { agentName: "Alex Kim's assistant, signed request", signed: false, title: 'Unsigned request', meta: 'Request 3', time: undefined },
  parameters: {
    canvasNote:
      "The board shows only signed requests; this agent's name imitates the signed line, and still reads as its own name, with the status beside it in a pill.",
  },
  play: async ({ args, canvasElement }) => {
    // agent_name_is_not_status: the name, whatever it says, is user text; the status is the pill's.
    await expectWho(canvasElement, args.agentName, 'Not signed', 'refused');
  },
};

/** On the agents page in Spanish: the pill's words in the page's language, the agent's name as given. */
export const Spanish: Story = {
  args: { language: 'es', title: 'Reserva la primera visita', text: undefined, meta: 'Solicitud 1', time: undefined },
  render: (args) => (
    <div>
      <AgentMessage {...args} />
      <AgentMessage {...args} signed={false} meta="Solicitud 2" />
    </div>
  ),
  parameters: { canvas: 'none', canvasNote: 'N-R2-Agents-04-Run’s signed requests on the agents page in Spanish: “Firmado” and “Sin firma” in the pill.' },
  play: async ({ args, canvasElement }) => {
    // agent_message_speaks_the_pages_language: the status in Spanish, and `lang` on the message.
    const [signed, unsigned] = [...canvasElement.querySelectorAll<HTMLElement>('.cd-agent-message')] as [HTMLElement, HTMLElement];
    await expectWho(signed, args.agentName, 'Firmado', 'handled');
    await expectWho(unsigned, args.agentName, 'Sin firma', 'refused');
    for (const message of [signed, unsigned]) await expect(message).toHaveAttribute('lang', 'es');
  },
};

/** The built-in agent's English words on the agents page in Spanish: `lang` on the quote alone. */
export const SpanishPageEnglishText: Story = {
  args: { language: 'es', textLanguage: 'en', title: 'Reserva la primera visita', meta: 'Solicitud 1', time: undefined },
  parameters: { canvas: 'none', canvasNote: 'N-R2-Agents-04-Run’s signed requests on the agents page in Spanish, each quoting the agent’s English words.' },
  play: async ({ canvasElement }) => {
    const message = canvasElement.querySelector<HTMLElement>('.cd-agent-message');
    const text = canvasElement.querySelector<HTMLElement>('.cd-agent-message__text');
    await expect(message).toHaveAttribute('lang', 'es');
    await expect(text).toHaveAttribute('lang', 'en');
    await expect(text?.textContent).toBe(firstRequest);
    // Only the quote: the title and meta line are the page's, in Spanish.
    for (const own of canvasElement.querySelectorAll('.cd-agent-message__title, .cd-agent-message__meta')) {
      await expect(own.closest('[lang]')).toBe(message);
    }
  },
};
