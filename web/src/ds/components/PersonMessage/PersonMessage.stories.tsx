import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import type { EvMessage, SseEvent } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { PersonMessage } from './PersonMessage.tsx';

/** Maria's say during the take-over: author `owner`, one `owner_said` block. */
const said = rivera.events.takeOver.find((event: SseEvent): event is EvMessage => event.type === 'message') as EvMessage;
const saidText = said.blocks[0]?.text ?? '';

const meta = {
  title: 'Conversation/PersonMessage',
  component: PersonMessage,
  args: { name: rivera.business.ownerName, role: 'owner', blocks: said.blocks, language: said.language },
  parameters: { layout: 'padded', canvas: 'N-Public-Handoff-Run1' },
} satisfies Meta<typeof PersonMessage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const OwnerSpeaking: Story = {
  parameters: {
    canvasNote: "The board's words are Maria's from that chat; here they are the fixture's owner_said block, shown verbatim with no card frame.",
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(said.author).toBe('owner');
    await expect(said.blocks.map((block) => block.template)).toEqual(['owner_said']);
    // prose_is_serif_people_are_sans: people write in sans; only Claude writes in serif.
    const words = canvas.getByText(saidText);
    expectComputed(words, { fontFamily: /Hanken Grotesk/, fontSize: '15px', color: 'rgba(250, 249, 245, 0.92)' });
    // The owner's words exactly, with no card frame, label or bubble.
    await expect(words.textContent).toBe(saidText);
    await expect(canvasElement.querySelector('.cd-card')).toBeNull();
    await expect(canvas.queryByText(`${rivera.business.ownerName} said`)).toBeNull();
    expectComputed(words, { backgroundColor: 'rgba(0, 0, 0, 0)', paddingLeft: '0px' });
    await expect(words.closest('[data-copy="user"]')).not.toBeNull();
    // The name and role are text; the initials beside them are hidden from screen readers.
    await expect(canvasElement.querySelector('.cd-person-message__who')).toHaveTextContent(/^Maria Rivera, owner$/);
    const avatar = canvasElement.querySelector('.cd-person-message__avatar') as HTMLElement;
    await expect(avatar).toHaveAttribute('aria-hidden', 'true');
    await expect(avatar.textContent).toBe('MR');
    expectComputed(avatar, { width: '28px', height: '28px', backgroundColor: 'rgb(60, 57, 47)' });
  },
};
