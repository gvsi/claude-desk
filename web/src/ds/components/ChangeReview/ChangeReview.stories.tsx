import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, waitFor, within } from 'storybook/test';

import { chen, rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import { ChangeReview, type ChangeRowView, type ChangeReviewProps } from './ChangeReview.tsx';

/** The compiler's reason for a tool no card of the owner's covers yet. */
const DEFAULT_REASON = 'Not covered by a rule yet, so it asks you.';

const turnOnPayments: ChangeRowView[] = [
  {
    key: 'native.payment_link',
    change: 'turned_on',
    title: { titles: ['Payment link'] },
    connector: chen.connectors.views.payments,
    before: null,
    after: { mode: 'ask', reason: DEFAULT_REASON, words: [{ field: 'who', text: 'Anyone' }] },
    changed: [],
  },
  {
    key: 'native.charge_mandate',
    change: 'turned_on',
    title: { titles: ['Charge within a signed limit'] },
    connector: chen.connectors.views.payments,
    before: null,
    after: { mode: 'ask', reason: DEFAULT_REASON, words: [{ field: 'who', text: 'Signed agents' }] },
    changed: [],
  },
];

const QUOTE_REASON = 'Quotes from your price list, with the discount you allow.';

const raiseDiscount: ChangeRowView[] = [
  {
    key: 'rv-quote',
    change: 'changed',
    title: { titles: ['Quote'] },
    connector: rivera.connectors.views.quotes,
    before: {
      mode: 'auto',
      reason: QUOTE_REASON,
      words: [
        { field: 'who', text: 'Anyone' },
        { field: 'limits', text: 'Discounts up to 10%' },
      ],
    },
    after: {
      mode: 'auto',
      reason: QUOTE_REASON,
      words: [
        { field: 'who', text: 'Anyone' },
        { field: 'limits', text: 'Discounts up to 50%' },
      ],
    },
    changed: ['limits'],
  },
];

const saturday = rivera.ruleCards['rv-book-sat'];

const addAndRemove: ChangeRowView[] = [
  {
    key: 'rv-book-sun',
    change: 'added',
    title: { titles: ['Book a visit'] },
    connector: rivera.connectors.views.bookings,
    before: null,
    after: {
      mode: 'never',
      reason: 'No bookings on Sundays.',
      words: [
        { field: 'who', text: 'Anyone' },
        { field: 'hours', text: 'Sundays' },
      ],
    },
    changed: [],
  },
  {
    key: saturday.card_id,
    change: 'removed',
    title: { titles: ['Book a visit'] },
    connector: rivera.connectors.views.bookings,
    before: { mode: saturday.mode, reason: saturday.reason, words: rivera.ruleWords['rv-book-sat'] },
    after: null,
    changed: [],
  },
];

const refund = rivera.ruleCards['rv-refund'];

const turnBackOnRefund: ChangeRowView[] = [
  {
    key: 'payments.create_refund',
    change: 'turned_on',
    title: { titles: ['Refund'] },
    connector: rivera.connectors.views.stripe,
    before: null,
    after: { mode: refund.mode, reason: refund.reason, words: rivera.ruleWords['rv-refund'] },
    changed: [],
  },
];

const BOOK_REASON = 'Books a visit in your open times.';

/** Book a visit moved from Ask me first to Automatic: only the outcome changed. */
const bookAutomatically: ChangeRowView[] = [
  {
    key: 'rv-book',
    change: 'changed',
    title: { titles: ['Book a visit'] },
    connector: rivera.connectors.views.bookings,
    before: { mode: 'ask', reason: BOOK_REASON, words: [{ field: 'who', text: 'Anyone' }] },
    after: { mode: 'auto', reason: BOOK_REASON, words: [{ field: 'who', text: 'Anyone' }] },
    changed: ['mode'],
  },
];

const CHECKED = {
  status: 'checked',
  lines: ['No conflict with your other rules.', 'Always-on rules still hold.', 'Nothing here can move money without your answer.'],
} as const satisfies ChangeReviewProps['checks'];

const meta = {
  title: 'Rules/ChangeReview',
  component: ChangeReview,
  args: {
    rows: turnOnPayments,
    checks: CHECKED,
    confirmLabel: 'Confirm and turn on',
    cancelLabel: 'Back',
    onConfirm: fn(),
    onCancel: fn(),
  },
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <ChangeReview {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Conn-10-GCal-Confirm' },
} satisfies Meta<typeof ChangeReview>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Each row's tag, as text. */
function tags(canvasElement: HTMLElement): string[] {
  return [...canvasElement.querySelectorAll('.cd-change-review__tag')].map((tag) => tag.textContent ?? '');
}

export const TurnOnPayments: Story = {
  parameters: {
    canvas: 'N-Conn-11b-Payments-Review',
    canvasNote: "Chen & Co. CPA turning Payments on: both tools at Ask me first, under the compiler's default ask.",
  },
  play: async ({ args, canvas, canvasElement }) => {
    // list_semantics_kept: a list drawn without markers says role="list", so Safari keeps it a list.
    await expect(expectListsKeepTheirRole(canvasElement)).toBeGreaterThanOrEqual(1);
    const changes = canvas.getByRole('region', { name: 'Changes' });
    expectComputed(changes, { paddingTop: '16px', borderTopLeftRadius: '12px' });
    // rows_are_tagged_in_words: the tag is a word in an outlined pill.
    await expect(tags(canvasElement)).toEqual(['Turned on', 'Turned on']);
    const tag = canvasElement.querySelector('.cd-change-review__tag');
    if (tag === null) throw new Error('No tag');
    expectComputed(tag, { borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.22)', fontSize: '13px' });
    // The title, then the connector's name (no "Built in") and the side's words; then what applies,
    // under "After" beside the handled bar: the words, the reason and the outcome.
    const rows = within(changes).getAllByRole('listitem');
    await expect(rows[0]).toHaveTextContent('Payment link');
    await expect(rows[0]).toHaveTextContent('Payments · Anyone');
    await expect(rows[0]).not.toHaveTextContent('Built in');
    const after = within(rows[0] as HTMLElement).getByRole('group', { name: 'After' });
    expectComputed(after, { borderLeftWidth: '2px', borderLeftColor: 'rgb(111, 168, 89)', paddingLeft: '12px' });
    await expect(within(after).getByText('After')).toBeVisible();
    await expect(rows[0]).toHaveTextContent(DEFAULT_REASON);
    await expect(within(rows[0] as HTMLElement).getByText('Ask me first')).toBeVisible();
    await expect((rows[0] as HTMLElement).querySelector('.cd-status-dot--held')).not.toBeNull();
    // The checks, under their heading.
    await expect(canvas.getByRole('region', { name: 'Checked before you confirm' })).toBeVisible();
    for (const line of CHECKED.lines) await expect(canvas.getByText(line)).toBeVisible();
    // confirm_once: two clicks, one confirm; the button waits for the result.
    const confirm = canvas.getByRole('button', { name: 'Confirm and turn on' });
    await confirm.click();
    await confirm.click();
    await expect(args.onConfirm).toHaveBeenCalledTimes(1);
    await expect(confirm).toHaveAttribute('aria-busy', 'true');
    await expect(canvas.getByRole('button', { name: 'Back' })).toHaveAttribute('aria-disabled', 'true');
  },
};

export const RaiseDiscount: Story = {
  args: { rows: raiseDiscount, confirmLabel: undefined, cancelLabel: undefined },
  parameters: {
    canvasNote: "The board's changed row changes a reason; this one changes a limit, drafted from the Rules page.",
  },
  play: async ({ args, canvas, canvasElement }) => {
    await expect(tags(canvasElement)).toEqual(['Changed']);
    // diff_shows_enforced_values: the same reason on both sides, the enforced limit before and after.
    const before = canvas.getByRole('group', { name: 'Before' });
    const after = canvas.getByRole('group', { name: 'After' });
    await expect(before).toHaveTextContent(QUOTE_REASON);
    await expect(after).toHaveTextContent(QUOTE_REASON);
    await expect(before).toHaveTextContent('Anyone · Discounts up to 10%');
    await expect(after).toHaveTextContent('Anyone · Discounts up to 50%');
    // Status never by color alone: the line that changed says so in words, on the after side only,
    // in weight 520; the bars beside the sides are the refused and handled tones, the words neutral.
    const changedLine = within(after).getByText(/Discounts up to 50%/).closest('p');
    if (changedLine === null) throw new Error('No after line');
    await expect(within(changedLine).getByText('Changed')).toBeVisible();
    expectComputed(changedLine, { fontWeight: '520', color: 'rgba(250, 249, 245, 0.64)' });
    expectComputed(before, { borderLeftWidth: '2px', borderLeftColor: 'rgb(220, 130, 144)' });
    expectComputed(after, { borderLeftWidth: '2px', borderLeftColor: 'rgb(111, 168, 89)' });
    expectComputed(within(after).getByText(QUOTE_REASON, { exact: false }), { fontWeight: '380', color: 'rgba(250, 249, 245, 0.92)' });
    await expect(within(before).queryByText('Changed')).toBeNull();
    // The reason and the outcome didn't change, so they aren't tagged.
    await expect(within(after).getAllByText('Changed')).toHaveLength(1);
    // cancel_line_only_when_asked: without cancelsLinks there is no line.
    await expectNoCancelLine(canvasElement);
    // The default words.
    await expect(canvas.getByRole('button', { name: 'Confirm change' })).toBeEnabled();
    await canvas.getByRole('button', { name: 'Keep my rules' }).click();
    await expect(args.onCancel).toHaveBeenCalledTimes(1);
  },
};

export const OutcomeChanged: Story = {
  args: { rows: bookAutomatically, confirmLabel: undefined, cancelLabel: undefined },
  parameters: {
    canvasNote: "The board's changed row changes a reason; this one changes only the outcome, drafted from the Rules page.",
  },
  play: async ({ canvas }) => {
    const before = canvas.getByRole('group', { name: 'Before' });
    const after = canvas.getByRole('group', { name: 'After' });
    // changed_outcome_is_strong: the after side's outcome is in weight 520 and says "Changed"; the
    // before side's, and the lines that didn't change, stay at their own weight.
    expectComputed(within(after).getByText('Automatic'), { fontWeight: '520' });
    expectComputed(within(before).getByText('Ask me first'), { fontWeight: '380' });
    expectComputed(within(after).getByText(BOOK_REASON, { exact: false }), { fontWeight: '380' });
    await expect(within(after).getAllByText('Changed')).toHaveLength(1);
    await expect(within(before).queryByText('Changed')).toBeNull();
  },
};

export const AddAndRemove: Story = {
  args: { rows: addAndRemove, confirmLabel: undefined, cancelLabel: undefined },
  parameters: { canvas: 'N-Conn-12-Chat', canvasNote: 'A rule added and one removed, drafted from the Rules page; no board draws this review.' },
  play: async ({ canvas, canvasElement }) => {
    // rows_are_tagged_in_words
    await expect(tags(canvasElement)).toEqual(['Added', 'Removed']);
    const [added, removed] = canvas.getAllByRole('listitem').slice(0, 2);
    await expect(added).toHaveTextContent('No bookings on Sundays.');
    await expect(added).toHaveTextContent('Bookings · Anyone · Sundays');
    // What applies is After, beside the handled bar; what goes is Before, beside the refused bar.
    expectComputed(within(added as HTMLElement).getByRole('group', { name: 'After' }), { borderLeftColor: 'rgb(111, 168, 89)' });
    expectComputed(within(removed as HTMLElement).getByRole('group', { name: 'Before' }), { borderLeftWidth: '2px', borderLeftColor: 'rgb(220, 130, 144)' });
    await expect(within(removed as HTMLElement).queryByRole('group', { name: 'After' })).toBeNull();
    await expect((added as HTMLElement).querySelector('.cd-status-dot--refused')).not.toBeNull();
    // A removed row shows the rule it removes.
    await expect(removed).toHaveTextContent(saturday.reason);
    await expect(removed).toHaveTextContent('Anyone · Saturdays, 9:00 am to 1:00 pm · Checked by the reviewer');
    await expect(within(removed as HTMLElement).getByText('Automatic')).toBeVisible();
  },
};

export const TurnBackOnRefund: Story = {
  args: {
    rows: turnBackOnRefund,
    checks: { status: 'checked', lines: ['Always-on rules still hold.', 'Refunds still wait for your answer.'] },
    confirmLabel: 'Confirm and turn back on',
  },
  parameters: { canvas: 'N-Conn-14-Changed-Review', canvasNote: "Stripe's Refund turned back on after its definition changed, at Ask me first." },
  play: async ({ canvas, canvasElement }) => {
    // rows_are_tagged_in_words
    await expect(tags(canvasElement)).toEqual(['Turned on']);
    const [row] = canvas.getAllByRole('listitem');
    await expect(row).toHaveTextContent('Refund');
    // A mock connector is never named without "Mock".
    await expect(row).toHaveTextContent('Stripe Mock · The customer who paid, verified');
    await expect(within(row as HTMLElement).getByText('Ask me first')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Confirm and turn back on' })).toBeEnabled();
  },
};

const failedLine = "Private data would reach people who haven't confirmed it's them. The always-on rules don't allow that.";

export const ChecksFailed: Story = {
  args: {
    rows: [
      {
        key: 'rv-charges-anyone',
        change: 'added',
        title: { titles: ['See charges'] },
        connector: rivera.connectors.views.stripe,
        before: null,
        after: { mode: 'auto', reason: 'Anyone can see charges.', words: [{ field: 'who', text: 'Anyone' }] },
        changed: [],
      },
    ],
    checks: { status: 'failed', lines: [failedLine] },
    confirmLabel: undefined,
    cancelLabel: undefined,
  },
  parameters: { canvasNote: 'A draft the proofs reject; no board draws a failed check.' },
  play: async ({ canvas }) => {
    // confirm_only_when_checked: the heading and the lines say why, and confirm can't be pressed.
    const checks = canvas.getByRole('region', { name: "This change can't be applied" });
    await expect(within(checks).getByText(failedLine)).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Confirm change' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Keep my rules' })).toBeEnabled();
  },
};

export const ChecksUnavailable: Story = {
  args: {
    rows: raiseDiscount,
    checks: { status: 'unavailable', lines: ['Nothing changes until your rules can be checked. Try again in a minute.'] },
    confirmLabel: undefined,
    cancelLabel: undefined,
  },
  parameters: { canvasNote: 'The kernel in bounded mode, which never activates a draft; no board draws it.' },
  play: async ({ canvas }) => {
    // confirm_only_when_checked
    const checks = canvas.getByRole('region', { name: "Rules can't be checked right now" });
    await expect(within(checks).getByText('Nothing changes until your rules can be checked. Try again in a minute.')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Confirm change' })).toBeDisabled();
  },
};

/** busy_keeps_the_label: the confirm in flight keeps its label under one spinner; the other button only waits. */
async function expectConfirmBusy(canvasElement: HTMLElement, confirm: HTMLElement, cancel: HTMLElement) {
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).toHaveTextContent('Confirm change');
  await expect(confirm.querySelectorAll('.cd-button__spinner')).toHaveLength(1);
  await expect(cancel).toHaveAttribute('aria-disabled', 'true');
  await expect(cancel.querySelector('.cd-button__spinner')).toBeNull();
  await expect(canvasElement).not.toHaveTextContent('Confirming');
}

export const Confirming: Story = {
  args: { rows: raiseDiscount, pending: true, confirmLabel: undefined, cancelLabel: undefined },
  parameters: { canvasNote: 'The confirm in flight; no board draws it.' },
  play: async ({ args, canvas, canvasElement }) => {
    // pending keeps "Confirm change" as the button's name under its spinner, with aria-busy, and
    // nothing can be pressed twice.
    const confirm = canvas.getByRole('button', { name: 'Confirm change' });
    await expectConfirmBusy(canvasElement, confirm, canvas.getByRole('button', { name: 'Keep my rules' }));
    await confirm.click();
    await expect(args.onConfirm).not.toHaveBeenCalled();
    await expect(canvas.queryByRole('alert')).toBeNull();
  },
};

/** A screen that sets `pending` as soon as the confirm is sent, and keeps it while the change applies. */
function ConfirmsSlowly(props: ChangeReviewProps) {
  const [pending, setPending] = useState(false);
  return (
    <ChangeReview
      {...props}
      pending={pending}
      onConfirm={() => {
        void props.onConfirm();
        setPending(true);
      }}
    />
  );
}

export const ConfirmingFromTheScreen: Story = {
  args: { rows: raiseDiscount, confirmLabel: undefined, cancelLabel: undefined },
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <ConfirmsSlowly {...args} />
    </div>
  ),
  parameters: { canvasNote: 'The confirm pressed, then in flight as the screen reports it; no board draws it.' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const confirm = canvas.getByRole('button', { name: 'Confirm change' });
    const width = confirm.getBoundingClientRect().width;
    await userEvent.click(confirm);
    await expect(args.onConfirm).toHaveBeenCalledTimes(1);
    // The pressed button keeps its name and its width, its spinner in place of the label.
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Confirm change' })).toHaveAttribute('aria-busy', 'true'));
    await expect(canvas.getByRole('button', { name: 'Confirm change' })).toBe(confirm);
    await expect(confirm.getBoundingClientRect().width).toBe(width);
    await expectConfirmBusy(canvasElement, confirm, canvas.getByRole('button', { name: 'Keep my rules' }));
  },
};

