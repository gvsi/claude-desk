import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, fn, waitFor, within } from 'storybook/test';

import type { DemoInboxEntry } from '../../../api/contracts.ts';
import { requestHrefOf } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { Button } from '../Button/Button.tsx';
import type { DemoInboxItem } from '../DemoInboxPanel/DemoInboxPanel.tsx';
import { Notice } from '../Notice/Notice.tsx';
import { DemoInboxSheet, type DemoInboxSheetProps } from './DemoInboxSheet.tsx';

/** Dana's code, as the kernel sends it to her number on record. */
const CODE_NOTICE = { entry_id: 'inbox-code-dana', to: '•••• 0143', preview: 'New verification code' };
const CODE_ENTRY: DemoInboxEntry = {
  entry_id: 'inbox-code-dana',
  to: '•••• 0143',
  kind: 'verification_code',
  body: 'Your Turner Plumbing code is 482913. It works for 10 minutes.',
  created_at: '2026-10-30T10:46:00Z',
  decision_id: null,
};
const CODE: DemoInboxItem = { notice: CODE_NOTICE, entry: CODE_ENTRY };

/**
 * An alert to the owner about a held request, titled with its preview line as the owner reads it.
 * A visitor never sees it.
 */
const ALERT: DemoInboxItem = {
  notice: { entry_id: 'inbox-alert-hold', to: 'owner', preview: 'A request needs your answer' },
  entry: {
    entry_id: 'inbox-alert-hold',
    to: 'owner',
    kind: 'alert',
    body: 'Dana Whitfield asked for 10% off a drain clearing. Held by your rule: Quotes from your price list, at list price.',
    created_at: '2026-10-30T10:46:00Z',
    decision_id: 'dec-rivera-discount',
    title: 'A request needs your answer',
  },
  time: 'Today, 10:46 am',
};

/** The event a story sends the screen below, carrying the items as they now stand. */
const SCREEN_ITEMS = 'cd-story-inbox-sheet-items';

/** The event a story sends to take the sheet off the screen, as a screen swaps it for another view. */
const SCREEN_REMOVE = 'cd-story-inbox-sheet-remove';

/** The event a story sends to clear the sheet's notice, as a screen does once a read works. */
const SCREEN_CLEAR_NOTICE = 'cd-story-inbox-sheet-clear-notice';

/** A page with something to type in, the sheet's button, and whatever items the story sends. */
function Screen(args: DemoInboxSheetProps) {
  const [items, setItems] = useState(args.items);
  const [shown, setShown] = useState(true);
  const [notice, setNotice] = useState(args.notice);
  useEffect(() => {
    const onItems = (event: Event) => {
      if (event instanceof CustomEvent) setItems(event.detail as DemoInboxItem[]);
    };
    const onRemove = () => setShown(false);
    const onClearNotice = () => setNotice(undefined);
    window.addEventListener(SCREEN_ITEMS, onItems);
    window.addEventListener(SCREEN_REMOVE, onRemove);
    window.addEventListener(SCREEN_CLEAR_NOTICE, onClearNotice);
    return () => {
      window.removeEventListener(SCREEN_ITEMS, onItems);
      window.removeEventListener(SCREEN_REMOVE, onRemove);
      window.removeEventListener(SCREEN_CLEAR_NOTICE, onClearNotice);
    };
  }, []);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-16)', padding: 'var(--space-16)' }}>
      <label className="cd-type-control" style={{ display: 'grid', gap: 'var(--space-6)' }}>
        Code
        <input className="cd-type-body" style={{ height: 'var(--size-control-main)' }} />
      </label>
      <div>{shown ? <DemoInboxSheet {...args} items={items} notice={notice} /> : null}</div>
    </div>
  );
}

function send(root: HTMLElement, items: DemoInboxItem[]): void {
  root.ownerDocument.defaultView?.dispatchEvent(new CustomEvent(SCREEN_ITEMS, { detail: items }));
}

const meta = {
  title: 'Verification/DemoInboxSheet',
  component: DemoInboxSheet,
  args: { viewer: 'visitor', language: 'en', items: [], onRetry: fn(), onOpenChange: fn() },
  render: (args) => <Screen {...args} />,
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { layout: 'fullscreen', canvas: 'N-R2-Inbox-Sheet-Public' },
} satisfies Meta<typeof DemoInboxSheet>;

