import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, fn, within } from 'storybook/test';

import type { SseEvent } from '../../api/contracts.ts';
import '../../owner/today/Today.css';
import { DEMO_VISITOR_THING, THINGS_TO_TRY as IDEAS } from '../../owner/arrival/ideas.ts';
import { DEMO_VISITOR_NOTE, DEMO_VISITOR_PILL } from '../../owner/conversations/copy.ts';
import { TODAY_COPY } from '../../owner/today/copy.ts';
import { Button } from '../components/Button/Button.tsx';
import { Card } from '../components/Card/Card.tsx';
import { Composer } from '../components/Composer/Composer.tsx';
import { ConceptFooter } from '../components/ConceptFooter/ConceptFooter.tsx';
import { Notice } from '../components/Notice/Notice.tsx';
import { Pill } from '../components/Pill/Pill.tsx';
import { StatusDot } from '../components/StatusDot/StatusDot.tsx';
import { TakeOverBar } from '../components/TakeOverBar/TakeOverBar.tsx';
import { Transcript } from '../components/Transcript/Transcript.tsx';
import { TranscriptHeader, TranscriptRow } from '../components/TranscriptRow/TranscriptRow.tsx';
import { WritingIndicator } from '../components/WritingIndicator/WritingIndicator.tsx';
import { rivera, type TranscriptTurn } from '../fixtures/index.ts';
import { Icon, type IconName } from '../icons/index.tsx';
import { ConversationsPage, PUBLIC_LINK, RiveraFrame, TurnRows, type ListedConversation } from './parts.tsx';
import { expectFooter, expectOwnerFrame, one } from './spec.ts';

/**
 * The demo visitor, as the REV-DEMO boards draw it (in review; sign-off pending): Today's "Watch a
 * demo visitor" card and its start error, then its conversation while it chats, after a whisper,
 * after a take-over and once it has ended. Riley's chat is the Turner fixture's live chat (Dana's on
 * the Run 1 boards), as the boards draw it: a drain, a quote, a whisper, open times and a booking.
 */

const RILEY = 'Riley';
const OWNER = rivera.business.ownerName;
const OWNER_FIRST = OWNER.split(' ')[0]!;
const turns = rivera.conversations.danaLive.turns;
const WHISPER_CAPTION = 'Your whisper, 11:00 pm. Only Claude sees this.';
const TAKE_OVER_WORDS = "Hi Mike! Will you bring something for a deep clog? It's been slow for a week.";
const ownerJoined = { type: 'owner_joined', name: OWNER } satisfies SseEvent;

/** Up to and including the visitor's turn that starts with `words`. */
function through(words: string): TranscriptTurn[] {
  const at = turns.findIndex((turn) => turn.kind === 'visitor' && turn.text.startsWith(words));
  if (at === -1) throw new Error(`the Turner fixture changed: no visitor turn starting "${words}"`);
  return turns.slice(0, at + 1);
}

/** Up to and including the visitor's turn that starts with `words`, and every turn after it until the next visitor's. */
function answered(words: string): TranscriptTurn[] {
  const head = through(words);
  const rest = turns.slice(head.length);
  const next = rest.findIndex((turn) => turn.kind === 'visitor');
  return [...head, ...(next === -1 ? rest : rest.slice(0, next))];
}

// ---------------------------------------------------------------------------------------------
// Today

interface Thing {
  title: string;
  detail: ReactNode;
  icon: IconName;
  step: string;
  /** The detail says a start failed: an alert, after a refused dot. */
  failed?: boolean;
  held?: boolean;
  link?: boolean;
}

const [CHAT, BREAK, ANSWER, CREATE] = IDEAS;

/**
 * "Try to break it" and the held row in the REV-DEMO boards' own words. The web app's Today words
 * have since changed (#865, #867); the stories' `canvasNote` says how.
 */
const BOARD_BREAK = ["Ask for a discount, another customer's address or ", "'s home number. Safety shows what was stopped and why."] as const;
const BOARD_HELD_BY = 'Held by your rule: ';

function things(failed: boolean): Thing[] {
  return [
    { title: CHAT.title, detail: TODAY_COPY.chatDetail, icon: 'conversations', step: 'Open your public page', link: true },
    { title: DEMO_VISITOR_THING.title, detail: failed ? DEMO_VISITOR_THING.startFailed : DEMO_VISITOR_THING.detail, icon: DEMO_VISITOR_THING.icon, step: DEMO_VISITOR_THING.start, failed },
    {
      title: BREAK.title,
      detail: (
        <>
          {BOARD_BREAK[0]}
          <span data-copy="user">{OWNER_FIRST}</span>
          {BOARD_BREAK[1]}
        </>
      ),
      icon: 'safety',
      step: 'Show me ideas',
    },
    {
      title: ANSWER.title,
      detail: (
        <>
          {TODAY_COPY.waiting} {BOARD_HELD_BY}
          <span data-copy="user">{rivera.ruleCards['rv-quote'].reason}</span>
        </>
      ),
      icon: 'clock',
      step: 'Open the request',
      held: true,
    },
    { title: CREATE.title, detail: TODAY_COPY.createDetail, icon: 'plus', step: 'Start a Desk', link: true },
  ];
}

