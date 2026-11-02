import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, fn, within } from 'storybook/test';

import type { DemoInboxEntry, InboxNotice } from '../../../api/contracts.ts';
import { chen, requestHrefOf } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { DemoInboxPanel, type DemoInboxItem, type DemoInboxPanelProps } from './DemoInboxPanel.tsx';

const BOARD = 'N-Public-Verify-Run1';

const { notices, entries } = chen.demoInbox;
/** The owner's display times, by `entry_id`. */
const ownerTimes: Readonly<Record<string, string>> = chen.demoInbox.ownerTimes;

function noticeOf(entryId: string): InboxNotice {
  const notice = notices.find((n) => n.entry_id === entryId);
  if (!notice) throw new Error(`no fixture notice ${entryId}`);
  return notice;
}

function entryOf(entryId: string): DemoInboxEntry {
  const entry = entries.find((e) => e.entry_id === entryId);
  if (!entry) throw new Error(`no fixture entry ${entryId}`);
  return entry;
}

const CODE_ID = 'inbox-code-raj';
/** Linda's alert about the held consultation, which names that decision. */
const HOLD_ID = 'inbox-hold-consultation';
/** The kernel's title for that alert: its preview line, as the owner reads it. */
const HOLD_TITLE = 'A request needs your answer';

/** Raj's code, opened: the notice and the entry fetched for it. */
const codeOpened: DemoInboxItem = { notice: noticeOf(CODE_ID), entry: entryOf(CODE_ID) };

/**
 * Linda's whole inbox as a screen holds it: every entry opened, with the owner's display times, in
 * the order they arrived (the fixture lists them newest first).
 */
const everythingArrived: DemoInboxItem[] = [...notices].reverse().map((notice) => ({
  notice,
  entry: entryOf(notice.entry_id),
  time: ownerTimes[notice.entry_id],
}));

/** The event a story sends the screen below, carrying the panel's items as they now stand. */
const SCREEN_ITEMS = 'cd-story-inbox-items';

/** The panel as a screen holds it, with whatever items the story sends: a notice, then its entry. */
function UpdatingScreen(args: DemoInboxPanelProps) {
  const [items, setItems] = useState(args.items);
  useEffect(() => {
    const onItems = (event: Event) => {
      if (event instanceof CustomEvent) setItems(event.detail as DemoInboxItem[]);
    };
    window.addEventListener(SCREEN_ITEMS, onItems);
    return () => window.removeEventListener(SCREEN_ITEMS, onItems);
  }, []);
  return <DemoInboxPanel {...args} items={items} />;
}

/** Sends the screen its items as they now stand, as a notice or a fetched entry would. */
function updateScreen(root: HTMLElement, items: DemoInboxItem[]): void {
  root.ownerDocument.defaultView?.dispatchEvent(new CustomEvent(SCREEN_ITEMS, { detail: items }));
}

const meta = {
  title: 'Verification/DemoInboxPanel',
  component: DemoInboxPanel,
  args: { viewer: 'visitor', language: 'en', items: [codeOpened], onRetry: fn() },
  // The board's column: 260 px wide and as tall as the page, between hairlines.
  decorators: [
    (Story) => (
      <div
        style={{
          display: 'grid',
          width: '260px',
          maxWidth: '100%',
          minHeight: '100vh',
          borderLeft: '1px solid var(--line-hairline)',
          borderRight: '1px solid var(--line-hairline)',
        }}
      >
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: 'fullscreen',
    canvas: BOARD,
    canvasNote: `The board's middle column draws this panel by hand, in a dashed box from before the panel was built. The entry's body is the kernel's code message (inbox_code_body), longer than the board's shortened one.`,
  },
} satisfies Meta<typeof DemoInboxPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The panel's entries, as list items, top to bottom. */
function itemsOf(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('li')];
}