export const LimitOnly: Story = {
  args: { rows: [], hasOtherChanges: true, checks: { status: 'checked', lines: ['Always-on rules still hold.'] }, confirmLabel: undefined, cancelLabel: undefined },
  parameters: { canvas: 'N-Conn-12-Chat', canvasNote: 'A draft that changes only what the screen shows above it, such as the payment limit on the Rules page; no board on this branch draws it.' },
  play: async ({ args, canvas, canvasElement }) => {
    // limit_only_change_keeps_confirm
    await expect(canvas.getByText('Your rules stay the same.')).toBeVisible();
    await expect(canvas.queryByText('No rules change.')).toBeNull();
    const confirm = canvas.getByRole('button', { name: 'Confirm change' });
    await expect(confirm).toBeEnabled();
    await expect(canvas.getByRole('button', { name: 'Keep my rules' })).toBeVisible();
    // cancel_line_only_when_asked: a raised limit cancels no link, so the screen doesn't ask for the line.
    await expectNoCancelLine(canvasElement);
    await confirm.click();
    await expect(args.onConfirm).toHaveBeenCalledTimes(1);
  },
};

export const NothingChanges: Story = {
  args: { rows: [], checks: { status: 'checked', lines: [] }, confirmLabel: undefined, cancelLabel: undefined },
  parameters: { canvasNote: 'A draft with nothing to confirm; no board draws it.' },
  play: async ({ canvas }) => {
    // No rows and nothing else: nothing to confirm, only the way back.
    await expect(canvas.getByText('No rules change.')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Confirm change' })).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Keep my rules' })).toBeEnabled();
  },
};

