import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import type { LedgerEntry } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { FullTrace } from './FullTrace.tsx';

/** Entry 2 of a ledger page: the decision that held the discounted quote. */
function entryTwo(entries: readonly LedgerEntry[]): LedgerEntry {
  const entry = entries.find((candidate) => candidate.seq === 2);
  if (!entry) throw new Error('the ledger fixture has no entry 2');
  return entry;
}

const verified = entryTwo(rivera.ledger.verified.entries);
const broken = entryTwo(rivera.ledger.broken.entries);

/** A long value as the trace shows it: its first and last eight characters. */
const shortened = (value: string) => `${value.slice(0, 8)}…${value.slice(-8)}`;

const meta = {
  title: 'Safety/FullTrace',
  component: FullTrace,
  args: {
    entry: verified,
    chain: { chain_ok: rivera.ledger.verified.chain_ok, first_bad_seq: rivera.ledger.verified.first_bad_seq },
    devKey: false,
    onClose: fn(),
  },
  // A conversation's reading column, where an owner opens it from a receipt.
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 'var(--size-reading)' }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: 'padded',
    canvas: 'N-Safety-Run1',
    canvasNote:
      'The board shows the full trace closed, as a bordered row under the checkpoints; this is one entry opened, in the same bordered style.',
  },
} satisfies Meta<typeof FullTrace>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Verified: Story = {
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const trace = canvas.getByRole('region', { name: 'Full trace of entry 2' });

    // The plain line says what the entry records and who wrote it, before any of the record.
    const plain = trace.querySelector<HTMLElement>('.cd-full-trace__plain');
    if (!plain) throw new Error('no plain line');
    await expect(plain).toHaveTextContent('A decision on an action Claude asked to take. Recorded by the checkpoint.');

    // The record, field by field, as the kernel signed it.
    const values = new Map(
      [...trace.querySelectorAll('dt')].map((term) => [term.textContent, term.nextElementSibling as HTMLElement]),
    );
    await expect([...values.keys()]).toEqual([
      'Entry',
      'Recorded at',
      'Previous hash',
      'Hash',
      'Signature',
      'Signing key',
      'What was recorded',
    ]);
    await expect(values.get('Entry')).toHaveTextContent(String(verified.seq));
    // created_at is shown as given: nothing here formats a date.
    await expect(values.get('Recorded at')?.textContent).toBe(verified.created_at);
    for (const [label, full] of [
      ['Previous hash', verified.prev_hash],
      ['Hash', verified.hash],
      ['Signature', verified.signature],
    ] as const) {
      // Long values are shortened in the middle, with the whole value in the title.
      await expect(values.get(label)?.textContent).toBe(shortened(full));
      await expect(values.get(label)).toHaveAttribute('title', full);
    }
    // A key id short enough to read is shown whole.
    await expect(values.get('Signing key')?.textContent).toBe(verified.key_id);
    await expect(values.get('Signing key')).toHaveAttribute('title', verified.key_id);
    await expect(values.get('What was recorded')?.textContent).toBe(JSON.stringify(verified.event.summary, null, 2));
    // The record shows at once, as the kernel signed it, as indented JSON in mono.
    const record = trace.querySelector('pre');
    if (!record) throw new Error('the record is drawn with the trace');
    expectComputed(record, { fontFamily: /JetBrains Mono/, fontSize: '12.5px', lineHeight: '18px' });

    // The parts keep their spacing: the record and the chain line stand apart from the words above.
    expectComputed(trace.querySelector('dl') as Element, { marginTop: '12px' });
    expectComputed(trace.querySelector('.cd-full-trace__chain') as Element, { marginTop: '14px', paddingTop: '12px' });

    await expect(canvas.getByText('Chain verified through entry 2')).toBeVisible();
    const dot = trace.querySelector('.cd-full-trace__chain .cd-status-dot');
    await expect(dot).toHaveClass('cd-status-dot--handled');
    await expect(canvas.queryByText('Signed with a development key')).toBeNull();

    // trace_is_the_only_mono: the record's values are mono; the words around them are not.
    for (const value of values.values()) {
      const mono = value.matches('.cd-type-trace') ? value : value.querySelector('.cd-type-trace');
      if (!mono) throw new Error(`no mono value in ${value.outerHTML}`);
      expectComputed(mono, { fontFamily: /JetBrains Mono/, fontSize: '12.5px', lineHeight: '18px' });
    }
    const words = [
      trace.querySelector('.cd-full-trace__title'),
      plain,
      ...trace.querySelectorAll('dt'),
      trace.querySelector('.cd-full-trace__chain'),
    ];
    for (const word of words) {
      if (!word) throw new Error('a part of the trace is missing');
      expectComputed(word, { fontFamily: /^(?!.*JetBrains Mono).*Hanken Grotesk/ });
    }

    // trace_closes_on_escape: from inside the trace, Escape closes it; so does the close button.
    // The trace itself takes focus only when a screen moves it there: Tab goes to its close button.
    await expect(trace).toHaveAttribute('tabindex', '-1');
    const close = canvas.getByRole('button', { name: 'Close the full trace' });
    await userEvent.tab();
    await expect(close).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect(args.onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(close);
    await expect(args.onClose).toHaveBeenCalledTimes(2);
  },
};

export const Broken: Story = {
  args: { entry: broken, chain: { chain_ok: rivera.ledger.broken.chain_ok, first_bad_seq: rivera.ledger.broken.first_bad_seq } },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText('Chain broken at entry 2')).toBeVisible();
    await expect(canvas.queryByText(/Chain verified/)).toBeNull();
    const dot = canvasElement.querySelector('.cd-full-trace__chain .cd-status-dot');
    await expect(dot).toHaveClass('cd-status-dot--refused');
    // The trace shows the record as it is now, edited summary and all.
    const summary = canvasElement.querySelector('pre');
    await expect(summary?.textContent).toBe(JSON.stringify(broken.event.summary, null, 2));
    await expect(summary?.textContent).toContain('"outcome": "allow"');
  },
};

export const DevKey: Story = {
  args: { chain: null, devKey: true },
  parameters: {
    canvasNote:
      'The board shows no signing key; a Desk signing with the development key says so in the trace. The chain has not been checked yet.',
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText('Signed with a development key')).toBeVisible();
    // No chain result yet: the trace claims nothing about it.
    await expect(canvas.getByText('Not verified yet')).toBeVisible();
    await expect(canvas.queryByText(/Chain verified|Chain broken/)).toBeNull();
    const dot = canvasElement.querySelector('.cd-full-trace__chain .cd-status-dot');
    await expect(dot).toHaveClass('cd-status-dot--info');
  },
};

export const InTheTabOrder: Story = {
  args: { tabIndex: 0 },
  parameters: {
    canvasNote:
      'Beside Safety’s every-entry list the trace scrolls inside itself, so Tab reaches it, ahead of its close button, and its own border shows the focus.',
  },
  play: async ({ canvas, userEvent }) => {
    const trace = canvas.getByRole('region', { name: 'Full trace of entry 2' });
    await userEvent.tab();
    await expect(trace).toHaveFocus();
    // line-focus as the browser computes it, read off a probe.
    const probe = document.createElement('span');
    probe.style.color = 'var(--line-focus)';
    trace.append(probe);
    const lineFocus = getComputedStyle(probe).color;
    probe.remove();
    expectComputed(trace, { borderTopColor: lineFocus, boxShadow: 'none', outlineStyle: 'none' });
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Close the full trace' })).toHaveFocus();
  },
};