export const WithCode: Story = {
  play: async ({ canvas, canvasElement }) => {
    // A named region on the panel ground, titled and explained like the board.
    const panel = canvas.getByRole('region', { name: 'Demo inbox' });
    expectComputed(panel, { backgroundColor: 'rgb(34, 34, 32)', paddingTop: '24px', paddingLeft: '16px', paddingRight: '16px' });
    const title = within(panel).getByRole('heading', { level: 2, name: 'Demo inbox' });
    expectComputed(title, { fontSize: '15px', lineHeight: '20px', fontWeight: '520', color: 'rgba(250, 249, 245, 0.92)' });
    const subtitle = within(panel).getByText('Stands in for a phone or email inbox. Nothing is really sent.');
    expectComputed(subtitle, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(subtitle.getBoundingClientRect().top - title.getBoundingClientRect().bottom).toBe(10);

    // list_role_survives_unstyled_markers: the entries' list keeps role="list", which Safari drops
    // from a list whose markers are removed.
    await expect(panel.querySelector('ul')).toHaveAttribute('role', 'list');

    // One entry: who it went to, what kind it is, and the kernel's body word for word.
    const items = itemsOf(panel);
    await expect(items).toHaveLength(1);
    const [item] = items as [HTMLElement];
    await expect(item.getBoundingClientRect().top - subtitle.getBoundingClientRect().bottom).toBe(10);
    expectComputed(item, {
      paddingTop: '12px',
      paddingLeft: '14px',
      borderTopWidth: '1px',
      borderTopColor: 'rgba(250, 249, 245, 0.14)',
      borderTopLeftRadius: '12px',
      backgroundColor: 'rgba(250, 249, 245, 0.03)',
    });
    const to = within(item).getByText('To •••• 0142');
    expectComputed(to, { fontSize: '12px', lineHeight: '17px', color: 'rgba(250, 249, 245, 0.64)' });
    const kind = within(item).getByText('Verification code');
    expectComputed(kind, { fontSize: '13px', lineHeight: '18px', fontWeight: '520', color: 'rgba(250, 249, 245, 0.92)' });
    await expect(kind.getBoundingClientRect().top - to.getBoundingClientRect().bottom).toBe(4);
    const body = within(item).getByText(entryOf(CODE_ID).body);
    expectComputed(body, { fontSize: '14px', lineHeight: '20px', color: 'rgba(250, 249, 245, 0.92)' });
    await expect(body.getBoundingClientRect().top - kind.getBoundingClientRect().bottom).toBe(2);

    // inbox_announces_new_entries: the entries sit in a polite live region inside the panel, so a
    // new one is read out when it arrives. The title and subtitle are outside it, read once.
    const live = item.closest('[aria-live]');
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(panel.contains(live)).toBe(true);
    await expect(live?.contains(title)).toBe(false);
    await expect(live?.contains(subtitle)).toBe(false);
  },
};

/** Six digits in a row: a code, wherever it might show. */
const SIX_DIGITS = /\d{6}/;

export const Opening: Story = {
  args: { items: [{ notice: noticeOf(CODE_ID), entry: null }] },
  play: async ({ canvas, canvasElement }) => {
    // code_only_from_entry: until its entry is fetched, an item shows the notice's code-free
    // preview and that it is opening, never a body or anything like a code.
    const [item] = itemsOf(canvasElement) as [HTMLElement];
    await expect(within(item).getByText('To •••• 0142')).toBeVisible();
    await expect(within(item).getByText('New verification code')).toBeVisible();
    await expect(within(item).getByRole('status')).toHaveTextContent('Opening');
    await expect(canvasElement.textContent).not.toContain(entryOf(CODE_ID).body);
    await expect(canvasElement.textContent).not.toMatch(SIX_DIGITS);
    // Its kind isn't known until the entry is.
    await expect(canvas.queryByText('Verification code')).toBeNull();
    await expect(canvas.queryByRole('button')).toBeNull();
  },
};

export const OpenFailed: Story = {
  args: { items: [{ notice: noticeOf(CODE_ID), entry: null, failed: true }] },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // retry_on_open_failure: the preview, a line that says the entry didn't open, and a way to
    // fetch it again, which names the entry. Still nothing like a code.
    const [item] = itemsOf(canvasElement) as [HTMLElement];
    await expect(within(item).getByText('New verification code')).toBeVisible();
    await expect(within(item).getByRole('alert')).toHaveTextContent('Couldn’t open this entry.');
    await expect(within(item).queryByRole('status')).toBeNull();
    await expect(canvasElement.textContent).not.toMatch(SIX_DIGITS);
    const retry = within(item).getByRole('button', { name: 'Try again' });
    await userEvent.click(retry);
    await expect(args.onRetry).toHaveBeenCalledTimes(1);
    await expect(args.onRetry).toHaveBeenCalledWith(CODE_ID);
  },
};