export const ConfirmFailed: Story = {
  args: { rows: raiseDiscount, error: "We couldn't confirm your change. Nothing changed, so you can try again.", confirmLabel: undefined, cancelLabel: undefined },
  parameters: { canvasNote: 'A confirm that failed; no board draws it.' },
  play: async ({ args, canvas }) => {
    // error shows the screen's message as an alert, and confirm works again.
    await expect(canvas.getByRole('alert')).toHaveTextContent("We couldn't confirm your change. Nothing changed, so you can try again.");
    const confirm = canvas.getByRole('button', { name: 'Confirm change' });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(args.onConfirm).toHaveBeenCalledTimes(1);
  },
};

const link = rivera.ruleCards['rv-link'];

const widenScope: ChangeRowView[] = [
  {
    key: link.card_id,
    change: 'changed',
    title: { titles: ['Payment link'] },
    connector: rivera.connectors.views.payments,
    before: { appliesTo: { titles: ['Payment link'] }, mode: 'auto', limit: '$300', reason: link.reason, words: rivera.ruleWords['rv-link'] },
    after: {
      appliesTo: 'Every tool that charges money',
      mode: 'auto',
      limit: '$300',
      reason: link.reason,
      words: rivera.ruleWords['rv-link'],
    },
    changed: ['applies_to'],
  },
];

