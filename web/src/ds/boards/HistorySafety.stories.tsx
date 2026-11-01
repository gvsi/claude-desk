import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { AttemptRow, type AttemptRowProps } from '../components/AttemptRow/AttemptRow.tsx';
import { CheckpointMeter } from '../components/AttemptRow/CheckpointMeter.tsx';
import { Card } from '../components/Card/Card.tsx';
import { RecordedHistoryLink } from '../components/RecordedHistoryLink/RecordedHistoryLink.tsx';
import { RecordedNote } from '../components/RecordedNote/RecordedNote.tsx';
import { StatusLabel } from '../components/StatusDot/StatusDot.tsx';
import { TextLink } from '../components/TextLink/TextLink.tsx';
import { rivera } from '../fixtures/index.ts';
import { Icon } from '../icons/index.tsx';
import { expectComputed } from '../test/expectComputed.ts';
import { KindChips, RECORDED_HISTORY_HREF, SafetyPage } from './parts.tsx';
import {
  SPEC,
  expectFooter,
  expectFooterAtFoot,
  expectOwnerFrame,
  expectRecordedLink,
  expectRecordedNote,
  expectRecordedTags,
  expectTabOrder,
  one,
} from './spec.ts';

const FROM = 'Recorded by the checkpoint';

/** This week's attempts, newest first: today's live ones, then two from the recorded history. */
const ATTEMPTS: Omit<AttemptRowProps, 'href'>[] = [
  { time: 'Today, 11:15 am', title: 'Agent went over its signed limit', who: FROM, stoppedBy: 'action' },
  { time: 'Today, 11:02 am', title: 'Posed as Mike to get a refund', who: FROM, stoppedBy: 'action' },
  { time: 'Today, 10:51 am', title: 'Asked for Bob’s warranty', who: FROM, stoppedBy: 'action' },
  { time: 'Yesterday, 10:10 pm', title: 'Asked for your number in plain digits, not a card', who: FROM, stoppedBy: 'reply', recorded: true, current: true },
  { time: 'Oct 23, 4:45 pm', title: 'Asked for your number typed out in words', who: FROM, stoppedBy: 'reply', recorded: true },
];

const OPEN_TITLE = 'Asked for your number in plain digits, not a card';

/** The replayed attempt opened beside the list: the note under its status, then what happened. */
function RecordedAttempt() {
  return (
    <Card as="article" label={OPEN_TITLE}>
      <div className="board-attempt">
        <p className="board-attempt__top cd-type-caption">
          <StatusLabel tone="refused">Stopped</StatusLabel>
          <span>Other</span>
          <span className="board-attempt__when">Yesterday, 10:10 pm</span>
        </p>
        <div className="board-attempt__recorded">
          <RecordedNote />
        </div>
        <p className="cd-type-summary">
          A visitor who said she was Dana asked for Mike’s number in plain digits. My draft typed it into the text, so the reply
          check held it back and the contact card went instead.
        </p>
        <p className="cd-type-body">This reply was never shown.</p>
        <div className="board-attempt__part">
          <p className="board-attempt__caption cd-type-caption">Summary written by Claude</p>
          <p className="cd-type-body">Asked for the business number typed out instead of shown as a card.</p>
        </div>
        <div className="board-attempt__part">
          <details open>
            <summary className="cd-type-control">
              <Icon name="chevron-down" size={16} className="board-attempt__chevron" />
              See how it was stopped
            </summary>
            <CheckpointMeter stoppedBy="reply" />
          </details>
          <details>
            <summary className="cd-type-control">
              <Icon name="chevron-down" size={16} className="board-attempt__chevron" />
              Full trace
            </summary>
            <p className="board-attempt__caption cd-type-caption">Every entry shows the full record of each step.</p>
          </details>
        </div>
        <p className="cd-type-meta">
          <TextLink href="#conversation-recorded-plain-digits">Open conversation</TextLink>
        </p>
      </div>
    </Card>
  );
}

function HistorySafety() {
  return (
    <SafetyPage
      view="attempts"
      entries={212}
      summary="5 attempts to talk me around were stopped this week."
      caption={<RecordedHistoryLink href={RECORDED_HISTORY_HREF} />}
      counts={{ conversations: { n: 2, label: '2 need you' }, safety: { n: 3, label: '3 blocked' } }}
      history
      list={
        <>
          <KindChips />
          <ul className="board-attempts" aria-label="Attempts this week">
            {ATTEMPTS.map((attempt) => (
              <li key={attempt.time}>
                <AttemptRow {...attempt} href={`#attempt-${attempt.time}`} />
              </li>
            ))}
          </ul>
        </>
      }
      detail={<RecordedAttempt />}
    />
  );
}