export const OwnerAlerts: Story = {
  args: { viewer: 'owner', items: everythingArrived },
  parameters: {
    canvasNote: `No board shows the owner's Demo inbox; this is ${BOARD}'s panel holding Linda's code, hold alert and ledger checkpoint, with the times her screen passes in. The alert reads under the title the kernel gives it, its preview line.`,
  },
  play: async ({ canvasElement }) => {
    // inbox_newest_first: the items came oldest first; the panel shows the newest at the top.
    // owner_alert_reads_under_its_title: the hold's alert shows its preview line where a code or a
    // checkpoint shows its kind.
    const items = itemsOf(canvasElement);
    const newestFirst = [...everythingArrived].reverse();
    await expect(items).toHaveLength(newestFirst.length);
    for (const [index, item] of items.entries()) {
      const { notice, entry, time } = newestFirst[index] as DemoInboxItem;
      await expect(within(item).getByText(`To ${notice.to}`)).toBeVisible();
      await expect(within(item).getByText(entry?.body ?? '')).toBeVisible();
      // The owner sees when each arrived, on the line with who it went to.
      const shownTime = within(item).getByText(time ?? '');
      await expect(shownTime.getBoundingClientRect().top).toBe(within(item).getByText(`To ${notice.to}`).getBoundingClientRect().top);
    }
    await expect(items.map((item) => item.querySelector('.cd-demo-inbox__kind')?.textContent)).toEqual([
      'Verification code',
      HOLD_TITLE,
      'Ledger checkpoint',
    ]);
    await expect(items.map((item) => item.querySelector('.cd-demo-inbox__time')?.textContent)).toEqual(['2:14 pm', '11:12 am', '9:30 am']);
    // A ledger checkpoint is the kernel's signed record, word for word, so it reads in the trace's
    // monospace; codes and alerts read in the interface's type.
    const [code, alert, checkpoint] = items.map((item) => item.querySelector('.cd-demo-inbox__body') as HTMLElement);
    expectComputed(checkpoint as HTMLElement, { fontFamily: /JetBrains Mono/, fontSize: '12.5px', lineHeight: '18px' });
    for (const body of [code, alert]) expectComputed(body as HTMLElement, { fontFamily: /Hanken Grotesk/, fontSize: '14px' });
  },
};

/** The request link a screen builds from a fixture entry's `decision_id`, which the entry must name. */
function requestHrefFor(entryId: string): string {
  const href = requestHrefOf(entryOf(entryId));
  if (!href) throw new Error(`fixture entry ${entryId} names no request`);
  return href;
}

/** Where the held request Linda's alert is about sits on the page, built from the alert's decision_id. */
const REQUEST_HREF = requestHrefFor(HOLD_ID);

/** Linda's inbox with a request link on every item, as a careless screen might pass it. */
const everythingWithLinks: DemoInboxItem[] = everythingArrived.map((item) => ({ ...item, requestHref: REQUEST_HREF }));

export const OwnerAlertOpensItsRequest: Story = {
  args: { viewer: 'owner', items: everythingWithLinks },
  parameters: {
    canvas: 'N-R2-Inbox-Sheet-Owner',
    canvasNote: `${BOARD}'s panel holding Linda's code, hold alert and ledger checkpoint, each passed a request link: only the alert shows "Open the request", under its body, as N-R2-Inbox-Sheet-Owner draws it.`,
  },
  play: async ({ canvasElement }) => {
    // alert_opens_its_request: an owner's alert links to the held request it is about, 8 px under
    // the kernel's words. A code or a ledger checkpoint never does, whatever the screen passes in.
    const [code, alert, checkpoint] = itemsOf(canvasElement) as [HTMLElement, HTMLElement, HTMLElement];
    const link = within(alert).getByRole('link', { name: 'Open the request' });
    await expect(link).toHaveAttribute('href', REQUEST_HREF);
    const body = alert.querySelector('.cd-demo-inbox__body') as HTMLElement;
    const line = link.closest('.cd-demo-inbox__request') as HTMLElement;
    await expect(Math.round(line.getBoundingClientRect().top - body.getBoundingClientRect().bottom)).toBe(8);
    for (const item of [code, checkpoint]) await expect(within(item).queryByRole('link')).toBeNull();
  },
};

