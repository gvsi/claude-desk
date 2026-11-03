import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { Button } from '../components/Button/Button.tsx';
import { Composer } from '../components/Composer/Composer.tsx';
import { ConceptFooter } from '../components/ConceptFooter/ConceptFooter.tsx';
import { ConversationListItem } from '../components/ConversationListItem/ConversationListItem.tsx';
import { PageHeader } from '../components/PageHeader/PageHeader.tsx';
import { Pill } from '../components/Pill/Pill.tsx';
import { StatusLabel } from '../components/StatusDot/StatusDot.tsx';
import { TakeOverBar } from '../components/TakeOverBar/TakeOverBar.tsx';
import { TextLink } from '../components/TextLink/TextLink.tsx';
import { Transcript } from '../components/Transcript/Transcript.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { RiveraFrame, TurnRows, type ListedConversation } from './parts.tsx';
import { SPEC, expectConversationType, expectFooter, expectOwnerFrame, expectReceiptsUnderMessages, expectTabOrder, one } from './spec.ts';

const lucia = rivera.conversations.lucia;
const OWNER = rivera.business.ownerName;
/** From Lucía asking for Mike on; her question and the quote before it fold into one line. */
const FROM = lucia.turns.findIndex((turn) => turn.kind === 'visitor' && turn.text.startsWith('¿Puedo hablar con Mike?'));
const shown = lucia.turns.slice(FROM);

/** Claude's translations of what Lucía wrote, as the owner's screen shows them under her words. */
const ENGLISH: Record<string, string> = {
  '¿Puedo hablar con Mike? También gotea la llave de paso.': 'Can I talk to Mike? The shut-off valve is dripping too.',
  'Perfecto. ¿Cuándo pueden venir?': 'Perfect. When can you come?',
};
const TRANSLATIONS = Object.fromEntries(
  shown.flatMap((turn, index) => (turn.kind === 'visitor' && ENGLISH[turn.text] ? [[index, ENGLISH[turn.text]]] : [])),
) as Record<number, string>;

/** Today's conversations across the top, as the board lists them, Lucía's open. */
const STRIP: ListedConversation[] = [
  { name: lucia.name, time: '12:22', status: { tone: 'info', text: 'You’re in this chat' } },
  { name: rivera.people.dana.name, time: '12:04', status: { tone: 'handled', text: 'Booked Thu 10:30' } },
  { name: 'Visitor in Berkeley', time: '10:58', status: { tone: 'held', text: 'Needs you, 50% off for cash' } },
  { name: rivera.conversations.alexAgent.name, time: '11:42', status: { tone: 'handled', text: 'Agent, booked Thu 9:00' } },
];

