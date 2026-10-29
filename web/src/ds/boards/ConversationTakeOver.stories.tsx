import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { Composer } from '../components/Composer/Composer.tsx';
import { ConceptFooter } from '../components/ConceptFooter/ConceptFooter.tsx';
import { Pill } from '../components/Pill/Pill.tsx';
import { TakeOverBar } from '../components/TakeOverBar/TakeOverBar.tsx';
import { Transcript } from '../components/Transcript/Transcript.tsx';
import { TranscriptHeader } from '../components/TranscriptRow/TranscriptRow.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { CONVERSATION_LIST, ConversationsPage, PUBLIC_LINK, RiveraFrame, TurnRows, type ListedConversation } from './parts.tsx';
import { SPEC, expectConversationType, expectFooter, expectOwnerFrame, expectReceiptsUnderMessages, expectTabOrder, one } from './spec.ts';

const lucia = rivera.conversations.lucia;
const OWNER = rivera.business.ownerName;

/** Claude's translations of what Lucía wrote, as the owner's screen shows them under her words. */
const TRANSLATIONS = Object.fromEntries(
  lucia.turns.flatMap((turn, index) => {
    const english: Record<string, string> = {
      '¿Cuánto cuesta destapar el desagüe del fregadero?': 'How much to unclog the sink drain?',
      '¿Puedo hablar con Maria? También gotea la llave de paso.': 'Can I talk to Maria? The shut-off valve is dripping too.',
      'Perfecto. ¿Cuándo pueden venir?': 'Perfect. When can you come?',
    };
    return turn.kind === 'visitor' && english[turn.text] ? [[index, english[turn.text]]] : [];
  }),
) as Record<number, string>;

/** The list with Lucía's chat open: Maria is in it. */
const LIST: ListedConversation[] = [
  { name: lucia.name, time: '12:22 pm', status: { tone: 'info', text: 'You’re in this chat' } },
  ...CONVERSATION_LIST.filter((item) => item.name !== lucia.name),
];

/** Lucía's chat after Maria took it over: her own message, the bar to hand back, her composer. */
function ConversationTakeOver() {
  return (
    <RiveraFrame
      current="conversations"
      fill
      twoDesks
      counts={{ conversations: { n: 1, label: '1 live conversation' }, safety: { n: 2, label: '2 blocked' } }}
    >
      <ConversationsPage open={lucia.name} items={LIST}>
        <div className="board-conversation">
          <header className="board-conversation-head">
            <h2 className="board-conversation-head__name cd-type-control" data-copy="user">
              {lucia.name}
            </h2>
            <Pill>Public</Pill>
            <p className="board-conversation-head__latest cd-type-meta">In Spanish. You took over at 12:31 pm.</p>
          </header>
          <Transcript label={`Conversation with ${lucia.name}`}>
            <TranscriptHeader
              left={`Today at 12:20 pm, web chat from ${PUBLIC_LINK}`}
              right="Notes from the checks sit under each message. Select one for the full trace."
            />
            <TurnRows turns={lucia.turns} onOpenTrace={fn()} translations={TRANSLATIONS} />
          </Transcript>
          <TakeOverBar mode="owner" visitorName={lucia.name} ownerName={OWNER} onTakeOver={fn()} onHandBack={fn()} onResume={fn()} />
          <Composer variant="owner" label={`Message ${lucia.name}`} placeholder="Write to Lucía" onSend={fn()} />
          <ConceptFooter />
        </div>
      </ConversationsPage>
    </RiveraFrame>
  );
}

const meta = {
  title: 'Boards/Conversation, taken over',
  render: () => <ConversationTakeOver />,
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Conv-TakeOver',
    canvasNote: [
      'The page follows the signed conversation boards (N-Conv-Run1): the list in its column at the sidebar’s seam and receipts under each message, where this earlier board draws a row of conversations across the top and a margin column.',
      'The conversation is the Rivera fixture’s chat with Lucía, from her question through the callback to Maria’s message, where the board starts at her ask for Maria and folds the quote into a line.',
      'Maria’s own message shows as it was delivered, in Spanish, under her name and initials, where the board labels it “You” with no initials: PersonMessage draws initials from the name it is given, so “You” would draw a “Y”. The board’s English original with “Lucía saw:” under it, and the translated composer line, are static vision. So is “Claude suggests”, with its reply to use.',
      'Maria joining is a status line with her initials and no time, as no contract carries one; Hand back to Claude sits above the composer, where the board puts it beside the composer.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expectOwnerFrame(canvasElement, 'Conversations', { fill: true });
    const list = canvas.getByRole('navigation', { name: 'Conversations' });
    await expect(within(list).getByRole('link', { current: true })).toHaveTextContent(lucia.name);

    // The conversation: receipts under their messages, Lucía's words with Claude's translation.
    const log = canvas.getByRole('log', { name: `Conversation with ${lucia.name}` });
    expectConversationType(log);
    await expect(await expectReceiptsUnderMessages(log)).toBeGreaterThanOrEqual(3);
    await expect(within(log).getByText('Perfect. When can you come?')).toBeVisible();

    // Maria joined: a status line, with no time.
    const joined = within(log)
      .getAllByRole('status')
      .find((line) => line.textContent?.includes(`${OWNER} joined the chat`));
    await expect(joined).toBeDefined();
    await expect(joined?.textContent).not.toMatch(/\d/);

    // Her own message, in a person's frame, under her name.
    const mine = one(log, '.cd-person-message');
    await expect(within(mine).getByText(OWNER, { exact: true })).toBeVisible();

    // Owner mode: Hand back to Claude, then her composer.
    const handBack = canvas.getByRole('button', { name: 'Hand back to Claude' });
    const composer = canvas.getByRole('textbox', { name: `Message ${lucia.name}` });
    await expect(composer.getBoundingClientRect().top).toBeGreaterThan(handBack.getBoundingClientRect().bottom);
    expectComputed(one(canvasElement, '.cd-composer__box'), SPEC.composer);
    await expectFooter(canvasElement);

    // focus_order_is_logical: the sidebar, the list, the receipts, Hand back to Claude, then the composer.
    const column = canvas.getByRole('complementary', { name: 'Claude Desk' });
    await expectTabOrder(userEvent, [
      within(column).getByRole('button', { name: `Switch business, current: ${rivera.business.name}` }),
      ...within(within(column).getByRole('navigation', { name: 'Main' })).getAllByRole('link'),
      ...within(list).getAllByRole('link'),
      ...within(log).getAllByRole('button', { name: /Open the full trace/ }),
      handBack,
      composer,
    ]);
  },
};