export const ReplayedNotice: Story = {
  args: {
    viewer: 'owner',
    // After a reconnect the screen replays the events it missed, so Raj's code arrives twice: first
    // still opening, then with its entry fetched. The alert and the checkpoint arrived in between.
    items: [{ notice: noticeOf(CODE_ID), entry: null }, ...everythingArrived],
  },
  parameters: {
    canvasNote: `${BOARD}'s panel after a reconnect replayed a notice it already had, which no board shows: one row per entry.`,
  },
  play: async ({ canvasElement }) => {
    // notices_show_once: one row per entry_id, the latest item for it, in the latest one's place.
    const items = itemsOf(canvasElement);
    await expect(items).toHaveLength(everythingArrived.length);
    await expect(items.map((item) => item.querySelector('.cd-demo-inbox__kind')?.textContent)).toEqual([
      'Verification code',
      HOLD_TITLE,
      'Ledger checkpoint',
    ]);
    const [code] = items as [HTMLElement];
    await expect(within(code).getByText(entryOf(CODE_ID).body)).toBeVisible();
    await expect(within(code).queryByRole('status')).toBeNull();
    await expect(canvasElement.textContent?.split(entryOf(CODE_ID).body)).toHaveLength(2);
  },
};

/** No clock time, in any form: visitor surfaces show none. */
const CLOCK = /\d{1,2}:\d{2}|\b(?:am|pm)\b/i;

/**
 * Two more owner notices whose entries haven't opened: a lockout alert still being fetched, and a
 * second hold alert whose fetch failed. A visitor's panel must show neither, before or after.
 */
const ownerStillOpening: DemoInboxItem = {
  notice: { entry_id: 'inbox-lockout-chen', to: 'owner', preview: 'Verification paused for a contact' },
  entry: null,
};
const ownerFailedToOpen: DemoInboxItem = {
  notice: { entry_id: 'inbox-hold-chen-2', to: 'owner', preview: 'Another request needs your answer' },
  entry: null,
  failed: true,
};

export const VisitorGivenAlert: Story = {
  args: {
    viewer: 'visitor',
    items: [...everythingArrived, ownerStillOpening, ownerFailedToOpen].map((item) => ({ ...item, requestHref: '/app/main/today' })),
  },
  parameters: {
    canvasNote: `${BOARD}'s visitor panel, handed the owner's alerts and ledger checkpoint by mistake, opened, still opening and failed to open (the kernel never sends a visitor any of them); it shows only the code.`,
  },
  play: async ({ canvas, canvasElement }) => {
    // visitor_sees_only_codes: a visitor's panel shows verification codes and nothing else, even
    // when a screen passes it more, and no time. An owner's notice shows no row at all: not
    // while its entry is opening, not when it failed to open, and not once it has.
    const items = itemsOf(canvasElement);
    await expect(items).toHaveLength(1);
    await expect(within(items[0] as HTMLElement).getByText(entryOf(CODE_ID).body)).toBeVisible();
    const text = canvasElement.textContent ?? '';
    for (const hidden of entries.filter((entry) => entry.kind !== 'verification_code')) {
      await expect(text).not.toContain(hidden.body);
      await expect(text).not.toContain(noticeOf(hidden.entry_id).preview);
      if (hidden.title) await expect(text).not.toContain(hidden.title);
    }
    for (const { notice } of [ownerStillOpening, ownerFailedToOpen]) await expect(text).not.toContain(notice.preview);
    await expect(canvas.queryByRole('status')).toBeNull();
    await expect(canvas.queryByRole('alert')).toBeNull();
    await expect(canvas.queryByRole('button', { name: 'Try again' })).toBeNull();
    await expect(canvas.queryByText('Alert')).toBeNull();
    await expect(canvas.queryByText('Ledger checkpoint')).toBeNull();
    await expect(canvas.queryByText('To owner')).toBeNull();
    // A request link is the owner's: a visitor's panel shows none, even on their own code.
    await expect(canvas.queryByRole('link')).toBeNull();
    await expect(text).not.toMatch(CLOCK);
  },
};