export const WidenScope: Story = {
  args: { rows: widenScope, confirmLabel: undefined, cancelLabel: undefined },
  parameters: { canvas: 'N-Conn-02-Payments', canvasNote: 'A rule widened from one tool to every tool that charges money; no board draws this review.' },
  play: async ({ canvas }) => {
    // What a rule applies to is enforced too: each side says it, and the new one is tagged.
    const before = canvas.getByRole('group', { name: 'Before' });
    const after = canvas.getByRole('group', { name: 'After' });
    await expect(within(before).getByText('Payment link')).toBeVisible();
    const target = within(after).getByText('Every tool that charges money');
    await expect(target).toBeVisible();
    const line = target.closest('p');
    if (line === null) throw new Error('The target is not on its own line');
    await expect(within(line).getByText('Changed')).toBeVisible();
    // Only the target changed: the words, reason and outcome aren't tagged, and nothing on the before side is.
    await expect(within(after).getAllByText('Changed')).toHaveLength(1);
    await expect(within(before).queryByText('Changed')).toBeNull();
    await expect(before).toHaveTextContent('Automatic up to $300; over $300, ask me first');
    await expect(after).toHaveTextContent('Automatic up to $300; over $300, ask me first');
  },
};

export const ScopeChangedWithoutTargets: Story = {
  args: {
    rows: widenScope.map((row) => ({
      ...row,
      before: row.before && { ...row.before, appliesTo: undefined },
      after: row.after && { ...row.after, appliesTo: undefined },
    })),
    confirmLabel: undefined,
    cancelLabel: undefined,
  },
  parameters: { canvasNote: "A screen that reports a changed target without its words; no board draws it." },
  play: async ({ canvasElement }) => {
    // A change of what the rule applies to never goes unmarked: without the screen's words for
    // it, the title says the change.
    const title = canvasElement.querySelector<HTMLElement>('.cd-change-review__title');
    if (title === null) throw new Error('No title');
    await expect(title).toHaveTextContent('Payment link Changed');
    await expect(within(title).getByText('Changed')).toBeVisible();
  },
};

