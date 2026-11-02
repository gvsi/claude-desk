import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { StatusDot, StatusLabel } from '../StatusDot/StatusDot.tsx';
import { AdvancedDetails, DetailsSlot, type AdvancedDetailsProps } from './AdvancedDetails.tsx';
import { jsonText } from './detailsJson.ts';

/** REV-RULES-D's Payment link, as Your tools lists it. */
const TOOL_JSON = {
  tool: 'native.payment_link',
  source: 'native',
  effects: ['charge'],
  reversible: false,
  status: 'enabled',
  description_confirmed: 'Makes a one-time link for a quote.',
  definition_sha256: '7f3a9c0000000000000000000000000000000000000000000000000000e21b',
};

/** Its rule, as the owner set it. */
const CARD_JSON = {
  card_id: 'rv-link',
  applies_to: 'native.payment_link',
  mode: 'auto',
  who: 'anyone',
  max_amount_cents: 30000,
  review: true,
  reason: 'Payment links up to $300, checked by the reviewer.',
};

const TOOL: Omit<AdvancedDetailsProps, 'children' | 'onCopy'> = {
  fields: [
    { label: 'Name', value: 'native.payment_link', mono: true },
    { label: 'Source', value: 'Built in' },
    { label: 'Claude sees', value: <span data-copy="user">Makes a one-time link for a quote.</span> },
    { label: 'Effects', value: "Charges money · Can't be undone" },
    { label: 'Status', value: 'Turned on' },
    { label: 'Pinned', value: <StatusLabel tone="handled">Matches its pin</StatusLabel> },
  ],
  code: { label: 'As your Desk lists it', value: TOOL_JSON },
  describedBy: 'story-tool',
};

const RULE: Omit<AdvancedDetailsProps, 'children' | 'onCopy'> = {
  fields: [
    { label: 'Rule', value: 'rv-link', mono: true },
    { label: 'Version', value: '7, proved against the always-on rules' },
    { label: 'Policy hash', value: 'sha256 c41d…09af', mono: true },
  ],
  code: { label: 'The rule as you set it', value: CARD_JSON },
  describedBy: 'story-rule',
};

const CANVAS_NOTE =
  'The details disclosure from REV-RULES-D as it ships (canvas v339, signed): no Parameters and no compiled Cedar. Your tools draws it on every tool and every rule, Rules on every rule.';

/** A tool's row and one of its rules, as Your tools draws them, each with its Details. */
function Rows({ onCopy }: { onCopy: AdvancedDetailsProps['onCopy'] }) {
  return (
    <div style={{ maxWidth: 738, padding: 'var(--space-16)', border: '1px solid var(--line-card)', borderRadius: 'var(--radius-card)' }}>
      <AdvancedDetails {...TOOL} onCopy={onCopy}>
        {(toggle) => (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-12)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p id="story-tool" className="cd-type-body cd-user-name" data-copy="user" style={{ margin: 0 }}>Payment link</p>
              <p className="cd-type-meta" style={{ margin: 'var(--space-2) 0 0', color: 'var(--text-secondary)' }}>Makes a one-time link for a quote.</p>
            </div>
            {toggle}
          </div>
        )}
      </AdvancedDetails>
      <ul role="list" style={{ margin: 'var(--space-8) 0 0', padding: '0 0 0 var(--space-16)', borderLeft: '1px solid var(--line-card)', listStyle: 'none' }}>
        <li style={{ padding: 'var(--space-8) 0' }}>
          <AdvancedDetails {...RULE} onCopy={onCopy}>
            {(toggle) => (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-12)' }}>
                <p id="story-rule" className="cd-type-body" style={{ flex: 1, minWidth: 0, margin: 0, color: 'var(--text-secondary)' }}>
                  Claude can send payment links up to <strong>$300</strong>
                </p>
                <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}>
                  <StatusDot tone="handled" />
                  {toggle}
                </span>
              </div>
            )}
          </AdvancedDetails>
        </li>
      </ul>
    </div>
  );
}

const meta = {
  title: 'Rules/AdvancedDetails',
  component: AdvancedDetails,
  args: { ...TOOL, onCopy: fn(async () => {}), children: () => null },
  render: (args) => <Rows onCopy={args.onCopy} />,
  parameters: { layout: 'padded', canvas: 'none', canvasNote: CANVAS_NOTE },
} satisfies Meta<typeof AdvancedDetails>;

export default meta;

type Story = StoryObj<typeof meta>;

const SECONDARY = 'rgba(250, 249, 245, 0.64)';
const TERTIARY = 'rgba(250, 249, 245, 0.6)';
const PRIMARY = 'rgba(250, 249, 245, 0.92)';
const BLUE = 'rgb(126, 174, 218)';