export const OwnerAlertNotOpenYet: Story = {
  args: { viewer: 'owner', items: [ownerStillOpening, ownerFailedToOpen].map((item) => ({ ...item, requestHref: REQUEST_HREF })) },
  parameters: {
    canvasNote: `${BOARD}'s owner panel with two alerts whose entries haven't opened, each passed a request link, which no board shows: a link waits for its alert's words.`,
  },
  play: async ({ canvas, canvasElement }) => {
    // request_link_waits_for_the_entry: an alert still opening, or one that failed to open, shows
    // no link, only its preview and its state.
    await expect(itemsOf(canvasElement)).toHaveLength(2);
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};

/** Linda's hold alert, opened, as her screen holds it. */
const holdAlert = everythingArrived.find((item) => item.entry?.kind === 'alert') as DemoInboxItem;

/** Where the owner app opens the held request Linda's alert is about: a path in the app. */
const IN_APP_HREF = '/app/main/today#request-dec-chen-consultation';

export const OwnerAlertLinkIsAPathInTheApp: Story = {
  args: { viewer: 'owner', items: [{ ...holdAlert, requestHref: IN_APP_HREF }] },
  parameters: {
    canvasNote: `${BOARD}'s owner panel with the request link as the owner app builds it, a path in the app, which no board shows: the alert links there.`,
  },
  play: async ({ canvas }) => {
    // request_link_stays_in_the_app: a path in the app draws a link, as a place on the page does.
    await expect(canvas.getByRole('link', { name: 'Open the request' })).toHaveAttribute('href', IN_APP_HREF);
  },
};

export const OwnerAlertLinkLeavesTheApp: Story = {
  args: { viewer: 'owner', items: [{ ...holdAlert, requestHref: '//elsewhere.example/request' }] },
  parameters: {
    canvasNote: `${BOARD}'s owner panel with a request link that leaves the owner app, which no screen builds: the alert shows no link.`,
  },
  play: async ({ canvas, canvasElement }) => {
    // request_link_stays_in_the_app: only a path in the app or a place on the page draws a link.
    await expect(within(itemsOf(canvasElement)[0] as HTMLElement).getByText(holdAlert.entry?.body ?? '')).toBeVisible();
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};

/** A path that starts with a slash and a backslash, which a browser reads as another site. */
const BACKSLASH_HREF = '/\\elsewhere.example/request';

export const OwnerAlertLinkLeavesTheAppByBackslash: Story = {
  args: { viewer: 'owner', items: [{ ...holdAlert, requestHref: BACKSLASH_HREF }] },
  parameters: {
    canvasNote: `${BOARD}'s owner panel with a request link that looks like a path in the app but leaves it, which no screen builds: the alert shows no link.`,
  },
  play: async ({ canvas, canvasElement }) => {
    // request_link_stays_in_the_app: a browser resolves "/\elsewhere.example" to another site, so
    // it draws no link, however much it looks like a path.
    await expect(new URL(BACKSLASH_HREF, window.location.href).origin).not.toBe(window.location.origin);
    await expect(within(itemsOf(canvasElement)[0] as HTMLElement).getByText(holdAlert.entry?.body ?? '')).toBeVisible();
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};

export const OwnerAlertInSpanish: Story = {
  args: { viewer: 'owner', language: 'es', items: [{ ...holdAlert, requestHref: REQUEST_HREF }] },
  parameters: {
    canvasNote: `${BOARD}'s owner panel in Spanish, which no board shows: the alert reads as its kind, "Aviso", since the kernel's titles are English only, and the request link is in Spanish.`,
  },
  play: async ({ canvas, canvasElement }) => {
    // owner_titles_are_english_only: the Spanish panel reads the titled alert as its kind.
    const [alert] = itemsOf(canvasElement) as [HTMLElement];
    await expect(alert.querySelector('.cd-demo-inbox__kind')).toHaveTextContent(/^Aviso$/);
    await expect(alert.textContent).not.toContain(HOLD_TITLE);
    await expect(canvas.getByRole('link', { name: 'Abrir la solicitud' })).toHaveAttribute('href', REQUEST_HREF);
    await expect(canvas.queryByRole('link', { name: 'Open the request' })).toBeNull();
  },
};

export const OwnerAlertWithoutTitle: Story = {
  args: { viewer: 'owner', items: [{ ...holdAlert, entry: { ...entryOf(HOLD_ID), title: null }, requestHref: REQUEST_HREF }] },
  parameters: {
    canvasNote: `${BOARD}'s owner panel with an alert the kernel sent no title for, which no board shows: it reads as its kind, "Alert".`,
  },
  play: async ({ canvasElement }) => {
    // untitled_alert_reads_as_its_kind: without a title, an alert's line is its kind, as before.
    const [alert] = itemsOf(canvasElement) as [HTMLElement];
    await expect(alert.querySelector('.cd-demo-inbox__kind')).toHaveTextContent(/^Alert$/);
    await expect(within(alert).getByText(entryOf(HOLD_ID).body)).toBeVisible();
    await expect(within(alert).getByRole('link', { name: 'Open the request' })).toHaveAttribute('href', REQUEST_HREF);
    await expect(alert.textContent).not.toContain(HOLD_TITLE);
  },
};

/** Raj's code as the kernel writes it for a visitor chatting in Spanish (its `inbox_code_body`). */
const codeEs: DemoInboxEntry = {
  ...entryOf(CODE_ID),
  body: 'Tu código de Chen & Co. CPA es 482913. Vence en diez minutos. Si no lo pediste, ignora este mensaje.',
};

export const SpanishVisitor: Story = {
  args: { language: 'es', items: [{ notice: chen.verifyStarted.es.inbox[0] as InboxNotice, entry: codeEs }] },
  parameters: {
    canvasNote: `${BOARD}'s panel in Spanish, which no board shows: the panel's words from its copy, the entry's from the kernel's Spanish template.`,
  },
  play: async ({ canvas, canvasElement }) => {
    // spanish_labels: the panel's own words in Spanish, and no English one.
    const panel = canvas.getByRole('region', { name: 'Bandeja de demostración' });
    await expect(panel).toHaveAttribute('lang', 'es');
    await expect(within(panel).getByRole('heading', { level: 2 })).toHaveTextContent('Bandeja de demostración');
    await expect(within(panel).getByText('Hace de bandeja de teléfono o correo. No se envía nada de verdad.')).toBeVisible();
    const [item] = itemsOf(canvasElement) as [HTMLElement];
    await expect(within(item).getByText('Para •••• 0142')).toBeVisible();
    await expect(within(item).getByText('Código de verificación')).toBeVisible();
    await expect(within(item).getByText(codeEs.body)).toBeVisible();
    const text = panel.textContent ?? '';
    for (const english of ['Demo inbox', 'Stands in for', 'Nothing is really sent', 'To ', 'Verification code']) {
      await expect(text).not.toContain(english);
    }
  },
};

const EMPTY_LINE = 'Nothing here yet. Codes and alerts you’d get by text or email show up here.';

export const Empty: Story = {
  args: { items: [] },
  render: (args) => <UpdatingScreen {...args} />,
  parameters: {
    canvasNote: `${BOARD}'s panel before anything has arrived, which no board shows.`,
  },
  play: async ({ canvas, canvasElement }) => {
    // Nothing yet: one line that says what will show up here, and no list.
    const panel = canvas.getByRole('region', { name: 'Demo inbox' });
    const empty = within(panel).getByText(EMPTY_LINE);
    expectComputed(empty, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(within(panel).queryByRole('list')).toBeNull();

    // inbox_announces_new_entries: the polite region is there before anything arrives, and what
    // arrives lands inside that same region, so a screen reader reads it out: first the notice,
    // then its entry once fetched.
    const live = empty.closest('[aria-live]');
    await expect(live).toHaveAttribute('aria-live', 'polite');
    updateScreen(canvasElement, [{ notice: noticeOf(CODE_ID), entry: null }]);
    const arrived = await within(panel).findByRole('listitem');
    await expect(arrived.closest('[aria-live]')).toBe(live);
    await expect(within(arrived).getByRole('status')).toHaveTextContent('Opening');
    await expect(within(panel).queryByText(EMPTY_LINE)).toBeNull();
    updateScreen(canvasElement, [codeOpened]);
    const body = await within(panel).findByText(entryOf(CODE_ID).body);
    await expect(body.closest('[aria-live]')).toBe(live);

    // The story ends as it is named.
    updateScreen(canvasElement, []);
    await within(panel).findByText(EMPTY_LINE);
  },
};
