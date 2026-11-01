import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { Composer } from '../components/Composer/Composer.tsx';
import { PublicShell } from '../components/PublicShell/PublicShell.tsx';
import { Transcript } from '../components/Transcript/Transcript.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { OPEN_NOW, TurnRows, brandOf } from './parts.tsx';
import { SPEC, expectConversationType, expectFooter, expectReceiptsUnderMessages, expectTabOrder, one, some } from './spec.ts';

const DISCLOSURE = "You're chatting with Claude, an AI answering for Turner Plumbing. Ask for Mike Turner anytime.";
/** Dana's chat as she sees it: her messages and Claude's checked replies, without Mike's whisper. */
const visitorTurns = rivera.conversations.danaLive.turns.filter((turn) => turn.kind !== 'whisper');

function PublicBooked() {
  return (
    <PublicShell
      brand={brandOf(rivera.publicDesk.en)}
      ownerName={rivera.business.ownerName}
      language="en"
      openStatus={OPEN_NOW}
      onAskForOwner={fn()}
      about={rivera.publicDesk.en.charter}
      composer={<Composer variant="visitor" label="Message Turner Plumbing" placeholder="Message Turner Plumbing" maxLength={2000} onSend={fn()} />}
    >
      <Transcript label="Conversation with Turner Plumbing">
        <TurnRows turns={visitorTurns} checks={['dec-dana-book']} />
      </Transcript>
    </PublicShell>
  );
}

const meta = {
  title: 'Boards/Public page, booked',
  render: () => <PublicBooked />,
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Public-Rivera-Run1',
    canvasNote: [
      "The chat is the Turner fixture's with Dana, from her question to the booking, where the board ends with a discount held for Mike and a way to cancel it.",
      'The visitor reads the kernel’s status lines, read-only, attached under each message: each action’s line, then the reply check, where the board lists the reply check first.',
      'The about column shows the whole charter, five cards, where the board shows three; the header’s phone is the contact card.',
      '"Open now, until 6:00 pm" is the kernel’s open status, shown as written at the right of the header, where the board marks it pending in a dashed box.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    // The brand header: 76 px high, padded 12 px 40 px (the signed open-status board grows it by
    // that padding when the status wraps), the kernel's open status at the right.
    const header = canvas.getByRole('banner');
    expectComputed(header, { height: '76px', paddingTop: '12px', paddingRight: '40px', paddingBottom: '12px', paddingLeft: '40px' });
    const status = within(header).getByText(OPEN_NOW.text);
    const name = within(header).getByRole('heading', { level: 1, name: 'Turner Plumbing' });
    await expect(status.getBoundingClientRect().left).toBeGreaterThan(name.getBoundingClientRect().right);

    // The AI disclosure, under the chat's title.
    const main = canvas.getByRole('main');
    const disclosure = [...main.querySelectorAll('p')].filter((line) => line.textContent === DISCLOSURE);
    await expect(disclosure).toHaveLength(1);
    await expect(disclosure[0]).toBeVisible();

    // The booking arrives as a booking_confirmed card; Claude's words are serif, Dana's in bubbles.
    const log = within(main).getByRole('log', { name: 'Conversation with Turner Plumbing' });
    expectConversationType(log);
    const booked = some(log, '.cd-reply-card').find((card) => card.textContent?.startsWith('Booked'));
    await expect(booked).toHaveTextContent(rivera.blocks.booking_confirmed.en.title ?? '');

    // Visitor receipts: read-only lines under their message, the rows filling the chat column.
    await expect(await expectReceiptsUnderMessages(log)).toBeGreaterThanOrEqual(3);
    await expect(log.querySelector('.cd-transcript-row__margin button')).toBeNull();
    const composerBox = one(main, '.cd-composer__box');
    expectComputed(composerBox, SPEC.composer);
    for (const row of log.querySelectorAll<HTMLElement>('.cd-transcript-row')) {
      await expect(row.getBoundingClientRect().width).toBe(composerBox.getBoundingClientRect().width);
    }
    await expectFooter(canvasElement);

    // focus_order_is_logical: Ask for Mike Turner, then the composer.
    await expectTabOrder(userEvent, [
      within(main).getByRole('button', { name: 'Ask for Mike Turner' }),
      within(main).getByRole('textbox', { name: 'Message Turner Plumbing' }),
    ]);
  },
};
