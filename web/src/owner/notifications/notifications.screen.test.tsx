/**
 * Notifications in a real browser against the mock API, as REV-NOTIF draws it: the sidebar's row
 * under Safety with a count of the unread ones, which goes as the page shows them; the page's days
 * and rows, newest first, with a dot on each entry that was unread as the page opened; its empty
 * state; on a laptop and on a phone, where the row is in the Menu sheet. The demo bar has no Demo
 * inbox of its own any more. A failed read is the loading, Today and verify screens' to check.
 */
import { describe, expect, it } from 'vitest';
import type { RenderResult } from 'vitest-browser-react';

import type { DemoInboxEntry } from '../../api/contracts.ts';
import { expectComputed } from '../../ds/test/expectComputed.ts';
import { formatDate } from '../../lib/format.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';

const DESK = `/app/${RIVERA.deskId}`;
const TODAY = `${DESK}/today`;
const NOTIFICATIONS = `${DESK}/notifications`;
const TIMEZONE = 'America/Los_Angeles';
const SUBTITLE = 'What Claude would have sent you by text or email. Nothing is really sent.';
const PRIMARY = 'rgba(250, 249, 245, 0.92)';
const SECONDARY = 'rgba(250, 249, 245, 0.64)';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Adds an entry to the copy's inbox, `msAgo` before now. */
function addEntry(fields: Pick<DemoInboxEntry, 'kind' | 'to' | 'body'>, msAgo: number): DemoInboxEntry {
  const entry: DemoInboxEntry = {
    entry_id: `test-entry-${mockStore.world.inbox.length}`,
    created_at: new Date(Date.now() - msAgo).toISOString(),
    decision_id: null,
    ...fields,
  };
  mockStore.world.inbox.push({ entry, deskId: RIVERA.deskId, sessionId: null });
  return entry;
}

const nav = (screen: RenderResult) => screen.getByRole('navigation', { name: 'Main' });
const notificationsRow = (screen: RenderResult) => nav(screen).getByRole('link', { name: /^Notifications/ });
const unreadPill = (screen: RenderResult) => notificationsRow(screen).element().querySelector('.cd-count-pill');
const rows = (screen: RenderResult) => [...screen.getByRole('main').element().querySelectorAll<HTMLElement>('.cd-notifications__item')];
const dotted = (row: HTMLElement) => row.querySelector('.cd-notifications__dot--unread') !== null;