const FAILED = "We couldn't confirm your change. Nothing changed, so you can try again.";

/** The fixed line a change that can cancel open payment links shows above its buttons. */
const CANCELS_LINKS = "Open payment links I made on my own that the new rules don't allow will be cancelled.";

/** cancel_line_only_when_asked: no line about cancelled links unless the screen says the change can cancel them. */
async function expectNoCancelLine(root: HTMLElement) {
  await expect(root).not.toHaveTextContent('payment links I made on my own');
}

/**
 * A screen whose confirm fails every time with the same words: it clears its error when a confirm
 * starts and shows the same message when it fails, and never sets `pending`.
 */
function FailsEveryTime(props: ChangeReviewProps) {
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <ChangeReview
      {...props}
      error={error}
      onConfirm={() => {
        void props.onConfirm();
        setError(undefined);
        setTimeout(() => setError(FAILED), 0);
      }}
    />
  );
}

export const RepeatedFailure: Story = {
  args: { rows: raiseDiscount, confirmLabel: undefined, cancelLabel: undefined },
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <FailsEveryTime {...args} />
    </div>
  ),
  parameters: { canvasNote: 'A confirm that fails the same way each time it is tried; no board draws it.' },
  play: async ({ args, canvas }) => {
    // Each failure lets the owner try again, even when its words are the same as the last one's.
    const confirm = canvas.getByRole('button', { name: 'Confirm change' });
    for (const attempt of [1, 2, 3]) {
      await waitFor(() => expect(confirm).not.toHaveAttribute('aria-busy'));
      confirm.click();
      await expect(args.onConfirm).toHaveBeenCalledTimes(attempt);
      await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent(FAILED));
    }
    // A second click while one is in flight still sends nothing.
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-busy'));
    confirm.click();
    confirm.click();
    await expect(args.onConfirm).toHaveBeenCalledTimes(4);
  },
};