/** Collapsed by default; the keyboard opens and closes each; the JSON is tinted by token and Copy copies it. */
export const Desktop: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(1440);
    const [tool, rule] = canvas.getAllByRole('button', { name: 'Details' });
    if (tool === undefined || rule === undefined) throw new Error('no Details');
    for (const toggle of [tool, rule]) await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(canvasElement.querySelector('.cd-advanced-details__panel')).toBeNull();
    // A quiet button: control type in the secondary ink, no fill until it's hovered or open.
    expectComputed(tool, { color: SECONDARY, backgroundColor: 'rgba(0, 0, 0, 0)', paddingTop: '2px', paddingLeft: '6px', height: '24px' });
    await expect(tool).toHaveAccessibleDescription('Payment link');

    // Enter opens the tool's panel: the hover fill, the chevron turned down, the panel on the surface.
    tool.focus();
    await userEvent.keyboard('{Enter}');
    await expect(tool).toHaveAttribute('aria-expanded', 'true');
    // The fill and the chevron change at the motion tokens' pace; they settle open.
    await waitFor(() => expectComputed(tool, { backgroundColor: 'rgba(250, 249, 245, 0.06)' }));
    await waitFor(() => expect(getComputedStyle(tool.querySelector('svg')!).transform).toBe('matrix(0, 1, -1, 0, 0, 0)'));
    const panel = canvasElement.querySelector<HTMLElement>('.cd-advanced-details__panel')!;
    expectComputed(panel, { backgroundColor: 'rgb(42, 41, 39)', borderTopWidth: '1px', borderTopLeftRadius: '8px', paddingTop: '12px', paddingLeft: '16px' });
    // The label column is 104 px, in meta type; a mono value in the trace type.
    const label = panel.querySelector<HTMLElement>('dt')!;
    await expect(label.getBoundingClientRect().width).toBe(104);
    expectComputed(label, { color: SECONDARY });
    await expect(panel.querySelector('dd .cd-type-trace')?.textContent).toBe('native.payment_link');

    // The JSON as written, tinted: keys blue, strings primary, other values secondary, punctuation tertiary.
    const pre = panel.querySelector<HTMLElement>('pre')!;
    await expect(pre.textContent).toBe(jsonText(TOOL_JSON));
    expectComputed(pre, { whiteSpace: 'pre', overflowX: 'auto', fontVariantLigatures: 'none', paddingTop: '12px', backgroundColor: 'rgba(250, 249, 245, 0.1)' });
    expectComputed(pre.querySelector<HTMLElement>('.cd-advanced-details__json-key')!, { color: BLUE });
    expectComputed(pre.querySelector<HTMLElement>('.cd-advanced-details__json-string')!, { color: PRIMARY });
    expectComputed(pre.querySelector<HTMLElement>('.cd-advanced-details__json-value')!, { color: SECONDARY });
    expectComputed(pre.querySelector<HTMLElement>('.cd-advanced-details__json-punct')!, { color: TERTIARY });
    await expect(pre).toHaveAttribute('data-copy', 'code');

    // Copy goes through the callback, with CopyField's words after it.
    await userEvent.click(canvas.getByRole('button', { name: 'Copy' }));
    await expect(args.onCopy).toHaveBeenCalledWith(jsonText(TOOL_JSON));
    await waitFor(() => expect(panel.querySelector('[role="status"]')).toHaveTextContent(/^Copied\.$/));

    // Space closes it; the rule's opens the same way, under its row.
    tool.focus();
    await userEvent.keyboard(' ');
    await expect(tool).toHaveAttribute('aria-expanded', 'false');
    rule.focus();
    await userEvent.keyboard('{Enter}');
    await expect(rule).toHaveAttribute('aria-expanded', 'true');
    await expect(canvasElement.querySelectorAll('.cd-advanced-details__panel')).toHaveLength(1);
    await expect(canvasElement.querySelector('pre')?.textContent).toBe(jsonText(CARD_JSON));
  },
};

/** At 390 the panel keeps its label column; long values wrap, and a long JSON line scrolls inside its block, never the page. */
export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(390);
    for (const toggle of canvas.getAllByRole('button', { name: 'Details' })) await userEvent.click(toggle);
    await expect(canvasElement.querySelectorAll('.cd-advanced-details__panel')).toHaveLength(2);
    for (const label of canvasElement.querySelectorAll('dt')) await expect(label.getBoundingClientRect().width).toBe(104);
    const pre = canvasElement.querySelector<HTMLElement>('pre')!;
    await expect(pre.scrollWidth).toBeGreaterThan(pre.clientWidth);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  },
};

/** v351: a row with no Details (an always-on rule) keeps the slot empty, so every dot sits in one column. */
export const DotsInOneColumn: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  render: (args) => {
    const row = { display: 'flex', alignItems: 'center', gap: 'var(--space-12)', padding: 'var(--space-8) 0' } as const;
    const end = { display: 'flex', alignItems: 'center', gap: 'var(--space-8)' } as const;
    const words = { flex: 1, minWidth: 0, margin: 0, color: 'var(--text-secondary)' } as const;
    return (
      <ul role="list" style={{ maxWidth: 738, margin: 0, padding: 0, listStyle: 'none' }}>
        <li>
          <AdvancedDetails {...RULE} onCopy={args.onCopy}>
            {(toggle) => (
              <div style={row}>
                <p id="story-rule" className="cd-type-body" style={words}>Claude can send payment links up to <strong>$300</strong></p>
                <span style={end}><StatusDot tone="handled" />{toggle}</span>
              </div>
            )}
          </AdvancedDetails>
        </li>
        <li>
          <div style={row}>
            <p className="cd-type-body" style={words}>Claude never says it’s anything but an AI</p>
            <span style={end}><StatusDot tone="refused" /><DetailsSlot /></span>
          </div>
        </li>
      </ul>
    );
  },
  play: async ({ canvas, canvasElement }) => {
    const toggle = canvas.getByRole('button', { name: 'Details' });
    const slot = canvasElement.querySelector<HTMLElement>('.cd-advanced-details__slot')!;
    // The slot is the button's width and height, unseen and out of the accessibility tree.
    await expect(slot.getBoundingClientRect().width).toBe(toggle.getBoundingClientRect().width);
    await expect(slot.getBoundingClientRect().height).toBe(toggle.getBoundingClientRect().height);
    expectComputed(slot, { visibility: 'hidden' });
    await expect(canvas.getAllByRole('button')).toHaveLength(1);
    // So the two dots share one column.
    const [first, second] = [...canvasElement.querySelectorAll('.cd-status-dot')].map((dot) => dot.getBoundingClientRect().left);
    await expect(first).toBe(second);
  },
};