describe('Notifications', () => {
  it('unread_count_goes_as_the_page_shows_them', async () => {
    const code = addEntry({ kind: 'verification_code', to: 'd•••@example.com', body: 'Your Turner Plumbing code is 305817.' }, DAY_MS);
    const total = mockStore.world.inbox.length;
    const { screen } = await renderRoute(TODAY);

    // The row under Safety, with every entry unread; the demo bar keeps only Start over.
    const labels = () => [...nav(screen).element().querySelectorAll('.cd-sidebar__label')].map((label) => label.textContent);
    await expect.poll(labels).toContain('Notifications');
    expect(labels().indexOf('Notifications')).toBe(labels().indexOf('Safety') + 1);
    await expect.poll(() => unreadPill(screen)?.getAttribute('aria-label')).toBe(`${total} unread`);
    expect(screen.getByRole('button', { name: /Demo inbox/ }).query()).toBeNull();
    await expect.element(screen.getByRole('note').getByRole('button', { name: 'Start over' })).toBeVisible();

    // Opened, the page shows them all with their dots, and the count goes.
    await notificationsRow(screen).click();
    const main = screen.getByRole('main');
    await expect.element(main.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
    await expect.element(main.getByText(SUBTITLE, { exact: true })).toBeVisible();
    await expect.poll(() => rows(screen)).toHaveLength(total);
    expect(notificationsRow(screen).element().getAttribute('aria-current')).toBe('page');
    await expect.poll(() => unreadPill(screen)).toBeNull();
    expect(rows(screen).every(dotted)).toBe(true);
    expectComputed(rows(screen)[0]!.querySelector<HTMLElement>('.cd-notifications__entry')!, { color: PRIMARY });

    // Newest first, under their days: Today, then the code's date. Each row has its time only.
    const days = [...main.element().querySelectorAll('h2')].map((heading) => heading.textContent);
    expect(days).toEqual(['Today', formatDate(code.created_at, TIMEZONE)]);
    const codeRow = rows(screen).at(-1)!;
    expect(codeRow.querySelector('.cd-notifications__kind')?.textContent).toBe('Unread: Verification code · To d•••@example.com');
    expect(codeRow.querySelector('.cd-notifications__time')?.textContent).toMatch(/^\d{1,2}:\d{2} [ap]m$/);
    // The owner's own alert says nothing about who it went to.
    const alertRow = rows(screen)[0]!;
    expect(alertRow.querySelector('.cd-notifications__kind')?.textContent).toBe('Unread: Alert');
    // The last row of a day has no hairline under it: the next day's line separates them.
    for (const list of main.element().querySelectorAll('.cd-notifications__list')) {
      const last = list.lastElementChild as HTMLElement;
      expect(getComputedStyle(last).borderBottomWidth).toBe('0px');
    }

    // The dots stay for the visit. Back again, nothing is unread and the bodies take the quieter ink.
    await nav(screen).getByRole('link', { name: /^Today/ }).click();
    await expect.element(main.getByRole('heading', { level: 1, name: 'Notifications' })).not.toBeInTheDocument();
    expect(unreadPill(screen)).toBeNull();
    await notificationsRow(screen).click();
    await expect.poll(() => rows(screen)).toHaveLength(total);
    expect(rows(screen).some(dotted)).toBe(false);
    expectComputed(rows(screen)[0]!.querySelector<HTMLElement>('.cd-notifications__entry')!, { color: SECONDARY });

    // One that arrives while the page is open reads as new, and is seen as it shows.
    addEntry({ kind: 'alert', to: 'owner', body: 'Dana Whitfield is waiting in a conversation the Desk handed to you.' }, 0);
    await expect.poll(() => rows(screen)).toHaveLength(total + 1);
    expect(dotted(rows(screen)[0]!)).toBe(true);
    expect(unreadPill(screen)).toBeNull();
  });

  it('empty_page_says_what_shows_up_here', async () => {
    mockStore.world.inbox.splice(0);
    const { screen } = await renderRoute(NOTIFICATIONS);
    const main = screen.getByRole('main');
    await expect.element(main.getByText('Nothing here yet', { exact: true })).toBeVisible();
    await expect.element(main.getByText('Codes and alerts you’d get by text or email show up here.', { exact: true })).toBeVisible();
    expect(rows(screen)).toHaveLength(0);
    expect(unreadPill(screen)).toBeNull();
    await expectScreenBasics(screen.container, { owner: true });
  });

  it.each(['desktop', 'phone'] as const)('page_fits_and_keeps_its_row_on_%s', async (viewport) => {
    addEntry({ kind: 'head_checkpoint', to: 'owner', body: `{"head":"${'5c1e9a0b77d24f6e'.repeat(8)}","seq":48}` }, 2 * DAY_MS);
    const { screen } = await renderRoute(TODAY, { viewport });
    if (viewport === 'phone') {
      // On a phone the row is in the Menu sheet, under Safety, with its count.
      await screen.getByRole('button', { name: 'Menu' }).click();
      await expect.element(screen.getByRole('dialog', { name: 'Menu' })).toBeVisible();
    }
    await expect.poll(() => unreadPill(screen)?.textContent).toBe(String(mockStore.world.inbox.length));
    await notificationsRow(screen).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
    await expect.poll(() => rows(screen)).toHaveLength(mockStore.world.inbox.length);
    // The checkpoint's signed record wraps inside the column, in the trace's monospace.
    const trace = screen.getByRole('main').element().querySelector<HTMLElement>('.cd-notifications__entry.cd-type-trace')!;
    expect(trace.scrollWidth).toBeLessThanOrEqual(trace.clientWidth);
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });
  });
});
