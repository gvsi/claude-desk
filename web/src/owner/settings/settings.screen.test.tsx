/**
 * Settings in a real browser against the mock API: its sections, with no connectors (they have
 * their own tab); General's details from the copy's Desks, its Answering switch (the sidebar's,
 * the same control) and deleting a Desk; Notifications and Billing as vision; each as its signed
 * board draws it, on a laptop and on a phone.
 */
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { RenderResult } from 'vitest-browser-react';

import { ROUTES } from '../../api/routes.ts';
import { SPEC, expectFooterAtFoot, one } from '../../ds/boards/spec.ts';
import { expectComputed } from '../../ds/test/expectComputed.ts';
import { worker } from '../../mocks/browser.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { expectOwnerBoard } from '../../test/boards.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';

const DESK = `/app/${RIVERA.deskId}`;
const SETTINGS = `${DESK}/settings`;
const GENERAL = `${SETTINGS}/general`;
const NOTIFICATIONS = `${SETTINGS}/notifications`;
const BILLING = `${SETTINGS}/billing`;

/** What Answering on means, under General's switch (owner decision, 2026-10-30: the short line everywhere). */
const ANSWERING_LINE = 'Within your rules';

/** What deleting a Desk does, beside its button and in the dialog that asks first. */
const DELETE_LINE = 'Its public link stops working and its chats close. Its safety record is kept.';

/** The owner's line when a delete's answer and the read after it were both lost, as the Answering switch words its own. */
const UNCONFIRMED = "We couldn't confirm that Main line was deleted. Reload to see where it stands.";

/** The owner's line for a request the server failed. */
const UNAVAILABLE = 'Something went wrong on our side. Try again in a moment.';

/** The owner's lines for a delete refused outright: a conflict, and too many requests at once. */
const REFUSED: readonly (readonly [status: number, line: string])[] = [
  [409, 'This changed while you were looking. Reload to see where it stands.'],
  [429, "That's a lot of requests at once. Wait a moment, then try again."],
];

/** Notifications' lead, under its vision note. */
const NOTIFICATIONS_LEAD = 'Held requests and paused chats reach your Demo inbox right away. Other alerts wait for your briefing.';

/** The alerts set for a plumber, as the board writes them: when, which, and how they arrive. */
const PLUMBER = [
  ['Right away', 'Held requests, paused chats and emergencies', 'Demo inbox'],
  ['In your briefing', 'New leads, bookings and payments', 'Each morning at 7:00 am'],
  ['Not at all', 'Messages Claude answered on its own'],
];

/** The sections Settings ships with, in order. Channels joins when its page does. */
const SECTIONS = ['General', 'Knowledge', 'Notifications', 'Billing'];

/** The requests a route got, by key. */
const requests = (key: string) => mockStore.requests.filter((r) => r.key === key);

function main(screen: RenderResult) {
  return screen.getByRole('main');
}

/** Settings' own navigation. */
function subNav(screen: RenderResult) {
  return main(screen).getByRole('navigation', { name: 'Settings' });
}

/** The section SubNav marks as the page the owner is on. */
function currentSection(screen: RenderResult): (string | null)[] {
  return subNav(screen)
    .getByRole('link')
    .elements()
    .filter((link) => link.getAttribute('aria-current') === 'page')
    .map((link) => link.textContent);
}

afterEach(() => {
  localStorage.clear();
});