/** Today's "Things to try" as the web app draws it: five cards, three across from 1280 px. */
function DemoThings({ failed = false }: { failed?: boolean }) {
  return (
    <section className="cd-things" aria-labelledby="board-demo-things">
      <div className="cd-things__head">
        <div className="cd-things__head-line">
          <h2 id="board-demo-things" className="cd-things__title cd-type-section">
            Things to try
          </h2>
          <div className="cd-things__hide">
            <Button variant="ghost" onClick={fn()}>
              Hide this list
            </Button>
          </div>
        </div>
        <p className="cd-things__caption cd-type-meta">
          <span className="cd-things__caption-now">About 10 minutes. No real customer sees any of it.</span>
        </p>
      </div>
      <Card padding={16}>
        <ul className="cd-things__list">
          {things(failed).map((thing) => (
            <li key={thing.title} className="cd-things__item">
              <span className="cd-things__icon">
                <Icon name={thing.icon} size={16} />
              </span>
              <div className="cd-things__text">
                <h3 className="cd-things__item-title cd-type-control">
                  {thing.title}
                  {thing.held ? <StatusDot tone="held" /> : null}
                </h3>
                {thing.failed ? (
                  <p className="cd-things__detail cd-type-meta" role="alert">
                    <StatusDot tone="refused" />
                    {thing.detail}
                  </p>
                ) : (
                  <p className="cd-things__detail cd-type-meta">{thing.detail}</p>
                )}
              </div>
              <div className="cd-things__action">
                {thing.link ? (
                  <Button variant="secondary" href="#step">
                    {thing.step}
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={fn()}>
                    {thing.step}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

function TodayBoard({ failed = false }: { failed?: boolean }) {
  return (
    <RiveraFrame current="today" reviewer fill={false} counts={{ conversations: { n: 1, label: '1 needs you' }, safety: { n: 2, label: '2 blocked' } }}>
      <div className="board-demo-today">
        <DemoThings failed={failed} />
        <ConceptFooter />
      </div>
    </RiveraFrame>
  );
}

// ---------------------------------------------------------------------------------------------
// The conversation

const LIST_REST: ListedConversation[] = [
  { name: 'Visitor', time: '10:51 pm', quote: 'How much to clear a clogged drain? Can I get 15% off if I pay cash?', status: { tone: 'held', text: 'Needs you' } },
  { name: rivera.conversations.alexAgent.name, time: '10:24 pm', status: { tone: 'info', text: 'Agent · Deposit paid' } },
];

type Stage = 'chat' | 'whisper' | 'takeover' | 'ended';

const STAGES: Record<Stage, { shown: TranscriptTurn[]; latest: string; row: ListedConversation; note: 'running' | 'finished' }> = {
  chat: {
    shown: through('Yes please.'),
    latest: 'Quote sent, $180.00',
    row: { name: RILEY, time: '11:02 pm', demoVisitor: true, quote: "Yes please. Is anything sooner open? There's water on the floor.", status: { tone: 'handled', text: 'Quoted' } },
    note: 'running',
  },
  whisper: {
    shown: answered('Yes please.'),
    latest: 'Open times sent',
    row: { name: RILEY, time: '11:02 pm', demoVisitor: true, quote: "Yes please. Is anything sooner open? There's water on the floor.", status: { tone: 'handled', text: 'Quoted' } },
    note: 'running',
  },
  takeover: {
    shown: [...answered('Tuesday at 2 works.'), { kind: 'event', event: ownerJoined }, { kind: 'visitor', text: TAKE_OVER_WORDS }],
    latest: 'Visit booked',
    row: { name: RILEY, time: '11:04 pm', demoVisitor: true, quote: TAKE_OVER_WORDS, status: { tone: 'info', text: 'You’re in this chat' } },
    note: 'running',
  },
  ended: {
    shown: answered('Tuesday at 2 works.'),
    latest: 'Visit booked',
    row: { name: RILEY, time: '11:02 pm', demoVisitor: true, quote: 'Tuesday at 2 works.', status: { tone: 'handled', text: 'Booked' } },
    note: 'finished',
  },
};

/** Riley's conversation at `stage`: its head with both pills, the note 8 px under it, the chat, and the owner's controls. */
function DemoConversation({ stage }: { stage: Stage }) {
  const { shown, latest, note } = STAGES[stage];
  const owner = stage === 'takeover';
  return (
    <div className="board-conversation">
      <div className="board-demo-top">
        <header className="board-conversation-head">
          <h2 className="board-conversation-head__name cd-type-section" data-copy="user">
            {RILEY}
          </h2>
          <Pill>Public</Pill>
          <Pill>{DEMO_VISITOR_PILL}</Pill>
          <p className="board-conversation-head__latest cd-type-meta">Latest: {latest}</p>
        </header>
        {note === 'running' ? (
          <Notice
            tone="info"
            action={
              <Button variant="ghost" onClick={fn()}>
                {DEMO_VISITOR_NOTE.stop}
              </Button>
            }
          >
            {DEMO_VISITOR_NOTE.running}
          </Notice>
        ) : (
          <Notice tone="info">{DEMO_VISITOR_NOTE.finished}</Notice>
        )}
      </div>
      <Transcript label={`Conversation with ${RILEY}`}>
        <TranscriptHeader left={`Today at 10:58 pm, web chat from ${PUBLIC_LINK}`} right="Notes from the checks sit under each message. Select one for the full trace." />
        <TurnRows turns={shown} onOpenTrace={fn()} whisperCaption={WHISPER_CAPTION} checks={['dec-dana-book']} />
        {stage === 'chat' ? (
          <TranscriptRow>
            <WritingIndicator language="en" variant="bubble" who={RILEY} />
          </TranscriptRow>
        ) : null}
      </Transcript>
      {/* Once it has ended nobody is left to answer: no Take over and no whisper box. */}
      {note === 'finished' ? null : (
        <>
          <TakeOverBar mode={owner ? 'owner' : 'ai'} visitorName={RILEY} ownerName={OWNER} onTakeOver={fn()} onHandBack={fn()} onResume={fn()} />
          {owner ? (
            <Composer variant="owner" label="Write to them" placeholder="They see your words exactly as you write them." onSend={fn()} />
          ) : (
            <Composer variant="whisper" label="Whisper to Claude" placeholder="Whisper to Claude. They won't see it." onSend={fn()} />
          )}
        </>
      )}
      <ConceptFooter />
    </div>
  );
}

function ConversationBoard({ stage, phone = false }: { stage: Stage; phone?: boolean }) {
  const counts = { conversations: { n: 1, label: '1 needs you' }, safety: { n: 2, label: '2 blocked' } };
  if (phone) {
    return (
      <RiveraFrame current="conversations" reviewer counts={counts}>
        <DemoConversation stage={stage} />
      </RiveraFrame>
    );
  }
  return (
    <RiveraFrame current="conversations" reviewer fill counts={counts}>
      <ConversationsPage open={RILEY} items={[STAGES[stage].row, ...LIST_REST]}>
        <DemoConversation stage={stage} />
      </ConversationsPage>
    </RiveraFrame>
  );
}

// ---------------------------------------------------------------------------------------------

const IN_REVIEW = 'Built against the board in review; sign-off pending.';
/**
 * What the web app draws differently from the REV-DEMO conversation boards, which predate the pinned bar (REV-720 C).
 * The stories draw the boards as they are.
 */
const SINCE_THE_BAR =
  'The board predates the bar pinned to the top of the open conversation (REV-720 C). The web app draws "Demo visitor" in that bar, right after the level pill, and the note at the top of the transcript, 16 px under the bar and over its opening lines, so it scrolls away with them. The web app\'s take-over and whisper composers now show example placeholders, with a helper line under the take-over one (#905), where the board draws the older placeholder words.';

/** What the web app's Things to try draws differently from the REV-DEMO Today boards, by the owner's later choices. */
const SINCE_THE_CHOICES =
  "The other cards keep the board's words, where the web app's have since moved on: a hold past an automatic rule's limit has no “Held by your rule” line, since the held card's headline in Needs you already quotes that rule (owner decision, 2026-11-02, #671); “Try to break it” points at each reply's receipt, and a hold by a named rule reads “A request is waiting for your answer: {rule}.” (owner, 2026-11-02, #867).";

const meta = {
  title: 'Boards/Demo visitor',
  render: () => <TodayBoard />,
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Live-REV-DEMO-today-1512',
    canvasNote: [
      IN_REVIEW,
      'REV-DEMO entry A, Today › Things to try (#artboard-cdae4f209f2e): "Watch a demo visitor" second of five cards, three across from 1280 px.',
      'Only the band\'s Things to try is drawn; the greeting, How your Desk works, Needs you and the rest of Today are as the Today boards draw them.',
      SINCE_THE_CHOICES,
    ].join(' '),
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** The page is no wider than the window. */
async function expectNoSidewaysScroll(): Promise<void> {
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

/** The cards in rows of three: each row's tops level, every card the same width. */
async function expectThreeAcross(root: HTMLElement): Promise<HTMLElement[]> {
  const cards = [...root.querySelectorAll<HTMLElement>('.cd-things__item')];
  await expect(cards.map((card) => card.querySelector('h3')?.textContent)).toEqual([
    'Chat as a customer',
    'Watch a demo visitor',
    'Try to break it',
    'Answer a held request',
    'Create your own Desk',
  ]);
  const rects = cards.map((card) => card.getBoundingClientRect());
  for (const row of [rects.slice(0, 3), rects.slice(3)]) {
    for (const rect of row) await expect(Math.round(rect.top)).toBe(Math.round(row[0]!.top));
  }
  for (const rect of rects) await expect(Math.round(rect.width)).toBe(Math.round(rects[0]!.width));
  await expect(rects[3]!.top).toBeGreaterThan(rects[0]!.bottom);
  return cards;
}

export const ThingsToTry: Story = {
  play: async ({ canvasElement }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    await expectOwnerFrame(canvasElement, 'Today');
    const cards = await expectThreeAcross(canvasElement);
    const demo = within(cards[1]!);
    await expect(demo.getByText(DEMO_VISITOR_THING.detail)).toBeVisible();
    await expect(demo.getByRole('button', { name: DEMO_VISITOR_THING.start })).toBeVisible();
    await expectFooter(canvasElement);
    await expectNoSidewaysScroll();
  },
};

export const StartError: Story = {
  render: () => <TodayBoard failed />,
  parameters: {
    canvas: 'N-Live-REV-DEMO-error-1512',
    canvasNote: `${IN_REVIEW} REV-DEMO entry A, it couldn’t start (#artboard-d691001ca787): the card's line says so after a refused dot, as an alert, and the button stays. ${SINCE_THE_CHOICES}`,
  },
  play: async ({ canvasElement }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    const cards = await expectThreeAcross(canvasElement);
    const alert = within(cards[1]!).getByRole('alert');
    await expect(alert).toHaveTextContent(DEMO_VISITOR_THING.startFailed);
    await expect(alert.querySelector('.cd-status-dot--refused')).not.toBeNull();
    await expect(within(cards[1]!).queryByText(DEMO_VISITOR_THING.detail)).toBeNull();
    await expect(within(cards[1]!).getByRole('button', { name: DEMO_VISITOR_THING.start })).toBeVisible();
    await expectNoSidewaysScroll();
  },
};

/** The head with both pills, and the note 8 px under it, saying `line`, with Stop while it runs. */
async function expectHeadAndNote(root: HTMLElement, line: string, stop: boolean): Promise<void> {
  const page = within(root);
  const head = page.getByRole('heading', { level: 2, name: RILEY }).closest('header')!;
  await expect([...head.querySelectorAll('.cd-pill')].map((pill) => pill.textContent)).toEqual(['Public', DEMO_VISITOR_PILL]);
  const note = one(root, '.board-demo-top .cd-notice');
  await expect(note).toHaveAttribute('role', 'status');
  await expect(note.querySelector('.cd-status-dot--info')).not.toBeNull();
  await expect(one(note, '.cd-notice__message').textContent).toBe(line);
  await expect(Math.round(note.getBoundingClientRect().top - head.getBoundingClientRect().bottom)).toBe(8);
  const buttons = within(note).queryAllByRole('button');
  await expect(buttons.map((button) => button.textContent)).toEqual(stop ? [DEMO_VISITOR_NOTE.stop] : []);
}

/** Riley's row in the list: the name, then the pill right after it on the top line. */
async function expectTaggedRow(root: HTMLElement): Promise<void> {
  const list = within(root).getByRole('navigation', { name: 'Conversations' });
  const row = within(list).getByRole('link', { current: true });
  const name = one(row, '.cd-conversation-item__name');
  await expect(name.textContent).toBe(RILEY);
  await expect(name.nextElementSibling?.textContent).toBe(DEMO_VISITOR_PILL);
  await expect(list.querySelectorAll('.cd-pill')).toHaveLength(1);
}

export const RunningLaptop: Story = {
  render: () => <ConversationBoard stage="chat" />,
  parameters: {
    canvas: 'N-Live-REV-DEMO-chat-1512',
    canvasNote: `${IN_REVIEW} REV-DEMO while it chats (#artboard-4ae3b66fd4f0): Riley typing, the signed typing bubble. ${SINCE_THE_BAR} Take over sits in the bar too, at its right.`,
  },
  play: async ({ canvasElement, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    await expectOwnerFrame(canvasElement, 'Conversations', { fill: true });
    await expectTaggedRow(canvasElement);
    await expectHeadAndNote(canvasElement, DEMO_VISITOR_NOTE.running, true);
    const log = within(canvasElement).getByRole('log', { name: `Conversation with ${RILEY}` });
    await expect(within(log).getByRole('status')).toHaveTextContent(`${RILEY} is typing`);
    // Stop is a stop on the keyboard, by its words.
    const stop = within(canvasElement).getByRole('button', { name: DEMO_VISITOR_NOTE.stop });
    stop.focus();
    await expect(document.activeElement).toBe(stop);
    await userEvent.keyboard('{Tab}');
    await expect(document.activeElement).not.toBe(stop);
    await expectNoSidewaysScroll();
  },
};

export const RunningPhone: Story = {
  render: () => <ConversationBoard stage="chat" phone />,
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    canvas: 'N-Live-REV-DEMO-chat-390',
    canvasNote: `${IN_REVIEW} REV-DEMO while it chats, on a phone (#artboard-b6a3eaf4a777): the conversation has the page, the list a step back, as the web app draws it under 1024 px. ${SINCE_THE_BAR} On a phone the bar's first line holds the name, both pills and Take over, and Latest takes its second.`,
  },
  play: async ({ canvasElement }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([390, 844]);
    await expectHeadAndNote(canvasElement, DEMO_VISITOR_NOTE.running, true);
    await expectNoSidewaysScroll();
  },
};

export const AfterAWhisper: Story = {
  render: () => <ConversationBoard stage="whisper" />,
  parameters: {
    canvas: 'N-Live-REV-DEMO-whisper-1512',
    canvasNote: `${IN_REVIEW} REV-DEMO after you whisper (#artboard-b5079e9ac81c): the whisper, then Claude's open times; Riley never sees it. ${SINCE_THE_BAR}`,
  },
  play: async ({ canvasElement }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    await expectTaggedRow(canvasElement);
    await expectHeadAndNote(canvasElement, DEMO_VISITOR_NOTE.running, true);
    await expect(within(canvasElement).getByText(WHISPER_CAPTION)).toBeVisible();
    await expectNoSidewaysScroll();
  },
};

export const AfterATakeOver: Story = {
  render: () => <ConversationBoard stage="takeover" />,
  parameters: {
    canvas: 'N-Live-REV-DEMO-takeover-1512',
    canvasNote: `${IN_REVIEW} REV-DEMO after you take over (#artboard-894cee1ec120): Mike joined, Riley answers him, and Hand back with his composer. ${SINCE_THE_BAR}`,
  },
  play: async ({ canvasElement }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    await expectTaggedRow(canvasElement);
    await expectHeadAndNote(canvasElement, DEMO_VISITOR_NOTE.running, true);
    await expect(within(canvasElement).getByText(TAKE_OVER_WORDS)).toBeVisible();
    await expect(within(canvasElement).getByRole('button', { name: 'Hand back to Claude' })).toBeVisible();
    await expectNoSidewaysScroll();
  },
};

export const Ended: Story = {
  render: () => <ConversationBoard stage="ended" />,
  parameters: {
    canvas: 'N-Live-REV-DEMO-ended-1512',
    canvasNote: `${IN_REVIEW} REV-DEMO when it ends (#artboard-2e93bf1904b9): the note says it finished, with no button; the row keeps its pill. Stopped by the owner, it says "${DEMO_VISITOR_NOTE.stopped}" Stopped by a failure or the day's budget, "${DEMO_VISITOR_NOTE.stoppedEarly}" The board still draws Take over and the whisper box under it; since UX QA on 2026-11-02 an ended demo visitor's chat offers neither, as nobody is left to answer: while Claude has it, there are no controls; while the owner holds it, only Hand back stays at its foot; if the breaker paused it, only Resume Claude stays. ${SINCE_THE_BAR}`,
  },
  play: async ({ canvasElement }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    await expectTaggedRow(canvasElement);
    await expectHeadAndNote(canvasElement, DEMO_VISITOR_NOTE.finished, false);
    await expect(within(canvasElement).queryByRole('button', { name: 'Take over' })).toBeNull();
    await expect(within(canvasElement).queryByRole('textbox', { name: 'Whisper to Claude' })).toBeNull();
    await expectNoSidewaysScroll();
  },
};