export default meta;

type Story = StoryObj<typeof meta>;

export const OpensOnTheFirstCode: Story = {
  parameters: { canvasNote: 'On a phone: the code arrives while the visitor types, and the sheet opens itself from the bottom, over a dimmed, inert page.' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const field = canvas.getByRole('textbox', { name: 'Code' });
    await userEvent.click(field);
    const button = canvas.getByRole('button', { name: 'Demo inbox' });
    await expect(canvas.queryByRole('dialog')).toBeNull();

    // inbox_sheet_opens_on_the_first_code: the first entry a visitor may see opens the sheet.
    send(canvasElement, [{ notice: CODE_NOTICE, entry: null }]);
    const sheet = await canvas.findByRole('dialog', { name: 'Demo inbox' });
    await waitFor(() => expect(args.onOpenChange).toHaveBeenLastCalledWith(true));
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    await expect(sheet.matches(':modal')).toBe(true);
    // The count says how many entries wait in it.
    await expect(button).toHaveAccessibleName('Demo inbox 1 entry');
    // inbox_sheet_opening_by_itself_focuses_its_heading: focus moves in, to the sheet's heading, not
    // to Close, which the visitor's next keystroke would press. The page behind is inert, so Tab
    // stays in the sheet.
    const heading = within(sheet).getByRole('heading', { level: 2, name: 'Demo inbox' });
    await waitFor(() => expect(heading).toHaveFocus());
    await expect(heading).toHaveAttribute('tabindex', '-1');
    await userEvent.tab();
    await expect(sheet.contains(document.activeElement)).toBe(true);
    // The entry arrives in it: the code, word for word.
    send(canvasElement, [CODE]);
    await expect(await within(sheet).findByText(CODE_ENTRY.body)).toBeVisible();

    // A bottom sheet on the raised surface, its top edge ruled and rounded, the page dimmed.
    const box = sheet.getBoundingClientRect();
    await expect([Math.round(box.left), Math.round(box.right), Math.round(box.bottom)]).toEqual([0, window.innerWidth, window.innerHeight]);
    expectComputed(sheet, { backgroundColor: 'rgb(42, 41, 39)', borderTopWidth: '1px', borderTopLeftRadius: '12px', borderBottomLeftRadius: '0px' });
    await expect(getComputedStyle(sheet, '::backdrop').backgroundColor).toBe('rgba(0, 0, 0, 0.5)');

    // Escape closes it and focus goes back to where the visitor was typing.
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByRole('dialog')).toBeNull();
    await expect(field).toHaveFocus();
    await expect(args.onOpenChange).toHaveBeenLastCalledWith(false);

    // It opens itself once: a later entry doesn't open it again.
    send(canvasElement, [CODE, { notice: { ...CODE_NOTICE, entry_id: 'inbox-code-dana-2' }, entry: null }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(canvas.queryByRole('dialog')).toBeNull();
    await expect(button).toHaveAccessibleName('Demo inbox 2 entries');

    // Opened from its button, focus goes to Close, and back to the button when it closes.
    await userEvent.click(button);
    const reopened = canvas.getByRole('dialog', { name: 'Demo inbox' });
    const close = within(reopened).getByRole('button', { name: 'Close' });
    await waitFor(() => expect(close).toHaveFocus());
    await userEvent.click(close);
    await expect(canvas.queryByRole('dialog')).toBeNull();
    await expect(button).toHaveFocus();
    await expect(args.onOpenChange).toHaveBeenLastCalledWith(false);
    await expect(args.onOpenChange).toHaveBeenCalledTimes(4);
  },
};

export const EmptyPeekThenFirstCode: Story = {
  parameters: { canvas: 'none', canvasNote: 'N-R2-Inbox-Sheet-Public before the code: the visitor opens the empty sheet and closes it, and the first code still opens it.' },
  play: async ({ canvas, canvasElement, userEvent }) => {
    // inbox_sheet_opens_on_the_first_code_after_an_empty_peek: looking before anything arrived
    // doesn't use up the sheet's one opening by itself.
    const button = canvas.getByRole('button', { name: 'Demo inbox' });
    await userEvent.click(button);
    const empty = canvas.getByRole('dialog', { name: 'Demo inbox' });
    await expect(empty).toHaveTextContent('Nothing here yet.');
    await userEvent.click(within(empty).getByRole('button', { name: 'Close' }));
    await expect(canvas.queryByRole('dialog')).toBeNull();
    send(canvasElement, [CODE]);
    const sheet = await canvas.findByRole('dialog', { name: 'Demo inbox' });
    await expect(within(sheet).getByText(CODE_ENTRY.body)).toBeVisible();
  },
};

export const OwnerNoticesStayHidden: Story = {
  args: { items: [] },
  parameters: { canvas: 'none', canvasNote: 'N-R2-Inbox-Sheet-Public with an owner’s alert in the screen’s items: a visitor never sees it, it isn’t counted, and it opens nothing.' },
  play: async ({ canvas, canvasElement, userEvent }) => {
    send(canvasElement, [ALERT]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(canvas.queryByRole('dialog')).toBeNull();
    const button = canvas.getByRole('button', { name: 'Demo inbox' });
    await expect(button.querySelector('.cd-count-pill')).toBeNull();
    await userEvent.click(button);
    const sheet = canvas.getByRole('dialog', { name: 'Demo inbox' });
    await expect(sheet).not.toHaveTextContent(ALERT.entry!.body);
    await expect(sheet).not.toHaveTextContent(ALERT.notice.preview);
  },
};

export const Spanish: Story = {
  args: { language: 'es', items: [CODE] },
  parameters: { canvas: 'none', canvasNote: 'N-R2-Inbox-Sheet-Public in Spanish: the button, the sheet and Close in Spanish, the code as the kernel wrote it.' },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Bandeja de demostración 1 entrada' }));
    const sheet = canvas.getByRole('dialog', { name: 'Bandeja de demostración' });
    await expect(within(sheet).getByRole('button', { name: 'Cerrar' })).toHaveFocus();
    await expect(sheet).toHaveAttribute('lang', 'es');
  },
};

export const Owner: Story = {
  args: { viewer: 'owner', items: [ALERT] },
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: { canvas: 'N-R2-Inbox-Sheet-Owner', canvasNote: 'The owner’s Demo inbox on Today: a side sheet at the right, 400 px, opened from its button.' },
  play: async ({ args, canvas, userEvent }) => {
    // The owner's sheet doesn't open itself: the owner opens it.
    await expect(canvas.queryByRole('dialog')).toBeNull();
    await expect(args.onOpenChange).not.toHaveBeenCalled();
    const button = canvas.getByRole('button', { name: 'Demo inbox 1 entry' });
    await userEvent.click(button);
    // sheet_says_when_it_opens_and_closes: the screen hears each change, and only changes.
    await expect(args.onOpenChange).toHaveBeenLastCalledWith(true);
    const sheet = canvas.getByRole('dialog', { name: 'Demo inbox' });
    const box = sheet.getBoundingClientRect();
    await expect([Math.round(box.width), Math.round(box.right), Math.round(box.top), Math.round(box.bottom)]).toEqual([400, 1512, 0, 982]);
    expectComputed(sheet, { borderLeftWidth: '1px', borderLeftColor: 'rgba(250, 249, 245, 0.14)', backgroundColor: 'rgb(42, 41, 39)' });
    await expect(within(sheet).getByText('What Claude would have sent you by text or email. Nothing is really sent.')).toBeVisible();
    await expect(within(sheet).getByText(ALERT.entry!.body)).toBeVisible();
    await expect(within(sheet).getByText('A request needs your answer', { exact: true })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(button).toHaveFocus();
    await expect(args.onOpenChange).toHaveBeenLastCalledWith(false);
    await expect(args.onOpenChange).toHaveBeenCalledTimes(2);
  },
};

export const OwnerOpensTheRequest: Story = {
  args: { viewer: 'owner', items: [{ ...ALERT, requestHref: requestHrefOf(ALERT.entry) }] },
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    canvas: 'N-R2-Inbox-Sheet-Owner',
    canvasNote: 'The owner follows “Open the request” under an alert, which the board draws but doesn’t act out: the sheet closes, so the request isn’t left under it.',
  },
  play: async ({ args, canvas, userEvent }) => {
    // following_a_link_closes_the_sheet: the link goes where it says, and the sheet doesn't stay
    // over the page it opens.
    await userEvent.click(canvas.getByRole('button', { name: 'Demo inbox 1 entry' }));
    const sheet = canvas.getByRole('dialog', { name: 'Demo inbox' });
    // The story's page stays put: the link's own navigation is stopped and its target kept, as a
    // router would take it over.
    let followed: string | null = null;
    const keep = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a') : null;
      if (!link) return;
      event.preventDefault();
      followed = link.getAttribute('href');
    };
    const link = within(sheet).getByRole('link', { name: 'Open the request' });
    window.addEventListener('click', keep, true);
    try {
      // A click that opens a new tab leaves this page, and the sheet, as they are.
      await userEvent.keyboard('{Meta>}');
      await userEvent.click(link);
      await userEvent.keyboard('{/Meta}');
      await expect(canvas.getByRole('dialog', { name: 'Demo inbox' })).toBeVisible();
      followed = null;
      await userEvent.click(link);
    } finally {
      window.removeEventListener('click', keep, true);
    }
    await expect(followed).toBe('#request-dec-rivera-discount');
    await expect(canvas.queryByRole('dialog')).toBeNull();
    await expect(args.onOpenChange).toHaveBeenLastCalledWith(false);
    // Closing returns focus to the sheet's button; the screen then moves it to the request.
    await expect(canvas.getByRole('button', { name: 'Demo inbox 1 entry' })).toHaveFocus();
  },
};