describe('Settings', () => {
  it('settings_sub_nav_without_connectors', async () => {
    // Settings opens on General, under the sidebar's Settings row.
    const { screen, router } = await renderRoute(SETTINGS);
    await expect.element(main(screen).getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect.poll(() => router.state.location.pathname).toBe(GENERAL);
    const sidebar = screen.getByRole('complementary', { name: 'Claude Desk' });
    await expect.element(sidebar.getByRole('link', { name: /^Settings/ })).toHaveAttribute('aria-current', 'page');

    // Its sections in order, General current once its page is drawn (SubNav's links are there
    // before, on the way from `settings` to General); nothing about connectors, which have their own tab.
    await expect.poll(() => subNav(screen).getByRole('link').elements().map((link) => link.textContent)).toEqual(SECTIONS);
    await expect.element(main(screen).getByRole('region', { name: 'Your business' })).toBeVisible();
    await expect.poll(() => currentSection(screen)).toEqual(['General']);
    expect(main(screen).element().textContent).not.toMatch(/Integrations|Connectors/);

    // Each section at its own address, marked as the current one, with its own page drawn.
    for (const [name, path, region] of [
      ['Notifications', NOTIFICATIONS, 'Set for a plumber'],
      ['Billing', BILLING, 'Plan'],
      ['General', GENERAL, 'Your business'],
    ] as const) {
      await subNav(screen).getByRole('link', { name }).click();
      await expect.poll(() => router.state.location.pathname).toBe(path);
      await expect.poll(() => currentSection(screen)).toEqual([name]);
      await expect.element(main(screen).getByRole('region', { name: region })).toBeVisible();
      expect(main(screen).element().textContent).not.toMatch(/Integrations|Connectors/);
    }
    expect(requests('setAnswering')).toEqual([]);

    // Integrations, and anything under it, isn't a page.
    for (const path of [`${SETTINGS}/integrations`, `${SETTINGS}/integrations/stripe`]) {
      const missing = await renderRoute(path);
      await expect.element(missing.screen.getByRole('main', { name: "This page doesn't exist" })).toBeVisible();
    }
  });

  it('general_shows_the_business_details', async () => {
    const { screen } = await renderRoute(GENERAL);
    const business = main(screen).getByRole('region', { name: 'Your business' });
    await expect.element(business).toBeVisible();

    // Each label over its value, from the copy's Desks: the business, this Desk, the name customers
    // see, the time zone as the owner reads it, and the Desk's hours.
    const terms = business.getByRole('term').elements().map((term) => term.textContent);
    const values = business.getByRole('definition').elements().map((value) => value.textContent);
    expect(terms.map((term, index) => [term, values[index]])).toEqual([
      ['Business', 'Turner Plumbing'],
      ['This Desk', 'Main line'],
      ['Customers see you as', 'Mike Turner'],
      ['Time zone', 'Pacific Time (Los Angeles)'],
      // In the signed board's words, pinned here rather than worked out from the formatter.
      ['Hours', 'Weekdays 8:00 am to 6:00 pm, Saturdays 9:00 am to 1:00 pm'],
    ]);
    // Read-only: nothing in them can be changed here.
    expect(business.getByRole('button').elements()).toEqual([]);
    expect(business.getByRole('link').elements()).toEqual([]);

    // Another Desk's details are its own: its name and its hours. Its window is all day, which no
    // board draws, so it reads as Rules writes one, with the comma.
    const emergencies = await renderRoute(`/app/${RIVERA.emergenciesDeskId}/settings/general`, { seed: 'rivera_two_desks' });
    const other = main(emergencies.screen).getByRole('region', { name: 'Your business' });
    await expect.element(other.getByText('Emergencies', { exact: true })).toBeVisible();
    expect(other.getByRole('definition').elements().map((value) => value.textContent)).toEqual([
      'Turner Plumbing',
      'Emergencies',
      'Mike Turner',
      'Pacific Time (Los Angeles)',
      'Every day, all day',
    ]);
  });

  it('answering_is_one_switch', async () => {
    const { screen } = await renderRoute(GENERAL);
    const sidebar = screen.getByRole('complementary', { name: 'Claude Desk' }).getByRole('switch', { name: 'Claude acts for you' });
    const page = main(screen).getByRole('switch', { name: 'Claude acts for you' });
    const saved = () => mockStore.world.desk(RIVERA.deskId)?.summary.answering;
    await expect.element(page).toHaveAttribute('aria-checked', 'true');
    await expect.element(page).toHaveAccessibleDescription(ANSWERING_LINE);
    await expect.element(main(screen).getByRole('region', { name: 'Claude acts for you' })).toBeVisible();

    // General's switch sends one change, and the sidebar's follows it.
    await page.click();
    await screen.getByRole('dialog').getByRole('button', { name: /^(Take messages only|Let Claude act)$/ }).click();
    await expect.element(page).toHaveAttribute('aria-checked', 'false');
    await expect.element(sidebar).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => saved()).toBe(false);
    expect(requests('setAnswering').map((r) => r.body)).toEqual([{ on: false }]);

    // The sidebar's sends one too, and General's follows it.
    await sidebar.click();
    await screen.getByRole('dialog').getByRole('button', { name: /^(Take messages only|Let Claude act)$/ }).click();
    await expect.element(page).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => saved()).toBe(true);
    expect(requests('setAnswering').map((r) => r.body)).toEqual([{ on: false }, { on: true }]);

    // A change that didn't save puts both back, with the sidebar's line.
    mockStore.inject({ route: 'setAnswering', status: 500, delayMs: 400 });
    await page.click();
    await screen.getByRole('dialog').getByRole('button', { name: /^(Take messages only|Let Claude act)$/ }).click();
    await expect.element(sidebar).toHaveAttribute('aria-checked', 'false');
    await expect.element(screen.getByRole('alert')).toHaveTextContent("That didn’t save, so Claude is still acting for you.");
    await expect.element(page).toHaveAttribute('aria-checked', 'true');
    await expect.element(sidebar).toHaveAttribute('aria-checked', 'true');
    expect(requests('setAnswering')).toHaveLength(3);
    expect(saved()).toBe(true);
  });

  it('answering_off_hands_a_price_question_to_maria', async () => {
    // Turned off here, Answering is what a visitor's chat goes by: a price question gets the
    // handoff card, as asking for Mike does, with no quote and nothing decided for it.
    const { screen } = await renderRoute(GENERAL);
    await main(screen).getByRole('switch', { name: 'Claude acts for you' }).click();
    await screen.getByRole('dialog').getByRole('button', { name: /^(Take messages only|Let Claude act)$/ }).click();
    await expect.poll(() => mockStore.world.desk(RIVERA.deskId)?.summary.answering).toBe(false);
    expect(requests('setAnswering').map((r) => r.body)).toEqual([{ on: false }]);

    const params = { slug: RIVERA.slug };
    expect(await mockStore.dispatch('openSession', { params })).toMatchObject({ status: 200 });
    expect(await mockStore.dispatch('sendMessage', { params, body: { text: 'How much to clear a drain?' } })).toMatchObject({ status: 202 });
    const session = mockStore.visitorSession(RIVERA.slug);
    expect(session?.ownerPreview).toBe(false);
    await expect.poll(() => session?.events.some(({ ev }) => ev.type === 'turn_end'), { timeout: 3_000 }).toBe(true);
    const shown = session?.events.flatMap(({ ev }) => (ev.type === 'message' ? ev.blocks.map((block) => block.template) : []));
    expect(shown).toEqual(['handoff']);
    const decided = [...mockStore.world.decisions.values()].filter((d) => d.decision.session_id === session?.state.session_id);
    expect(decided).toEqual([]);
  });

  it('delete_desk_confirms', async () => {
    const { screen, router } = await renderRoute(GENERAL, { seed: 'rivera_two_desks' });
    const section = main(screen).getByRole('region', { name: 'Delete this Desk' });
    await expect.element(section.getByText(DELETE_LINE, { exact: true })).toBeVisible();
    const remove = section.getByRole('button', { name: 'Delete this Desk' });

    // It asks first, with "Keep it" focused; Escape keeps the Desk, and focus goes back.
    await remove.click();
    const dialog = screen.getByRole('dialog', { name: 'Delete Main line?' });
    await expect.element(dialog).toHaveAccessibleDescription(DELETE_LINE);
    await expect.element(dialog.getByRole('button', { name: 'Keep it' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
    await expect.element(remove).toHaveFocus();

    // "Keep it" too.
    await remove.click();
    await screen.getByRole('dialog', { name: 'Delete Main line?' }).getByRole('button', { name: 'Keep it' }).click();
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
    expect(requests('deleteDesk')).toEqual([]);

    // A delete the server failed says so and changes nothing: still on Settings, the Desk still there.
    mockStore.inject({ route: 'deleteDesk', status: 500 });
    await remove.click();
    await screen.getByRole('dialog', { name: 'Delete Main line?' }).getByRole('button', { name: 'Delete Desk' }).click();
    await expect.element(section.getByRole('alert')).toHaveTextContent(UNAVAILABLE);
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe(GENERAL);
    expect(mockStore.world.desk(RIVERA.deskId)).toBeDefined();
    expect(requests('deleteDesk')).toHaveLength(1);

    // A delete refused outright (a conflict, too many requests) leaves no doubt that it didn't go
    // through: the page says why at once, without reading the copy again, and changes nothing.
    for (const [status, line] of REFUSED) {
      mockStore.inject({ route: 'deleteDesk', status });
      const reads = requests('desks').length;
      await remove.click();
      await screen.getByRole('dialog', { name: 'Delete Main line?' }).getByRole('button', { name: 'Delete Desk' }).click();
      await expect.element(section.getByRole('alert')).toHaveTextContent(line);
      await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
      expect(requests('desks')).toHaveLength(reads);
      expect(router.state.location.pathname).toBe(GENERAL);
      expect(mockStore.world.desk(RIVERA.deskId)).toBeDefined();
    }

    // Confirmed: one delete, answered 204, then the other Desk's Today, with no "not found" on the way.
    const sawNotFound = watchFor("This page doesn't exist");
    await remove.click();
    await screen.getByRole('dialog', { name: 'Delete Main line?' }).getByRole('button', { name: 'Delete Desk' }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`/app/${RIVERA.emergenciesDeskId}/today`);
    expect(requests('deleteDesk').map((r) => r.path)).toEqual([0, 1, 2, 3].map(() => `/api/owner/desks/${RIVERA.deskId}`));
    expect(mockStore.world.desk(RIVERA.deskId)).toBeUndefined();
    await expect.element(screen.getByRole('button', { name: /^Switch Desk/ })).not.toBeInTheDocument();
    await expect.element(screen.getByRole('heading', { level: 1, name: /, Mike$/ })).toBeVisible();
    expect(sawNotFound()).toBe(false);

    // A delete whose answer was lost but which went through is never reported as failed: the copy
    // is read again, and without the Desk the owner moves on as from a 204, with no "not found" on the way.
    const lost = await renderRoute(GENERAL, { seed: 'rivera_two_desks' });
    await expect.element(main(lost.screen).getByRole('button', { name: 'Delete this Desk' })).toBeVisible();
    const lostSawNotFound = watchFor("This page doesn't exist");
    mockStore.inject({ route: 'deleteDesk', status: 'network', afterCommit: true });
    await main(lost.screen).getByRole('button', { name: 'Delete this Desk' }).click();
    await lost.screen.getByRole('dialog', { name: 'Delete Main line?' }).getByRole('button', { name: 'Delete Desk' }).click();
    await expect.poll(() => lost.router.state.location.pathname).toBe(`/app/${RIVERA.emergenciesDeskId}/today`);
    await expect.element(lost.screen.getByRole('heading', { level: 1, name: /, Mike$/ })).toBeVisible();
    expect(lost.screen.getByText(UNAVAILABLE).elements()).toEqual([]);
    expect(lostSawNotFound()).toBe(false);

    // Both answers lost: the delete went through, and the read after it failed too. The page says it
    // can't confirm the delete, offers no second delete, and reads the copy again when asked.
    const unsure = await renderRoute(GENERAL, { seed: 'rivera_two_desks' });
    await expect.element(main(unsure.screen).getByRole('button', { name: 'Delete this Desk' })).toBeVisible();
    const unsureSawNotFound = watchFor("This page doesn't exist");
    mockStore.inject({ route: 'deleteDesk', status: 'network', afterCommit: true });
    mockStore.inject({ route: 'desks', status: 'network' });
    await main(unsure.screen).getByRole('button', { name: 'Delete this Desk' }).click();
    await unsure.screen.getByRole('dialog', { name: 'Delete Main line?' }).getByRole('button', { name: 'Delete Desk' }).click();
    const unconfirmed = main(unsure.screen).getByRole('region', { name: 'Delete this Desk' }).getByRole('alert');
    // The line, then its one action: read the copy again. Focus moves to it from the Delete button it replaced.
    await expect.element(unconfirmed).toHaveTextContent(`${UNCONFIRMED}Reload`);
    await expect.element(unconfirmed.getByRole('button', { name: 'Reload' })).toHaveFocus();
    await expect.element(unsure.screen.getByRole('dialog')).not.toBeInTheDocument();
    expect(main(unsure.screen).getByRole('button', { name: 'Delete this Desk' }).elements()).toEqual([]);
    expect(unsure.router.state.location.pathname).toBe(GENERAL);
    expect(mockStore.world.desk(RIVERA.deskId)).toBeUndefined();

    // Another read of the copy's Desks lands meanwhile, without the Desk (here Answering's own, after
    // a change whose answer was lost). The page still says it can't confirm the delete, rather than
    // "not found", until the owner reloads.
    mockStore.inject({ route: 'setAnswering', status: 'network', afterCommit: true });
    const reads = requests('desks').length;
    await main(unsure.screen).getByRole('switch', { name: 'Claude acts for you' }).click();
    await unsure.screen.getByRole('dialog').getByRole('button', { name: /^(Take messages only|Let Claude act)$/ }).click();
    await expect.poll(() => requests('desks').length).toBeGreaterThan(reads);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect.element(unconfirmed).toHaveTextContent(`${UNCONFIRMED}Reload`);
    expect(unsure.router.state.location.pathname).toBe(GENERAL);

    const before = requests('desks').length;
    await unconfirmed.getByRole('button', { name: 'Reload' }).click();
    await expect.poll(() => unsure.router.state.location.pathname).toBe(`/app/${RIVERA.emergenciesDeskId}/today`);
    await expect.element(unsure.screen.getByRole('heading', { level: 1, name: /, Mike$/ })).toBeVisible();
    expect(requests('desks').length).toBeGreaterThan(before);
    expect(requests('deleteDesk')).toHaveLength(1);
    expect(unsureSawNotFound()).toBe(false);

    // Both answers lost, and the delete never reached the copy: Reload, pressed from the keyboard,
    // finds the Desk still there, so the notice goes and focus is back on Delete this Desk.
    const kept = await renderRoute(GENERAL, { seed: 'rivera_two_desks' });
    const keptSection = main(kept.screen).getByRole('region', { name: 'Delete this Desk' });
    await expect.element(keptSection.getByRole('button', { name: 'Delete this Desk' })).toBeVisible();
    mockStore.inject({ route: 'deleteDesk', status: 'network' });
    mockStore.inject({ route: 'desks', status: 'network' });
    await keptSection.getByRole('button', { name: 'Delete this Desk' }).click();
    await kept.screen.getByRole('dialog', { name: 'Delete Main line?' }).getByRole('button', { name: 'Delete Desk' }).click();
    await expect.element(keptSection.getByRole('alert').getByRole('button', { name: 'Reload' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect.element(keptSection.getByRole('button', { name: 'Delete this Desk' })).toHaveFocus();
    expect(keptSection.getByRole('alert').elements()).toEqual([]);
    expect(kept.router.state.location.pathname).toBe(GENERAL);
    expect(mockStore.world.desk(RIVERA.deskId)).toBeDefined();
    expect(requests('deleteDesk')).toHaveLength(1);

    // Deleted elsewhere (another tab) since the page was read: the delete answers not found, and the
    // copy, read again, doesn't list the Desk, so the owner moves on as from a 204.
    const elsewhere = await renderRoute(GENERAL, { seed: 'rivera_two_desks' });
    await expect.element(main(elsewhere.screen).getByRole('button', { name: 'Delete this Desk' })).toBeVisible();
    expect(await mockStore.dispatch('deleteDesk', { params: { desk_id: RIVERA.deskId } })).toMatchObject({ status: 204 });
    await main(elsewhere.screen).getByRole('button', { name: 'Delete this Desk' }).click();
    await elsewhere.screen.getByRole('dialog', { name: 'Delete Main line?' }).getByRole('button', { name: 'Delete Desk' }).click();
    await expect.poll(() => elsewhere.router.state.location.pathname).toBe(`/app/${RIVERA.emergenciesDeskId}/today`);
    expect(elsewhere.screen.getByRole('alert').elements()).toEqual([]);

    // Not found for a Desk the copy still lists (an API that doesn't serve the delete, or a wrong
    // path) isn't taken as gone: the copy, read again, still has it, so the delete didn't go through.
    // The page says so and stays, with the Desk and its Delete button.
    const unserved = await renderRoute(GENERAL, { seed: 'rivera_two_desks' });
    const unservedSection = main(unserved.screen).getByRole('region', { name: 'Delete this Desk' });
    await expect.element(unservedSection.getByRole('button', { name: 'Delete this Desk' })).toBeVisible();
    mockStore.inject({ route: 'deleteDesk', status: 404 });
    const readsBefore404 = requests('desks').length;
    await unservedSection.getByRole('button', { name: 'Delete this Desk' }).click();
    await unserved.screen.getByRole('dialog', { name: 'Delete Main line?' }).getByRole('button', { name: 'Delete Desk' }).click();
    await expect.element(unservedSection.getByRole('alert')).toHaveTextContent(UNAVAILABLE);
    expect(requests('desks').length).toBeGreaterThan(readsBefore404);
    expect(unserved.router.state.location.pathname).toBe(GENERAL);
    expect(mockStore.world.desk(RIVERA.deskId)).toBeDefined();
    await expect.element(unservedSection.getByRole('button', { name: 'Delete this Desk' })).toBeVisible();

    // The business's last Desk: deleting it opens setup, to make another.
    const last = await renderRoute(GENERAL, { seed: 'rivera' });
    await main(last.screen).getByRole('button', { name: 'Delete this Desk' }).click();
    await last.screen.getByRole('dialog', { name: 'Delete Main line?' }).getByRole('button', { name: 'Delete Desk' }).click();
    await expect.poll(() => last.router.state.location.pathname).toBe('/app/setup');
    expect(requests('deleteDesk')).toHaveLength(1);
  });

  it('lost_delete_reads_the_desks_again', async () => {
    // A read of the copy's Desks is already out when the delete is sent (Answering's switch reads
    // them again once its change saves), and its answer, the Desks as they were then, comes late.
    const { screen, router } = await renderRoute(GENERAL, { seed: 'rivera_two_desks' });
    const page = main(screen);
    await expect.element(page.getByRole('button', { name: 'Delete this Desk' })).toBeVisible();
    const early = holdNextDesksRead();
    const sawNotFound = watchFor("This page doesn't exist");
    await page.getByRole('switch', { name: 'Claude acts for you' }).click();
    await screen.getByRole('dialog').getByRole('button', { name: /^(Take messages only|Let Claude act)$/ }).click();
    await expect.poll(() => early.arrived()).toBe(true);
    const reads = requests('desks').length;

    // The delete goes through and its answer is lost. A read sent after it says the Desk is gone,
    // so the owner moves on without waiting for the early read.
    mockStore.inject({ route: 'deleteDesk', status: 'network', afterCommit: true });
    await page.getByRole('button', { name: 'Delete this Desk' }).click();
    await screen.getByRole('dialog', { name: 'Delete Main line?' }).getByRole('button', { name: 'Delete Desk' }).click();
    await expect.poll(() => requests('desks').length).toBeGreaterThan(reads);
    await expect.poll(() => router.state.location.pathname).toBe(`/app/${RIVERA.emergenciesDeskId}/today`);
    await expect.element(screen.getByRole('heading', { level: 1, name: /, Mike$/ })).toBeVisible();

    // The early read's answer, let through now, puts nothing back: one Desk, no alert, never "not found".
    early.release();
    await expect.poll(() => early.answered()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(router.state.location.pathname).toBe(`/app/${RIVERA.emergenciesDeskId}/today`);
    expect(screen.getByRole('button', { name: /^Switch Desk/ }).elements()).toEqual([]);
    expect(screen.getByRole('alert').elements()).toEqual([]);
    expect(sawNotFound()).toBe(false);
    expect(requests('deleteDesk')).toHaveLength(1);
  });

  it('deleted_desk_closes_its_chats_holds_and_links', async () => {
    // Main line, when Mike deletes it here, has Dana's chat with her refund held for Mike and a
    // payment link open in it.
    const { screen, router } = await renderRoute(GENERAL, { seed: 'rivera_two_desks' });
    const refund = mockStore.world.addHeldRefund();
    const chat = mockStore.world.sessions.get(refund.session_id);
    if (!chat) throw new Error("Dana's refund has a chat");
    const token = mockStore.world.issueLink(chat, { title: 'Deposit', amountCents: 2000, language: 'en' });
    await main(screen).getByRole('button', { name: 'Delete this Desk' }).click();
    await screen.getByRole('dialog', { name: 'Delete Main line?' }).getByRole('button', { name: 'Delete Desk' }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`/app/${RIVERA.emergenciesDeskId}/today`);

    // Its chat is closed to whatever an owner tab still open on it sends, as the kernel closes a
    // deleted Desk's sessions...
    const closed = { status: 409, body: { error: 'kernel', code: 'closed' } };
    const params = { session_id: chat.state.session_id };
    const at = { params, body: { generation: chat.state.generation } };
    for (const key of ['takeover', 'handback', 'resume', 'ownerTyping'] as const) expect(await mockStore.dispatch(key, at), key).toEqual(closed);
    expect(await mockStore.dispatch('ownerMessage', { params, body: { text: 'Still there?', kind: 'whisper' } })).toEqual(closed);
    expect(await mockStore.dispatch('conversation', { params })).toEqual(closed);
    expect(await mockStore.dispatch('decision', { params: { decision_id: refund.decision_id } })).toEqual(closed);
    // ...the refund, allowed now, is refused at execution, so nothing runs...
    expect(await mockStore.dispatch('answer', { params: { decision_id: refund.decision_id }, body: { answer: 'allow_once' } })).toMatchObject({
      status: 200,
      body: { decision: { state: 'refused_at_execution' }, execution_state: null, card_diff: null },
    });
    // ...and the link was cancelled with the Desk, so it can't be paid.
    expect(await mockStore.dispatch('completePayment', { params: { token } })).toMatchObject({ status: 409, body: { state: 'cancelled' } });
    expect(mockStore.world.links.get(token)?.view.state).toBe('cancelled');
  });
});

describe('Settings against its boards', () => {
  it('settings_match_their_boards', async () => {
    // General as N-Run2-Settings-General draws it, at 1440 px: the page fills the main area and
    // centers its column, and Tab goes through SubNav, then the selected header colour, Answering and Delete this Desk.
    const { screen } = await renderRoute(GENERAL);
    const business = main(screen).getByRole('region', { name: 'Your business' });
    await expect.element(business).toBeVisible();
    const answering = main(screen).getByRole('switch', { name: 'Claude acts for you' });
    const remove = main(screen).getByRole('button', { name: 'Delete this Desk' });
    await expectOwnerBoard(screen.container, {
      current: 'Settings',
      fill: true,
      tabStops: [...links(screen), main(screen).getByRole('radio', { name: 'Teal', exact: true }).element() as HTMLElement, answering.element() as HTMLElement, remove.element() as HTMLElement],
    });
    // Tabbing to Delete scrolls the now-longer General page. Measure its opening position.
    main(screen).element().scrollTop = 0;
    let content = await expectSettingsColumns(screen, 'General');

    // The details 8 px under their heading, as wide as the column, with no Change; Answering in its
    // own card below Header colour, the card's look with its switch row 20 px in from its top and
    // bottom (the row pads its own sides, so its words line up with the details'); Delete this
    // Desk's heading 28 px under that, its neutral button at the column's right.
    const card = one(business.element(), '.cd-card');
    expect(round(top(card) - bottom(one(business.element(), 'h2')))).toBe(8);
    expect(round(card.getBoundingClientRect().width)).toBe(720);
    const answeringCard = main(screen).getByRole('region', { name: 'Claude acts for you' }).element();
    expectComputed(answeringCard, { ...SPEC.card, paddingTop: '0px', paddingLeft: '0px' });
    const switchRow = answering.element();
    expect(round(top(switchRow) - top(answeringCard))).toBe(21);
    expect(round(bottom(answeringCard) - bottom(switchRow))).toBe(21);
    const colourCard = main(screen).getByRole('region', { name: 'Header colour', exact: true }).element();
    expect(round(top(colourCard) - bottom(card))).toBe(20);
    expect(round(top(answeringCard) - bottom(colourCard))).toBe(20);
    const removal = main(screen).getByRole('region', { name: 'Delete this Desk' }).element();
    expect(round(top(one(removal, 'h2')) - bottom(answeringCard))).toBe(28);
    expectComputed(remove.element(), SPEC.secondaryMain);
    expect(round(remove.element().getBoundingClientRect().right)).toBe(round(content.getBoundingClientRect().right));
    main(screen).element().scrollTop = main(screen).element().scrollHeight;
    await expectFooterAtFoot(screen.container);

    // Its dialog is the general one (owner decision, 2026-10-30): no refused dot, Delete Desk the
    // neutral primary beside "Keep it".
    await remove.click();
    const dialog = screen.getByRole('dialog', { name: 'Delete Main line?' });
    await expect.element(dialog).toBeVisible();
    expect(dialog.element().querySelector('.cd-status-dot')).toBeNull();
    expectComputed(dialog.getByRole('button', { name: 'Delete Desk' }).element(), SPEC.primary);
    await userEvent.keyboard('{Escape}');
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();

    // Notifications as N-Run2-Settings-Notifications draws it: the vision note, the lead 20 px
    // under it, then the alerts set for a plumber 20 px under that, read-only.
    await subNav(screen).getByRole('link', { name: 'Notifications' }).click();
    const alerts = main(screen).getByRole('region', { name: 'Set for a plumber' });
    await expect.element(alerts).toBeVisible();
    await expectOwnerBoard(screen.container, { current: 'Settings', fill: true });
    content = await expectSettingsColumns(screen, 'Notifications');
    const vision = expectVisionNote(content, 'In this prototype, alerts reach your Demo inbox.');
    const lead = main(screen).getByText(NOTIFICATIONS_LEAD, { exact: true }).element();
    expectComputed(lead, { fontSize: '14px', color: 'rgba(250, 249, 245, 0.92)' });
    expect(round(top(lead) - bottom(vision))).toBe(20);
    expect(round(top(alerts.element()) - bottom(lead))).toBe(20);
    await expect.element(alerts.getByText('From your business type', { exact: true })).toBeVisible();
    const rows = alerts.getByRole('list', { name: 'Set for a plumber' }).getByRole('listitem').elements();
    expect(rows.map((row) => row.textContent)).toEqual(PLUMBER.map((alert) => alert.join('')));
    expect(round(top(one(alerts.element(), '.cd-card')) - bottom(one(alerts.element(), 'h2')))).toBe(8);
    expect(content.querySelectorAll('button, a, input')).toHaveLength(0);
    await expectFooterAtFoot(screen.container);

    // Billing opens on its sample note and Plan; its own screen tests check the details.
    await subNav(screen).getByRole('link', { name: 'Billing' }).click();
    const plan = main(screen).getByRole('region', { name: 'Plan' });
    await expect.element(plan).toBeVisible();
    content = await expectSettingsColumns(screen, 'Billing');
    expectVisionNote(one(content, '.cd-billing'), 'Nothing is billed in this prototype. The usage and invoices below are samples.');
    await expect.element(plan.getByText('One business, up to three Desks.', { exact: true })).toBeVisible();
    await expect.element(plan.getByText('Free while Claude Desk is a prototype.', { exact: true })).toBeVisible();

    // On a phone, as N-Run2-Settings-Phone draws it: the title 16 px under the top bar, SubNav as one
    // line across the page, and each part 16 px under the one before, down to the footer.
    const phone = await renderRoute(GENERAL, { viewport: 'phone' });
    const title = main(phone.screen).getByRole('heading', { level: 1, name: 'Settings' });
    await expect.element(title).toBeVisible();
    expect(round(top(title.element()) - bottom(one(phone.screen.container, '.cd-app-shell__topbar')))).toBe(16);
    const nav = subNav(phone.screen).element();
    const [first] = links(phone.screen);
    expect(round(top(first as HTMLElement) - bottom(title.element()))).toBe(16);
    expect([round(nav.getBoundingClientRect().left), round(nav.getBoundingClientRect().width)]).toEqual([0, 390]);
    expect(round((first as HTMLElement).getBoundingClientRect().left)).toBe(16);
    const details = main(phone.screen).getByRole('region', { name: 'Your business' }).element();
    expect(round(top(details) - bottom(nav))).toBe(16);
    const detailCard = one(details, '.cd-card');
    expect([round(detailCard.getBoundingClientRect().left), round(detailCard.getBoundingClientRect().width)]).toEqual([16, 358]);
    const switchCard = main(phone.screen).getByRole('region', { name: 'Claude acts for you' }).element();
    const phoneColour = main(phone.screen).getByRole('region', { name: 'Header colour', exact: true }).element();
    expect(round(top(phoneColour) - bottom(detailCard))).toBe(16);
    expect(round(top(switchCard) - bottom(phoneColour))).toBe(16);
    const deleting = main(phone.screen).getByRole('region', { name: 'Delete this Desk' });
    const heading = deleting.getByRole('heading', { name: 'Delete this Desk' }).element();
    const line = deleting.getByText(DELETE_LINE, { exact: true }).element();
    const button = deleting.getByRole('button', { name: 'Delete this Desk' }).element();
    expect(round(top(heading) - bottom(switchCard))).toBe(16);
    expect(round(top(line) - bottom(heading))).toBe(8);
    expect(round(top(button) - bottom(line))).toBe(8);
    expect(round(button.getBoundingClientRect().left)).toBe(16);
    expect(round(top(one(phone.screen.container, '[data-ds="concept-footer"]')) - bottom(button))).toBe(16);
    expectNoHorizontalScroll();
  });

  it('answering_lines_up_with_the_details', async () => {
    // Answering's words start where the details' do, on a laptop and on a phone: its label under
    // "Business", its line under "Turner Plumbing", and the switch's track as far in from the card's
    // right edge as the words are from its left.
    for (const viewport of ['desktop', 'phone'] as const) {
      const { screen } = await renderRoute(GENERAL, { viewport });
      const business = main(screen).getByRole('region', { name: 'Your business' });
      await expect.element(business).toBeVisible();
      const answering = main(screen).getByRole('region', { name: 'Claude acts for you' });
      const detailCard = one(business.element(), '.cd-card');
      const words = (el: Element) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getBoundingClientRect().left;
      };
      const term = business.getByRole('term').first().element();
      const value = business.getByRole('definition').first().element();
      const label = answering.getByText('Claude acts for you', { exact: true }).element();
      const line = answering.getByText(ANSWERING_LINE, { exact: true }).element();
      const inset = words(term) - detailCard.getBoundingClientRect().left;
      expect(Math.abs(words(label) - words(term)), `label at ${viewport}`).toBeLessThanOrEqual(1);
      expect(Math.abs(words(line) - words(value)), `line at ${viewport}`).toBeLessThanOrEqual(1);
      const card = answering.element().getBoundingClientRect();
      const track = one(answering.element(), '.cd-switch__track').getBoundingClientRect();
      expect(Math.abs(card.right - track.right - inset), `track at ${viewport}`).toBeLessThanOrEqual(1);
    }
  });

  it('settings_have_no_jargon', async () => {
    // Each section: one footer, clean copy, no axe violations and no technical words.
    const { screen } = await renderRoute(GENERAL);
    await expect.element(main(screen).getByRole('region', { name: 'Your business' })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });
    for (const [name, region] of [
      ['Notifications', 'Set for a plumber'],
      ['Billing', 'Plan'],
    ] as const) {
      await subNav(screen).getByRole('link', { name }).click();
      await expect.element(main(screen).getByRole('region', { name: region })).toBeVisible();
      await expectScreenBasics(screen.container, { owner: true });
    }

    // The delete dialog, and a delete that failed.
    await subNav(screen).getByRole('link', { name: 'General' }).click();
    await main(screen).getByRole('button', { name: 'Delete this Desk' }).click();
    await expect.element(screen.getByRole('dialog', { name: 'Delete Main line?' })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });
    mockStore.inject({ route: 'deleteDesk', status: 500 });
    await screen.getByRole('dialog', { name: 'Delete Main line?' }).getByRole('button', { name: 'Delete Desk' }).click();
    await expect.element(main(screen).getByRole('alert')).toHaveTextContent(UNAVAILABLE);
    await expectScreenBasics(screen.container, { owner: true });

    // A delete it couldn't confirm.
    mockStore.inject({ route: 'deleteDesk', status: 'network', afterCommit: true });
    mockStore.inject({ route: 'desks', status: 'network' });
    await main(screen).getByRole('button', { name: 'Delete this Desk' }).click();
    await screen.getByRole('dialog', { name: 'Delete Main line?' }).getByRole('button', { name: 'Delete Desk' }).click();
    await expect.element(main(screen).getByRole('alert')).toHaveTextContent(`${UNCONFIRMED}Reload`);
    await expectScreenBasics(screen.container, { owner: true });

    // On a phone too, with nothing scrolling sideways.
    const phone = await renderRoute(NOTIFICATIONS, { viewport: 'phone', seed: 'rivera' });
    await expect.element(main(phone.screen).getByRole('region', { name: 'Set for a plumber' })).toBeVisible();
    await expectScreenBasics(phone.screen.container, { owner: true });
    expectNoHorizontalScroll();
  });
});

/** The vision note at the top of `content`: the Pill, then its line 12 px after it, in quiet meta type. */
function expectVisionNote(content: HTMLElement, words: string): HTMLElement {
  const first = content.firstElementChild as HTMLElement;
  const pill = one(first, '.cd-pill');
  expect(pill.textContent).toBe('Vision');
  const note = first.querySelector('p') as HTMLElement;
  expect(note.textContent).toBe(words);
  expectComputed(note, { fontSize: '13px', color: 'rgba(250, 249, 245, 0.64)' });
  expect(round(note.getBoundingClientRect().left - pill.getBoundingClientRect().right)).toBe(12);
  return first;
}

/** SubNav's rows. */
function links(screen: RenderResult): HTMLElement[] {
  return subNav(screen).getByRole('link').elements() as HTMLElement[];
}

/**
 * A Settings page on a laptop, as the Settings boards measure it: the serif title 24 px into the
 * page; SubNav 200 px wide, 24 px under it, with `current` marked; the section's content 40 px to
 * its right, 720 px wide and level with SubNav; and the 960 px column centered in the main area.
 * Returns the content column.
 */
async function expectSettingsColumns(screen: RenderResult, current: string): Promise<HTMLElement> {
  await expect.poll(() => currentSection(screen)).toEqual([current]);
  const area = main(screen).element();
  const title = main(screen).getByRole('heading', { level: 1, name: 'Settings' }).element();
  expectComputed(title, SPEC.pageTitle);
  const nav = subNav(screen).element();
  const content = nav.parentElement?.nextElementSibling as HTMLElement;
  expect(round(top(title) - top(area))).toBe(24);
  expect(round(top(nav) - bottom(title))).toBe(24);
  expect(round(nav.getBoundingClientRect().width)).toBe(200);
  expect(round(content.getBoundingClientRect().left - nav.getBoundingClientRect().right)).toBe(40);
  expect(round(content.getBoundingClientRect().width)).toBe(720);
  expect(round(top(content))).toBe(round(top(nav)));
  const column = { left: title.getBoundingClientRect().left, right: content.getBoundingClientRect().right };
  expect(round(column.right - column.left)).toBe(960);
  expect(Math.abs(column.left - area.getBoundingClientRect().left - (area.clientWidth - 960) / 2)).toBeLessThanOrEqual(1);
  return content;
}

const round = Math.round;
const top = (el: Element) => el.getBoundingClientRect().top;
const bottom = (el: Element) => el.getBoundingClientRect().bottom;

/**
 * Holds the next read of the copy's Desks: answered from the copy as it stands when the read
 * arrives, but sent back only on `release()`, like a read that went out before a change and lands
 * after it. `arrived()` and `answered()` say how far it got.
 */
function holdNextDesksRead(): { arrived: () => boolean; answered: () => boolean; release: () => void } {
  let arrived = false;
  let answered = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Never left waiting past its test.
  onTestFinished(() => release());
  worker.use(
    http.get(
      ROUTES.desks.path,
      async () => {
        arrived = true;
        const answer = await mockStore.dispatch('desks');
        await released;
        answered = true;
        return 'network' in answer ? HttpResponse.error() : HttpResponse.json(answer.body as JsonBodyType, { status: answer.status });
      },
      { once: true },
    ),
  );
  return { arrived: () => arrived, answered: () => answered, release };
}

/** Whether `text` showed anywhere on the page at any point from now until the test ends. */
function watchFor(text: string): () => boolean {
  let seen = false;
  const observer = new MutationObserver(() => {
    if (document.body.textContent?.includes(text)) seen = true;
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  onTestFinished(() => observer.disconnect());
  return () => seen;
}
