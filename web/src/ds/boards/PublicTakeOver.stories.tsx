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

/** The chat head's line while Maria is in the chat, in place of the disclosure. */
const OWNER_IN_CHAT = `${OWNER} is in this chat. Claude, an AI, is paused until ${OWNER} hands it back.`;

/** The handoff: the kernel passed Dana's ask to Maria, and the visitor gets the handoff card. */
const handoff = rivera.events.heldTurn.find((event: SseEvent): event is EvMessage => event.type === 'message');
if (!handoff) throw new Error('the Rivera fixture has no handoff reply');

/** Dana asks for Maria, then Maria joins and writes, as the take-over stream delivers it; she hasn't handed back. */
const TURNS: TranscriptTurn[] = [
  { kind: 'visitor', text: `I'd like to talk to ${OWNER}.` },
  { kind: 'event', event: handoff },
  ...rivera.events.takeOver.flatMap((event): TranscriptTurn[] => (event.type === 'owner_left' ? [] : [{ kind: 'event', event }])),
];

/** Dana's public page while Maria is in the chat. */
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
      composer={<Composer variant="visitor" label="Message Rivera Plumbing" placeholder="Message Rivera Plumbing" maxLength={2000} onSend={fn()} />}
    >
      <Transcript label="Conversation with Rivera Plumbing">
        <TurnRows turns={TURNS} />
      </Transcript>
      <FollowTheChat />
    </PublicShell>
  );
}

const meta = {
  title: 'Boards/Maria in the chat',
  render: () => <PublicTakeOver />,
  parameters: {
    layout: 'fullscreen',
    canvasNote: [
      'Take-over option A, signed on 2026-10-30: while Maria is in the chat, the chat head says so and that Claude, an AI, is paused until she hands it back, on the disclosure’s line, and Ask for Maria isn’t shown.',
      'Built from the signed option; its render and the by-eye comparison are tracked in issue #230.',
      'The conversation is the Rivera fixture’s: Dana asks for Maria, the kernel’s handoff card with its receipt, then the take-over’s events (Maria joins, and her words under her name), with its end kept above the composer as the page keeps it; the about column shows the charter’s cards, and the header the kernel’s open status.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The public page at the board's window while Maria is in the chat: the chat head's line in place of
 * the disclosure, both names marked as written by someone, no Ask for Maria, the line that says she
 * joined and her words under the head, receipts under their messages, and Tab going from the
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

  // Under the head: the line that says Maria joined, with her initials and no time, then her words.
  const log = within(main).getByRole('log', { name: 'Conversation with Rivera Plumbing' });
  const joined = within(log)
    .getAllByRole('status')
    .find((status) => status.textContent?.includes(`${OWNER} joined the chat`));
  if (!joined) throw new Error('no line that says Maria joined');
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

  // focus_order_is_logical: the conversation, then the composer, and never an Ask for Maria.
  const reached = await expectTabOrder(user, [
    within(main).getByRole('group', { name: 'Chat with Rivera Plumbing' }),
    within(main).getByRole('textbox', { name: 'Message Rivera Plumbing' }),
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
    await expect(within(canvasElement).getByRole('complementary', { name: 'About Rivera Plumbing' })).toBeVisible();
  },
};

export const Phone: Story = {
  // Drawn at a phone's window, so the play measures it there.
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'N-R2-TakeOver-A-390-EN' },
  play: async ({ canvasElement, userEvent }) => {
    await expectMariaInTheChat(canvasElement, userEvent, [390, 844]);
    // Nothing reaches past the phone's edge: the head's line wraps inside it.
    for (const el of canvasElement.querySelectorAll('.cd-public-shell *')) {
      await expect(el.getBoundingClientRect().right).toBeLessThanOrEqual(390.5);
    }
  },
};
