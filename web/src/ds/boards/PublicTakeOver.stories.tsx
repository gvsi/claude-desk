import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import type { EvMessage, SseEvent } from '../../api/contracts.ts';
import { Composer } from '../components/Composer/Composer.tsx';
import { PublicShell } from '../components/PublicShell/PublicShell.tsx';
import { Transcript } from '../components/Transcript/Transcript.tsx';
import type { TranscriptTurn } from '../fixtures/index.ts';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { FollowTheChat } from '../test/followTheChat.tsx';
import { OPEN_NOW, TurnRows, brandOf } from './parts.tsx';
import { SPEC, expectConversationType, expectFooter, expectReceiptsUnderMessages, expectTabOrder, one } from './spec.ts';

const OWNER = rivera.business.ownerName;

/** The chat head's line while Mike is in the chat, in place of the disclosure. */
const OWNER_IN_CHAT = `${OWNER} is in this chat. Claude, an AI, is paused until ${OWNER} hands it back.`;

/** The handoff: the kernel passed Dana's ask to Mike, and the visitor gets the handoff card. */
const handoff = rivera.events.heldTurn.find((event: SseEvent): event is EvMessage => event.type === 'message');
if (!handoff) throw new Error('the Turner fixture has no handoff reply');

/** Dana asks for Mike, then Mike joins and writes, as the take-over stream delivers it; he hasn't handed back. */
const TURNS: TranscriptTurn[] = [
  { kind: 'visitor', text: `I'd like to talk to ${OWNER}.` },
  { kind: 'event', event: handoff },
  ...rivera.events.takeOver.flatMap((event): TranscriptTurn[] => (event.type === 'owner_left' ? [] : [{ kind: 'event', event }])),
];

/** Dana's public page while Mike is in the chat. */
function PublicTakeOver() {
  return (
    <PublicShell
      brand={brandOf(rivera.publicDesk.en)}
      ownerName={OWNER}
      language="en"
      openStatus={OPEN_NOW}
      ownerInChat
      onAskForOwner={fn()}
      about={rivera.publicDesk.en.charter}
      composer={<Composer variant="visitor" label="Message Turner Plumbing" placeholder="Message Turner Plumbing" maxLength={2000} onSend={fn()} />}
    >
      <Transcript label="Conversation with Turner Plumbing">
        <TurnRows turns={TURNS} />
      </Transcript>
      <FollowTheChat />
    </PublicShell>
  );
}