const ceiling: ChangeRowView[] = [
  {
    key: 'rv-big-links',
    change: 'added',
    title: { titles: ['Payment link'] },
    connector: rivera.connectors.views.payments,
    before: null,
    after: {
      mode: 'auto',
      limit: '$10,000',
      reason: 'Payment links up to $10,000 for verified customers.',
      words: [
        { field: 'who', text: 'Verified customers' },
        { field: 'limits', text: 'Up to $10,000' },
      ],
    },
    changed: [],
  },
  {
    key: link.card_id,
    change: 'changed',
    title: { titles: ['Payment link'] },
    connector: rivera.connectors.views.payments,
    before: { mode: 'auto', limit: '$300', reason: link.reason, words: rivera.ruleWords['rv-link'] },
    after: {
      mode: 'auto',
      limit: '$10,000',
      reason: link.reason,
      words: [
        { field: 'who', text: 'Anyone' },
        { field: 'limits', text: 'Up to $10,000' },
        { field: 'review', text: 'Checked by the reviewer' },
      ],
    },
    changed: ['limits'],
  },
];

export const NarrowMaxLimit: Story = {
  args: { rows: ceiling, confirmLabel: undefined, cancelLabel: undefined },
  globals: { viewport: { value: 'narrow', isRotated: false } },
  parameters: {
    canvas: 'none',
    canvasNote: 'The largest limit a rule can carry, at the narrowest phone width; no board draws this review on a phone. The nearest is N-Conn-10-GCal-Confirm.',
    viewport: { options: { narrow: { name: 'Narrow phone', styles: { width: '320px', height: '640px' }, type: 'mobile' } } },
  },
  play: async ({ canvas, canvasElement }) => {
    const width = window.innerWidth;
    await expect(width).toBe(320);
    // Every limit phrase wraps on its line, and nothing scrolls sideways.
    const phrases = canvas.getAllByText('Automatic up to $10,000; over $10,000, ask me first');
    await expect(phrases).toHaveLength(2);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width);
    await expect(tooWide).toEqual([]);
  },
};

const ASK_FIRST_CHECKS = {
  status: 'checked',
  lines: ['Checked against the always-on rules and your other rules.', 'Open times, leads, callbacks and identity checks still run on their own.'],
} as const satisfies ChangeReviewProps['checks'];

/** The Ask me first review with the board's illustrative shared rule after Payment link, where the board draws it. */
const askFirstRows = rivera.askFirstReview.flatMap((row) => (row.key === 'rv-link' ? [row, rivera.sharedChargeReviewRow] : [row]));

/** A row's After side, found by its title among the rows. */
function afterSide(rows: HTMLElement[], index: number): HTMLElement {
  const row = rows[index];
  if (row === undefined) throw new Error(`No row ${index}`);
  return within(row).getByRole('group', { name: 'After' });
}