const meta = {
  title: 'Boards/Recorded history, safety',
  render: () => <HistorySafety />,
  // Drawn at a 14-inch laptop's window, so the play measures it there.
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-History-Safety',
    canvasNote: [
      'Safety with this week’s attempts: “Includes recorded history” (RecordedHistoryLink) on the summary’s baseline, 14 px after it; each replayed attempt with the Recorded tag 10 px after where it came from (AttemptRow recorded); and the opened one with the line under its status (RecordedNote), 10 px down.',
      'At this window the page fills the main area with its own 24/40/20 padding, the opened attempt is 400 px wide and 32 px from the list, and the footer sits at the window’s foot: page layout the web app (plan 04) owns, composed from the Safety board’s parts, AttemptRow, CheckpointMeter, Card, StatusLabel, TextLink and the tokens.',
      'The parts it shares with the Safety board (N-Safety-Run1) are kept as that board’s story draws them: the header 4 px higher than both renders, the attempts 2 px apart where the renders draw 4, and the opened attempt’s disclosures closer together.',
      'The render draws a replayed row’s tag 2 px above the words before it and that row 1 px taller; here the tag shares their baseline and the row keeps its 50 px.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    // The board's own window: a 14-inch laptop's.
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    await expectOwnerFrame(canvasElement, 'Safety', { fill: true });
    expectComputed(canvas.getByRole('heading', { level: 1, name: 'Safety' }), SPEC.pageTitle);
    const main = canvas.getByRole('main');
    expectComputed(one(main, '.board-filled-page'), SPEC.main);

    // The caption on the summary's baseline, 14 px after it.
    const summary = canvas.getByText('5 attempts to talk me around were stopped this week.');
    const caption = canvas.getByRole('link', { name: 'Includes recorded history' });
    await expectRecordedLink(caption, RECORDED_HISTORY_HREF);
    await expect(Math.round(caption.getBoundingClientRect().left - summary.getBoundingClientRect().right)).toBe(14);
    const baseline = (el: HTMLElement) => {
      const probe = document.createElement('span');
      probe.style.display = 'inline-block';
      el.append(probe);
      const y = probe.getBoundingClientRect().bottom;
      probe.remove();
      return Math.round(y);
    };
    await expect(baseline(caption)).toBe(baseline(summary));

    // The list and the opened attempt: 400 px wide, 32 px from the list, the page full width.
    const list = canvas.getByRole('list', { name: 'Attempts this week' });
    const detail = canvas.getByRole('article', { name: OPEN_TITLE });
    expectComputed(detail, SPEC.card);
    await expect(detail.getBoundingClientRect().width).toBe(400);
    await expect(Math.round(detail.getBoundingClientRect().left - list.getBoundingClientRect().right)).toBe(32);
    await expect(Math.round(detail.getBoundingClientRect().right)).toBe(Math.round(main.getBoundingClientRect().right) - 40);

    // recorded_rows_are_tagged: today's live attempts carry no tag; each replayed one does, 10 px
    // after where it came from, on its baseline, and the row keeps its height.
    const rows = within(list).getAllByRole('link');
    await expect(rows).toHaveLength(ATTEMPTS.length);
    const tags = await expectRecordedTags(rows, (row) => ATTEMPTS[rows.indexOf(row)]?.recorded === true);
    await expect(tags).toHaveLength(2);
    for (const tag of tags) {
      const row = tag.closest('a') as HTMLElement;
      const from = within(row).getByText(FROM);
      await expect(Math.round(tag.getBoundingClientRect().left - from.getBoundingClientRect().right)).toBe(10);
      await expect(tag.getBoundingClientRect().top).toBe(from.getBoundingClientRect().top);
      await expect(Math.round(row.getBoundingClientRect().height)).toBe(50);
    }
    const open = within(list).getByRole('link', { current: true });
    await expect(open).toHaveAccessibleName(`Yesterday, 10:10 pm ${OPEN_TITLE} ${FROM} Recorded Stopped by: Reply checkpoint`);

    // The opened attempt: the line 10 px under its status, then what happened in Claude's words.
    const note = await expectRecordedNote(detail);
    const status = one(detail, '.board-attempt__top');
    await expect(Math.round(note.getBoundingClientRect().top - status.getBoundingClientRect().bottom)).toBe(10);
    await expect(Math.round(note.getBoundingClientRect().height)).toBe(34);
    await expect(within(detail).getByText('Reply checkpoint')).toBeVisible();

    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);

    // focus_order_is_logical: the sidebar, the caption, the held request, the view switch, the kinds
    // as one tab stop, the attempts, the opened one.
    const column = canvas.getByRole('complementary', { name: 'Claude Desk' });
    const kinds = within(canvas.getByRole('radiogroup', { name: 'Kind of attempt' })).getAllByRole('radio');
    await expectTabOrder(userEvent, [
      within(column).getByRole('button', { name: `Switch business, current: ${rivera.business.name}` }),
      ...within(within(column).getByRole('navigation', { name: 'Main' })).getAllByRole('link'),
      within(column).getByRole('switch', { name: 'Answering' }),
      caption,
      canvas.getByRole('link', { name: '1 held for you, in Today' }),
      canvas.getByRole('radio', { name: 'Attempts' }),
      kinds[0] as HTMLElement,
      ...rows,
      within(detail).getByText('See how it was stopped'),
      within(detail).getByText('Full trace'),
      within(detail).getByRole('link', { name: 'Open conversation' }),
    ]);
  },
};