export const OwnerReadFailed: Story = {
  args: {
    viewer: 'owner',
    items: [ALERT],
    notice: (
      <Notice tone="error" action={<Button variant="secondary">Try again</Button>}>
        Couldn’t open your Demo inbox. Something went wrong on our side. Try again in a moment.
      </Notice>
    ),
  },
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    canvas: 'none',
    canvasNote: 'Built against N-R2-Inbox-Sheet-Owner-ReadFailed, in review: the owner’s sheet when the latest read failed, with the screen’s error Notice under the subtitle and above the entries as last read.',
  },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Demo inbox 1 entry' }));
    const sheet = canvas.getByRole('dialog', { name: 'Demo inbox' });
    // read_failure_shows_in_the_sheet: the line the screen passes sits inside the sheet, under its
    // subtitle and above the entries, so the owner doesn't take the last read for the current one.
    const line = within(sheet).getByRole('alert');
    await expect(line).toHaveTextContent('Couldn’t open your Demo inbox.');
    const subtitle = within(sheet).getByText('What Claude would have sent you by text or email. Nothing is really sent.');
    const [entry] = within(sheet).getAllByRole('listitem') as [HTMLElement];
    const notice = line.getBoundingClientRect();
    await expect(Math.round(notice.top - subtitle.getBoundingClientRect().bottom)).toBe(10);
    await expect(Math.round(entry.getBoundingClientRect().top - notice.bottom)).toBe(10);
    const retry = within(sheet).getByRole('button', { name: 'Try again' });
    await expect(retry).toBeVisible();
    await expect(within(entry).getByText(ALERT.entry!.body)).toBeVisible();

    // focus_stays_in_the_sheet_when_the_notice_goes: once a read works the screen clears the
    // notice; focus on its Try again moves to the sheet's heading, not out of the sheet.
    retry.focus();
    window.dispatchEvent(new CustomEvent(SCREEN_CLEAR_NOTICE));
    await waitFor(() => expect(within(sheet).queryByRole('alert')).toBeNull());
    await waitFor(() => expect(within(sheet).getByRole('heading', { level: 2, name: 'Demo inbox' })).toHaveFocus());
  },
};

export const RemovedWhileOpen: Story = {
  args: { viewer: 'owner', items: [ALERT] },
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: { canvas: 'none', canvasNote: 'N-R2-Inbox-Sheet-Owner’s sheet taken off the screen while it is open, as a screen swaps it for another view, which no board shows.' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // sheet_says_it_closed_when_removed: a screen that takes an open sheet away still hears it close.
    await userEvent.click(canvas.getByRole('button', { name: 'Demo inbox 1 entry' }));
    await expect(args.onOpenChange).toHaveBeenLastCalledWith(true);
    canvasElement.ownerDocument.defaultView?.dispatchEvent(new CustomEvent(SCREEN_REMOVE));
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(args.onOpenChange).toHaveBeenLastCalledWith(false));
    await expect(args.onOpenChange).toHaveBeenCalledTimes(2);
  },
};