const meta = {
  title: 'Boards/Mike in the chat',
  render: () => <PublicTakeOver />,
  parameters: {
    layout: 'fullscreen',
    canvasNote: [
      'Take-over option A, signed on 2026-10-30: while Mike is in the chat, the chat head says so and that Claude, an AI, is paused until he hands it back, on the disclosure’s line, and Ask for Mike isn’t shown.',
      'Built from the signed option; its render and the by-eye comparison are tracked in issue #230.',
      'The conversation is the Turner fixture’s: Dana asks for Mike, the kernel’s handoff card with its receipt, then the take-over’s events (Mike joins, and his words under his name), with its end kept above the composer as the page keeps it; the about column shows the charter’s cards, and the header the kernel’s open status.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The public page at the board's window while Mike is in the chat: the chat head's line in place of
 * the disclosure, both names marked as written by someone, no Ask for Mike, the line that says he
 * joined and his words under the head, receipts under their messages, and Tab going from the
 * conversation to the composer.
 */
async function expectMariaInTheChat(root: HTMLElement, user: { tab: () => Promise<void> }, [width, height]: readonly [number, number]): Promise<void> {
  await expect([window.innerWidth, window.innerHeight]).toEqual([width, height]);
  // The page is the window, and nothing scrolls sideways.
  await expect(Math.round(one(root, '.cd-public-shell').getBoundingClientRect().height)).toBe(height);
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const gutter = width < 720 ? '16px' : '40px';
  expectComputed(one(root, '.cd-public-shell__brand'), { paddingLeft: gutter, paddingRight: gutter, borderBottomWidth: '2px' });

  const main = within(root).getByRole('main');
  const head = one(main, '.cd-public-shell__chat-head');
  const line = one(head, '.cd-public-shell__disclosure');
  await expect(line.textContent).toBe(OWNER_IN_CHAT);
  await expect([...line.querySelectorAll('[data-copy="user"]')].map((name) => name.textContent)).toEqual([OWNER, OWNER]);
  expectComputed(line, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });
  await expect(within(root).queryByRole('button', { name: `Ask for ${OWNER}` })).toBeNull();
  await expect(head.querySelectorAll('button')).toHaveLength(0);

  // Under the head: the line that says Mike joined, with his initials and no time, then his words.
  const log = within(main).getByRole('log', { name: 'Conversation with Turner Plumbing' });
  const joined = within(log)
    .getAllByRole('status')
    .find((status) => status.textContent?.includes(`${OWNER} joined the chat`));
  if (!joined) throw new Error('no line that says Mike joined');
  await expect(joined.textContent).not.toMatch(/\d/);
  const said = one(log, '.cd-person-message');
  await expect(joined.getBoundingClientRect().top).toBeGreaterThanOrEqual(head.getBoundingClientRect().bottom);
  await expect(said.getBoundingClientRect().top).toBeGreaterThan(joined.getBoundingClientRect().bottom);
  // Both in view, between the head and the composer, where the page keeps the end of the chat.
  await expect(said.getBoundingClientRect().bottom).toBeLessThanOrEqual(one(main, '.cd-public-shell__composer').getBoundingClientRect().top);
  expectConversationType(log);
  await expect(await expectReceiptsUnderMessages(log)).toBeGreaterThanOrEqual(2);
  await expect(log.querySelector('.cd-transcript-row__margin button')).toBeNull();
  expectComputed(one(main, '.cd-composer__box'), SPEC.composer);
  await expectFooter(root);

  // focus_order_is_logical: the conversation, then the composer, and never an Ask for Mike.
  const reached = await expectTabOrder(user, [
    within(main).getByRole('group', { name: 'Chat with Turner Plumbing' }),
    within(main).getByRole('textbox', { name: 'Message Turner Plumbing' }),
  ]);
  await expect(reached.filter((stop) => stop.textContent?.startsWith('Ask for'))).toEqual([]);
}

export const Laptop: Story = {
  // Drawn at a 14-inch laptop's window, so the play measures it there.
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: { canvas: 'N-R2-TakeOver-A-1512-EN' },
  play: async ({ canvasElement, userEvent }) => {
    await expectMariaInTheChat(canvasElement, userEvent, [1512, 982]);
    // The about column at the right of the chat, as ever.
    await expect(within(canvasElement).getByRole('complementary', { name: 'About Turner Plumbing' })).toBeVisible();
  },
};

export const Phone: Story = {
  // Drawn at a phone's window, so the play measures it there.
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'N-R2-TakeOver-A-390-EN' },
  play: async ({ canvasElement, userEvent }) => {
    await expectMariaInTheChat(canvasElement, userEvent, [390, 844]);
    // The chat scrolls here, so its end is kept as the page keeps it: the last row 24 px above the
    // composer area, the room the public chat leaves under the conversation.
    const rows = canvasElement.querySelectorAll<HTMLElement>('.cd-public-shell__conversation .cd-transcript-row');
    const last = rows[rows.length - 1];
    if (!last) throw new Error('no rows in the conversation');
    const area = one(canvasElement, '.cd-public-shell__composer');
    await expect(Math.round(area.getBoundingClientRect().top - last.getBoundingClientRect().bottom)).toBe(24);
    // Nothing reaches past the phone's edge: the head's line wraps inside it.
    for (const el of canvasElement.querySelectorAll('.cd-public-shell *')) {
      await expect(el.getBoundingClientRect().right).toBeLessThanOrEqual(390.5);
    }
  },
};
