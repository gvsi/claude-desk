import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import type { EvMessage, SseEvent } from '../../api/contracts.ts';
import { Composer } from '../components/Composer/Composer.tsx';
import { ConceptFooter } from '../components/ConceptFooter/ConceptFooter.tsx';
import { PublicShell } from '../components/PublicShell/PublicShell.tsx';
import { Transcript } from '../components/Transcript/Transcript.tsx';
import type { TranscriptTurn } from '../fixtures/index.ts';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { OPEN_NOW, TurnRows, brandOf, checkedReply } from './parts.tsx';
import { SPEC, expectConversationType, expectReceiptsUnderMessages, expectTabOrder, one } from './spec.ts';

const OWNER = rivera.business.ownerName;
const ASK = `I'd like to talk to ${OWNER}.`;

/** The handoff: the kernel passed Dana's ask to Maria, and the visitor gets the handoff card. */
const handoff = rivera.events.heldTurn.find((event: SseEvent): event is EvMessage => event.type === 'message');
/** Maria joins and writes, as the take-over stream delivers it. */
const takeOver = rivera.events.takeOver.flatMap((event): TranscriptTurn[] => (event.type === 'owner_left' ? [] : [{ kind: 'event', event }]));
if (!handoff) throw new Error('the Rivera fixture has no handoff reply');

const STATES = {
  joins: {
    label: 'If Maria can join',
    turns: [
      { kind: 'visitor', text: ASK },
      { kind: 'event', event: handoff },
      ...takeOver,
      { kind: 'visitor', text: 'Perfect, thank you. When can you come by?' },
    ],
  },
  busy: {
    label: 'If Maria is busy',
    turns: [
      { kind: 'visitor', text: ASK },
      { kind: 'event', event: handoff },
      { kind: 'visitor', text: 'Can you call me back?' },
      { kind: 'event', event: checkedReply('msg-callback-ask', [rivera.blocks.prose.callbackAsk.en], 51) },
      { kind: 'visitor', text: 'Dana Whitfield, (510) 555-0163.' },
      {
        kind: 'event',
        event: checkedReply('msg-callback-set', [rivera.blocks.prose.thanks.en, rivera.blocks.callback_confirmed.en], 53),
      },
    ],
  },
} satisfies Record<string, { label: string; turns: TranscriptTurn[] }>;

/** One state of Dana's page: the public page, embedded so the two states share one document. */
function State({ label, turns }: { label: string; turns: readonly TranscriptTurn[] }) {
  return (
    <section className="board-handoff__state" aria-label={label}>
      <PublicShell
        brand={brandOf(rivera.publicDesk.en)}
        ownerName={OWNER}
        language="en"
        openStatus={OPEN_NOW}
        onAskForOwner={fn()}
        footer={false}
        composer={<Composer variant="visitor" label="Message Rivera Plumbing" placeholder="Message Rivera Plumbing" maxLength={2000} onSend={fn()} />}
      >
        <Transcript label="Conversation with Rivera Plumbing">
          <TurnRows turns={turns} />
        </Transcript>
      </PublicShell>
    </section>
  );
}

function PublicHandoff() {
  return (
    <main className="board-handoff">
      <h1 className="cd-sr-only">Ask for Maria</h1>
      <State {...STATES.joins} />
      <State {...STATES.busy} />
      <div className="board-handoff__footer">
        <ConceptFooter poweredBy />
      </div>
    </main>
  );
}

const meta = {
  title: 'Boards/Ask for Maria',
  render: () => <PublicHandoff />,
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Public-Handoff-Run1',
    canvasNote: [
      'Both states side by side, as on the board: Maria joins and answers, or she is busy and Claude sets a callback.',
      'One document can’t hold two pages’ landmarks, so each state is the public page embedded (PublicShell footer={false}) and the concept footer shows once under both, where the board draws it under each.',
      'The board’s first exchange about the water heater is left out; each state starts with Dana asking for Maria, and the handoff card is the kernel’s, with its receipt. Maria’s message is the fixture’s, where the board has her greet Dana first.',
      'The board labels each state in its header; here each is a region named for its state, and the header keeps the kernel’s open status.',
      'At 640 px each state keeps the shell’s 40 px sides, where the board draws 16 px: the shell takes 16 px gutters below 640 px, where the open status also moves under the name, as the signed open-status board draws a phone.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    for (const state of Object.values(STATES)) {
      const page = canvas.getByRole('region', { name: state.label });
      // The disclosure, the brand header's height, and the visitor's read-only receipts under each message.
      await expect(page).toHaveTextContent('Claude, an AI answering for Rivera Plumbing');
      // Each state is the board's 640 px: the shell's wide header, 76 px high, 40 px in at the sides.
      await expect(page.getBoundingClientRect().width).toBe(640);
      expectComputed(one(page, '.cd-public-shell__brand'), { height: '76px', paddingLeft: '40px', paddingRight: '40px' });
      const log = within(page).getByRole('log', { name: 'Conversation with Rivera Plumbing' });
      expectConversationType(log);
      await expect(await expectReceiptsUnderMessages(log)).toBeGreaterThanOrEqual(1);
      await expect(log.querySelector('.cd-transcript-row__margin button')).toBeNull();
      expectComputed(one(page, '.cd-composer__box'), SPEC.composer);
    }

    // Maria joins: a status line with her initials and no time, then her words under her name.
    const joins = canvas.getByRole('region', { name: STATES.joins.label });
    const joined = within(joins)
      .getAllByRole('status')
      .find((line) => line.textContent?.includes(`${OWNER} joined the chat`));
    await expect(joined).toBeDefined();
    await expect(joined?.textContent).not.toMatch(/\d/);
    await expect(joins.querySelector('.cd-person-message')).not.toBeNull();

    // She is busy: Claude asks for a name and number, and the callback arrives as its card.
    const busy = canvas.getByRole('region', { name: STATES.busy.label });
    await expect(busy).toHaveTextContent(rivera.blocks.callback_confirmed.en.title ?? '');
    await expect(canvasElement.querySelectorAll('[data-ds="concept-footer"]')).toHaveLength(1);

    // focus_order_is_logical: in each state, Ask for Maria Rivera, then the composer.
    await expectTabOrder(userEvent, [
      within(joins).getByRole('button', { name: 'Ask for Maria Rivera' }),
      within(joins).getByRole('textbox', { name: 'Message Rivera Plumbing' }),
      within(busy).getByRole('button', { name: 'Ask for Maria Rivera' }),
      within(busy).getByRole('textbox', { name: 'Message Rivera Plumbing' }),
    ]);
  },
};
