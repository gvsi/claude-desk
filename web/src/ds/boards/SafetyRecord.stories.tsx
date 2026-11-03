import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import type { LedgerEntry, LedgerPage } from '../../api/contracts.ts';
import { NO_BUSINESS_TOOLS } from '../../owner/connectors/catalog.ts';
import { ToolCallSection } from '../../owner/safety/ToolCallSection.tsx';
import { toolCallFor } from '../../owner/safety/toolCall.ts';
import { FullTrace } from '../components/FullTrace/FullTrace.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { SafetyPage } from './parts.tsx';
import { SPEC, expectOwnerFrame, expectTabOrder } from './spec.ts';

const fixture = rivera.ledger.verified;
const page: LedgerPage = {
  ...fixture,
  entries: [
    fixture.entries[0]!,
    { ...fixture.entries[1]!, seq: 19, event: { kind: 'decide', origin: 'kernel', ref_id: 'dec-book', summary: {
      decision_id: 'dec-book', tool: 'native.book', outcome: 'allow', card_ids: ['rv-book-wk'], reviewed: true,
    } } },
    { ...fixture.entries[2]!, seq: 20, event: { kind: 'execute', origin: 'kernel', ref_id: 'dec-book', summary: {
      decision_id: 'dec-book', action_id: 'act-book', state: 'executed', policy_version: 7,
    } } },
  ],
};
const rules = { cards: Object.values(rivera.ruleCards), version: 7, words: { business: NO_BUSINESS_TOOLS } };
/** Where an entry came from, as the screen words it: the kernel's own entries, and the chat's reports. */
const ORIGIN = { kernel: 'Recorded by your Desk', api: 'Reported by the chat, not verified by your Desk' } as const;
/** The booking execution, with its allowing decision in the same page. */
const OPEN_SEQ = 20;

/**
 * Each entry as the screen lists it: what happened in words, who recorded it, and its time as the
 * screen writes it (the design system formats none). The kernel recorded all three.
 */
const ROWS: Record<number, { what: string; time: string }> = {
  20: { what: 'Tool call: Book a visit', time: '10:04 am' },
  19: { what: 'Action checked', time: '10:04 am' },
  1: { what: 'Chat started', time: '10:03 am' },
};

function rowOf(entry: LedgerEntry): { what: string; time: string } {
  const row = ROWS[entry.seq];
  if (!row) throw new Error(`no words for ledger entry ${entry.seq}`);
  return row;
}

function SafetyRecord() {
  const newestFirst = [...page.entries].sort((a, b) => b.seq - a.seq);
  const open = page.entries.find((entry) => entry.seq === OPEN_SEQ);
  if (!open) throw new Error(`the ledger fixture has no entry ${OPEN_SEQ}`);
  const call = toolCallFor(open, page.entries, rules);
  return (
    <SafetyPage
      view="entries"
      entries={page.entries.length}
      list={
        <table className="board-ledger" aria-label="Every entry">
          <thead>
            <tr>
              <th scope="col" className="cd-type-caption">
                Entry
              </th>
              <th scope="col" className="cd-type-caption">
                What
              </th>
              <th scope="col" className="cd-type-caption">
                From
              </th>
              <th scope="col" className="cd-type-caption">
                Time
              </th>
            </tr>
          </thead>
          <tbody>
            {newestFirst.map((entry) => (
              <tr key={entry.seq} aria-current={entry.seq === OPEN_SEQ ? 'true' : undefined}>
                <td className="board-ledger__entry cd-type-meta">{entry.seq}</td>
                <td className="cd-type-control">
                  <a className="board-ledger__open" href={`#entry-${entry.seq}`}>
                    {rowOf(entry).what}
                  </a>
                </td>
                <td className="board-ledger__by cd-type-caption">{entry.event.origin === 'kernel' ? ORIGIN.kernel : ORIGIN.api}</td>
                <td className="board-ledger__entry cd-type-meta">{rowOf(entry).time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
      detail={<FullTrace entry={open} chain={{ chain_ok: page.chain_ok, first_bad_seq: page.first_bad_seq }} devKey onClose={fn()}>
        {call !== null ? <ToolCallSection call={call} entry={open} rules={rules} /> : null}
      </FullTrace>}
    />
  );
}

const meta = {
  title: 'Boards/Safety, full record',
  render: () => <SafetyRecord />,
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Safety-Record-Run1',
    canvasNote: [
      'Every entry: the ledger as a table, newest first, and one entry’s full trace beside it.',
      'The record includes a booking’s decision and execution, with the Tool call section open on the execution, as the Safety tool-call board draws it; the times are the screen’s strings.',
      'The table is page layout the web app (plan 04) owns, composed on the tokens; every entry is “Recorded by your Desk” under the column head “From”, where the board says “Recorded by the checkpoint” under “Recorded by”, so the owner’s row names no part and the head doesn’t repeat it; FullTrace’s own line keeps “Recorded by the checkpoint.”, as signed at sign-off.',
      'The board’s open questions are canvas notes.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expectOwnerFrame(canvasElement, 'Safety');
    expectComputed(canvas.getByRole('heading', { level: 1, name: 'Safety' }), SPEC.pageTitle);
    await expect(canvas.getByRole('radio', { name: 'Every entry' })).toHaveAttribute('aria-checked', 'true');

    // The ledger, newest first, each recorded by the Desk; the open one marked.
    const table = canvas.getByRole('table', { name: 'Every entry' });
    // The column heads, where the board's "Recorded by" became "From", so the head doesn't repeat its cells.
    await expect(within(table).getAllByRole('columnheader').map((head) => head.textContent)).toEqual(['Entry', 'What', 'From', 'Time']);
    const rows = within(table).getAllByRole('row').slice(1);
    await expect(rows.map((row) => row.firstElementChild?.textContent)).toEqual(['20', '19', '1']);
    for (const row of rows) await expect(row).toHaveTextContent(ORIGIN.kernel);
    await expect(rows[0]).toHaveAttribute('aria-current', 'true');
    expectComputed(rows[0] as HTMLElement, { backgroundColor: 'rgb(60, 57, 47)' });

    // The full trace of the open entry, beside the table, with its plain line and the chain.
    const trace = canvas.getByRole('region', { name: `Full trace of entry ${OPEN_SEQ}` });
    await expect(trace).toHaveTextContent('Recorded by the checkpoint.');
    await expect(within(trace).getByRole('group', { name: 'Tool call' })).toHaveTextContent('Bookings · Built in');
    await expect(trace.getBoundingClientRect().left).toBeGreaterThan(table.getBoundingClientRect().right);

    // focus_order_is_logical: the sidebar, the held request, the view switch, the entries, the trace's close.
    const column = canvas.getByRole('complementary', { name: 'Claude Desk' });
    await expectTabOrder(userEvent, [
      within(column).getByRole('button', { name: `Switch business, current: ${rivera.business.name}` }),
      ...within(within(column).getByRole('navigation', { name: 'Main' })).getAllByRole('link'),
      canvas.getByRole('link', { name: '1 held for you, in Today' }),
      canvas.getByRole('radio', { name: 'Every entry' }),
      ...within(table).getAllByRole('link'),
      within(trace).getByRole('button', { name: /close/i }),
    ]);
  },
};