/** Lucía's chat after Mike took it over: his own messages as "You", the bar to hand back, his composer. */
function ConversationTakeOver() {
  return (
    <RiveraFrame
      current="conversations"
      twoDesks
      counts={{ conversations: { n: 1, label: '1 live conversation' }, safety: { n: 2, label: '2 blocked' } }}
    >
      <div className="board-takeover">
        <PageHeader title="Conversations" actions={<p className="board-takeover__count board-quiet cd-type-meta">10 today, 1 live</p>} />
        <nav className="board-takeover__strip" aria-label="Today’s conversations">
          <ul>
            {STRIP.map((item) => (
              <li key={item.name}>
                <ConversationListItem {...item} href={`#conversation-${item.time}`} current={item.name === lucia.name} />
              </li>
            ))}
          </ul>
          <span className="cd-type-meta">
            <TextLink href="#conversations-today">All 10 today</TextLink>
          </span>
        </nav>
        <div className="board-takeover__chat">
          <header className="board-conversation-head">
            <h2 className="board-conversation-head__name cd-type-section" data-copy="user">
              {lucia.name}
            </h2>
            <Pill>Public</Pill>
            <span className="board-conversation-head__latest cd-type-caption">
              <StatusLabel tone="info">In Spanish, you took over at 12:31</StatusLabel>
            </span>
            <span className="board-conversation-head__end">
              <Button variant="ghost" onClick={fn()}>
                Hide translations
              </Button>
            </span>
          </header>
          <p className="board-quiet cd-type-meta">
            Earlier, Claude quoted a drain clearing. <TextLink href="#earlier">Show 2 messages</TextLink>
          </p>
          <div className="board-takeover__reading">
            <Transcript label={`Conversation with ${lucia.name}`}>
              <TurnRows turns={shown} onOpenTrace={fn()} translations={TRANSLATIONS} ownersOwnScreen />
            </Transcript>
            <TakeOverBar mode="owner" visitorName={lucia.name} ownerName={OWNER} onTakeOver={fn()} onHandBack={fn()} onResume={fn()} />
            <Composer variant="owner" label={`Message ${lucia.name}`} placeholder="Write to Lucía" onSend={fn()} />
            <ConceptFooter />
          </div>
        </div>
      </div>
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
      'The board’s page: the title with the day’s count, today’s conversations across the top, the open chat’s head across the page, then its messages in the reading column. Receipts sit under each message, signed after this board, where it draws a margin column.',
      'The chat is the Turner fixture’s with Lucía from her ask for Mike: a callback, then Mike’s message, shown as it was delivered, in Spanish, under “You” beside his initials. The board’s folded line names a garbage disposal quote; the board’s English original with “Lucía saw:”, the translated composer line and “Claude suggests” with its reply to use are static vision.',
      'Mike joining is a status line with his initials and no time, as no contract carries one; Hand back to Claude sits above the composer, as TakeOverBar places it, where the board puts it beside the composer, in the margin column.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    // The padded page, its sidebar on the panel, as this board draws it.
    await expectOwnerFrame(canvasElement, 'Conversations');
    expectComputed(canvas.getByRole('heading', { level: 1, name: 'Conversations' }), SPEC.pageTitle);
    // The open conversation's name, in the section style the board sets it in.
    expectComputed(canvas.getByRole('heading', { level: 2, name: lucia.name }), { fontSize: '16px', lineHeight: '21px', fontWeight: '520' });

    // Today's conversations in one row across the top, Lucía's open.
    const strip = canvas.getByRole('navigation', { name: 'Today’s conversations' });
    const items = within(strip).getAllByRole('link');
    await expect(new Set(items.slice(0, STRIP.length).map((item) => Math.round(item.getBoundingClientRect().top))).size).toBe(1);
    await expect(within(strip).getByRole('link', { current: true })).toHaveTextContent(lucia.name);

    // The conversation: receipts under their messages, Lucía's words with Claude's translation.
    const log = canvas.getByRole('log', { name: `Conversation with ${lucia.name}` });
    expectConversationType(log);
    await expect(await expectReceiptsUnderMessages(log)).toBeGreaterThanOrEqual(3);
    await expect(within(log).getByText('Perfect. When can you come?')).toBeVisible();

    // Mike joined: a status line, with no time.
    const joined = within(log)
      .getAllByRole('status')
      .find((line) => line.textContent?.includes(`${OWNER} joined the chat`));
    await expect(joined).toBeDefined();
    await expect(joined?.textContent).not.toMatch(/\d/);

    // His own message reads "You", beside his own initials, hidden from screen readers.
    const mine = one(log, '.cd-person-message');
    await expect(within(mine).getByText('You', { exact: true })).toBeVisible();
    const avatar = one(mine, '.cd-person-message__avatar');
    await expect(avatar).toHaveAttribute('aria-hidden', 'true');
    await expect(avatar.textContent).toBe('MT');

    // Owner mode: Hand back to Claude, then her composer.
    const handBack = canvas.getByRole('button', { name: 'Hand back to Claude' });
    const composer = canvas.getByRole('textbox', { name: `Message ${lucia.name}` });
    await expect(composer.getBoundingClientRect().top).toBeGreaterThan(handBack.getBoundingClientRect().bottom);
    expectComputed(one(canvasElement, '.cd-composer__box'), SPEC.composer);
    await expectFooter(canvasElement);

    // focus_order_is_logical: the sidebar, the strip, the chat's controls, the receipts, Hand back, the composer.
    const column = canvas.getByRole('complementary', { name: 'Claude Desk' });
    await expectTabOrder(userEvent, [
      within(column).getByRole('button', { name: `Switch business, current: ${rivera.business.name}` }),
      within(column).getByRole('button', { name: 'Switch Desk, current: Main line' }),
      ...within(within(column).getByRole('navigation', { name: 'Main' })).getAllByRole('link'),
      ...items,
      canvas.getByRole('button', { name: 'Hide translations' }),
      canvas.getByRole('link', { name: 'Show 2 messages' }),
      ...within(log).getAllByRole('button', { name: /Open the full trace/ }),
      handBack,
      composer,
    ]);
  },
};