export const AskMeFirst: Story = {
  args: { rows: askFirstRows, checks: ASK_FIRST_CHECKS, confirmLabel: undefined, cancelLabel: undefined, cancelsLinks: true },
  parameters: {
    canvas: 'N-Conn-18-Preset-Review',
    canvasNote:
      "Turner's eight own rules, Dana Whitfield's personal booking rule, which the owner's \"Allow only for Dana Whitfield, always\" adds and the board doesn't draw, and the board's shared rule for Alex Kim's assistant, an illustrative card that isn't in Turner's seed.",
  },
  play: async ({ canvas, canvasElement }) => {
    // Each of the owner's rules goes, personal and shared ones included, and its tool falls to the default ask.
    const rows = within(canvas.getByRole('region', { name: 'Changes' })).getAllByRole('listitem');
    await expect(rows.map((row) => row.querySelector('.cd-change-review__title')?.textContent)).toEqual([
      'Quote',
      'Book a visit',
      'Book a visit',
      'Book a visit',
      'Share a document',
      'Payment link',
      'Payment link and Charge within a signed limit',
      'Charge within a signed limit',
      'See charges',
      'Refund',
    ]);
    await expect(tags(canvasElement)).toEqual(Array(10).fill('Changed'));
    for (const row of rows) {
      await expect(within(row).getByRole('group', { name: 'After' })).toHaveTextContent('Not covered by a rule you set, so I ask you.');
    }
    // preset_review_tags_only_new_outcomes: Quote's outcome turns from Automatic to Ask me first,
    // so "Changed" sits beside it; Refund already asks, so its outcome has none.
    const quote = afterSide(rows, 0);
    const quoteOutcome = quote.querySelector<HTMLElement>('.cd-change-review__side-outcome');
    if (quoteOutcome === null) throw new Error('No outcome on Quote');
    await expect(quoteOutcome).toHaveTextContent('Ask me first');
    await expect(within(quoteOutcome).getByText('Changed')).toBeVisible();
    await expect(within(quote).getAllByText('Changed')).toHaveLength(1);
    const refund = afterSide(rows, 9);
    await expect(refund).toHaveTextContent('Ask me first');
    await expect(within(refund).queryByText('Changed')).toBeNull();
    // An auto rule with an amount limit reads its limit before it goes.
    await expect(within(rows[5] as HTMLElement).getByRole('group', { name: 'Before' })).toHaveTextContent(
      'Automatic up to $300; over $300, ask me first',
    );
    // A built-in connector is named alone; a mock one is never named without "Mock".
    await expect(rows[0]?.querySelector('.cd-change-review__meta')).toHaveTextContent(/^Quotes$/);
    await expect(canvasElement).not.toHaveTextContent('Built in');
    await expect(rows[9]).toHaveTextContent('Stripe Mock');
    // shared_rule_says_so: a rule shared by every tool that charges money reads "Shared rule" after
    // its connector, as the board draws it; a tool's own rule names only its connector.
    const shared = rows[6] as HTMLElement;
    await expect(shared.querySelector('.cd-change-review__meta')).toHaveTextContent(/^Payments · Shared rule$/);
    await expect(rows[5]?.querySelector('.cd-change-review__meta')).toHaveTextContent(/^Payments$/);
    await expect(canvas.getAllByText('Shared rule')).toHaveLength(1);
    await expect(within(shared).getByRole('group', { name: 'Before' })).toHaveTextContent(
      "Alex Kim's assistant · Up to $20",
    );
    // personal_rules_are_listed: a rule for one person goes too, and its row names her.
    const personal = rows[3] as HTMLElement;
    await expect(within(personal).getByRole('group', { name: 'Before' })).toHaveTextContent('Dana Whitfield');
    await expect(within(personal).getByRole('group', { name: 'Before' })).toHaveTextContent('Automatic');
    await expect(afterSide(rows, 3)).toHaveTextContent('Ask me first');
    await expect(tags(personal)).toEqual(['Changed']);
    // cancel_line_only_when_asked: a preset can cancel open payment links, so the screen asks for
    // the fixed line. It sits above the buttons, under the checks, in secondary body text.
    const line = canvas.getByText(CANCELS_LINKS);
    expectComputed(line, { fontSize: '16px', lineHeight: '22px', color: 'rgba(250, 249, 245, 0.64)' });
    const checks = canvas.getByRole('region', { name: 'Checked before you confirm' });
    const confirm = canvas.getByRole('button', { name: 'Confirm change' });
    await expect(line.getBoundingClientRect().top - checks.getBoundingClientRect().bottom).toBe(20);
    await expect(confirm.getBoundingClientRect().top - line.getBoundingClientRect().bottom).toBe(20);
    await expect(canvas.getAllByText(CANCELS_LINKS)).toHaveLength(1);
  },
};

/** A rule for one person, which a preset replaces too: Dana's refunds up to $50 without asking. */
const DANA_REASON = 'Dana Whitfield can get refunds up to $50 without asking.';
const personalRule: ChangeRowView[] = [
  {
    key: 'rv-dana-refunds',
    change: 'removed',
    title: { titles: ['Refund'] },
    connector: rivera.connectors.views.stripe,
    before: {
      mode: 'auto',
      limit: '$50',
      reason: DANA_REASON,
      words: [
        { field: 'who', text: 'Dana Whitfield, verified' },
        { field: 'limits', text: 'Up to $50' },
      ],
    },
    after: null,
    changed: [],
  },
];

export const PersonalRuleReplaced: Story = {
  args: { rows: personalRule, confirmLabel: undefined, cancelLabel: undefined },
  parameters: {
    canvas: 'N-Conn-10-GCal-Confirm',
    canvasNote: 'A rule for one person, as a preset’s review lists it when the preset replaces personal rules too; no board on this branch draws a preset’s review.',
  },
  play: async ({ canvas }) => {
    // It reads as the person's rule: the tool, then the connector and who it is for first, and the
    // rule that goes, beside the refused bar, naming her, with its limit phrase.
    const [row] = canvas.getAllByRole('listitem');
    await expect(within(row as HTMLElement).getByText('Refund')).toBeVisible();
    await expect(row).toHaveTextContent('Stripe Mock · Dana Whitfield, verified · Up to $50');
    const before = within(row as HTMLElement).getByRole('group', { name: 'Before' });
    await expect(before).toHaveTextContent('Dana Whitfield, verified · Up to $50');
    await expect(before).toHaveTextContent(DANA_REASON);
    await expect(within(before).getByText('Automatic up to $50; over $50, ask me first')).toBeVisible();
    expectComputed(before, { borderLeftColor: 'rgb(220, 130, 144)' });
    await expect(tags(row?.parentElement as HTMLElement)).toEqual(['Removed']);
  },
};

/** The default ask a rule falls to when nothing in the draft governs its tool. */
const DEFAULT_ASK = 'Not covered by a rule you set, so I ask you.';

export const RecommendedRules: Story = {
  args: { rows: rivera.recommendedReview, checks: ASK_FIRST_CHECKS, confirmLabel: undefined, cancelLabel: undefined, cancelsLinks: true },
  parameters: {
    canvas: 'N-Conn-18-Preset-Review',
    canvasNote:
      "The review of Recommended rules on Turner's Desk, drafted in his own weekday hours, which no board draws; the nearest is the Ask me first review. A rule goes to the preset's rule that covers its whole scope, or to the default ask; a preset rule nothing goes to is added; a rule the preset keeps as it is doesn't show.",
  },
  play: async ({ canvas }) => {
    const rows = within(canvas.getByRole('region', { name: 'Changes' })).getAllByRole('listitem');
    const title = (item: HTMLElement) => item.querySelector('.cd-change-review__title')?.textContent;
    const kind = (item: HTMLElement) => item.querySelector('.cd-change-review__tag')?.textContent;
    const side = (item: HTMLElement, name: 'Before' | 'After') => within(item).queryByRole('group', { name });
    const outcome = (item: HTMLElement) => side(item, 'After')?.querySelector('.cd-change-review__side-outcome');
    // The rows, in Turner's order; the preset adds none.
    await expect(rows.map((item) => [kind(item), title(item)])).toEqual([
      ['Changed', 'Book a visit'],
      ['Changed', 'Book a visit'],
      ['Changed', 'Payment link'],
      ['Changed', 'Charge within a signed limit'],
      ['Changed', 'See charges'],
      ['Changed', 'Refund'],
    ]);
    // unchanged_rules_are_left_out: the preset quotes at list price, books weekdays in Turner's own
    // hours and words, and shares documents with verified customers, as his rules already do, so none
    // shows: the two booking rows are Saturday's and Dana's.
    await expect(rows.map(title)).not.toContain('Quote');
    await expect(rows.map(title)).not.toContain('Share a document');
    const [saturday, dana, link, mandate, charges, refund] = rows as HTMLElement[];
    for (const item of [saturday, dana] as HTMLElement[]) await expect(side(item, 'Before')).not.toHaveTextContent('Weekdays, 8:00 am to 6:00 pm');
    // uncovered_scopes_ask: no card of the preset covers Saturday mornings, Dana's any-time rule or
    // seeing charges, so each falls to the default ask, its new outcome tagged; none of them reads
    // "Automatic" after.
    for (const item of [saturday, dana, charges] as HTMLElement[]) {
      await expect(side(item, 'After')).toHaveTextContent(DEFAULT_ASK);
      await expect(outcome(item)).toHaveTextContent('Ask me firstChanged');
      await expect(side(item, 'After')).not.toHaveTextContent('Automatic');
    }
    await expect(side(dana as HTMLElement, 'Before')).toHaveTextContent('Dana Whitfield');
    // replaced_rules_show_the_preset_rule: payment links and signed-limit charges go to the
    // preset's rule for every tool that charges money, and Refund to its rule for sending money out.
    for (const item of [link, mandate] as HTMLElement[]) {
      await expect(side(item, 'After')).toHaveTextContent('Every tool that charges money');
      await expect(outcome(item)).toHaveTextContent('Ask me firstChanged');
    }
    await expect(side(refund as HTMLElement, 'After')).toHaveTextContent('Every tool that sends money out');
    // Refund already asked, so its outcome isn't tagged.
    await expect(outcome(refund as HTMLElement)).toHaveTextContent(/^Ask me first$/);
  },
};

