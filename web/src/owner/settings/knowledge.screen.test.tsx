/**
 * Settings › Knowledge in a real browser against the mock API: what the Desk knows, each item with
 * when it was added and who can see it (one the kernel keeps to the owner shown without its words);
 * a note or a text file added for the owner only, then the "Customers can see this" switch, which
 * shows the readers the kernel returned and never the ones asked for.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { RenderResult } from 'vitest-browser-react';

import type { KnowledgeItem } from '../../api/contracts.ts';
import type { KnowledgeBody } from '../../api/views.ts';
import { SPEC } from '../../ds/boards/spec.ts';
import { expectComputed } from '../../ds/test/expectComputed.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { validateContract } from '../../mocks/validate.ts';
import { expectOwnerBoard } from '../../test/boards.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';
import { KNOWLEDGE_COPY, MAX_FILE_BYTES } from './KnowledgePage.tsx';

const KNOWLEDGE = `/app/${RIVERA.deskId}/settings/knowledge`;

/** The note as the board writes it. */
const NOTE = 'We don’t service tankless water heaters older than 15 years. Suggest a replacement quote instead.';

const LEAD = 'Knowledge is what I answer from. It never changes your rules.';
const ADDED = 'Added. Only you can see it until you make it public.';

/** The one instant the list's dates are read at: Friday, October 30, 12:30 pm in Los Angeles. */
const NOW = Date.parse('2026-10-30T19:30:00Z');
const DAY = 24 * 60 * 60 * 1000;

/** Holds the page's clock at `NOW`, moving on from there, so each row's date reads the same on every run. */
function freezeClock(): void {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
}

/** Stores `item` in the mock's Desk as the kernel keeps it, added `daysAgo` before `NOW`. */
function know(item: Omit<KnowledgeItem, 'label'>, readers: string[], daysAgo: number, forced = false): void {
  mockStore.world.knowledge.set(`${RIVERA.deskId}:${item.item_id}`, {
    deskId: RIVERA.deskId,
    item: { ...item, label: { readers, record_owner: null } },
    createdAt: NOW - daysAgo * DAY,
    forced,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

/** The items the page posted, in order. */
const posts = (): KnowledgeItem[] => mockStore.requests.filter((r) => r.key === 'addKnowledge').map((r) => (r.body as KnowledgeBody).item);

/** The owner's line for a request refused for coming too fast. */
const TOO_MANY = "That's a lot of requests at once. Wait a moment, then try again.";

const main = (screen: RenderResult) => screen.getByRole('main');
const switchOf = (screen: RenderResult) => main(screen).getByRole('switch', { name: 'Customers can see this' });

/** Opens Knowledge, types `note` and adds it. */
async function addNote(note = NOTE, opts: Parameters<typeof renderRoute>[1] = {}): Promise<RenderResult> {
  const { screen } = await renderRoute(KNOWLEDGE, opts);
  await main(screen).getByRole('textbox', { name: 'A note' }).fill(note);
  await main(screen).getByRole('button', { name: 'Add a note' }).click();
  await expect.element(switchOf(screen)).toBeVisible();
  return screen;
}

/** A request the test lets land when it chooses. */
function held(): { until: Promise<void>; release: () => void } {
  let release = () => {};
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { until, release };
}

/** Picks `file` with "Add a file", as the browser's file picker hands it over. */
async function pick(screen: RenderResult, file: File): Promise<void> {
  const input = main(screen).element().querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('Add a file has its file input');
  await userEvent.upload(input, file);
}

/** `item` as the kernel answers it, read by `readers`: a contract KnowledgeItem, checked. */
function answered(item: KnowledgeItem, readers: string[]): KnowledgeItem {
  const answer = { ...item, label: { readers, record_owner: null } };
  expect(validateContract('KnowledgeItem', answer)).toEqual([]);
  return answer;
}

describe('knowledge', () => {
  it('knowledge_note_then_public', async () => {
    const { screen } = await renderRoute(KNOWLEDGE);
    // Settings, on Knowledge, led by Claude's line.
    await expect.element(main(screen).getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect.element(main(screen).getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Knowledge' })).toHaveAttribute('aria-current', 'page');
    await expect.element(main(screen).getByText(LEAD, { exact: true })).toBeVisible();
    expect(switchOf(screen).query()).toBeNull();

    // A note, added for the owner only: an id of its own, its first 60 characters as its title.
    await main(screen).getByRole('textbox', { name: 'A note' }).fill(NOTE);
    await main(screen).getByRole('button', { name: 'Add a note' }).click();
    await expect.element(main(screen).getByText(ADDED, { exact: true })).toBeVisible();
    const [added] = posts();
    expect(added?.item_id).toMatch(/^note-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(added).toEqual({ item_id: added?.item_id, source: 'setup', title: NOTE.slice(0, 60), text: NOTE, label: { readers: ['owner'] } });
    await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', 'false');
    // The note stays in its field beside the card, as the board draws it.
    await expect.element(main(screen).getByRole('textbox', { name: 'A note' })).toHaveValue(NOTE);
    await expectScreenBasics(screen.container, { owner: true });

    // Customers can see it: the same item posted again, public; the line no longer says only you can.
    await switchOf(screen).click();
    await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', 'true');
    expect(posts()[1]).toEqual({ ...added, label: { readers: ['public'], record_owner: null } });
    await expect.element(main(screen).getByText('Added.', { exact: true })).toBeVisible();
    // And back to the owner only.
    await switchOf(screen).click();
    await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', 'false');
    expect(posts()[2]).toEqual({ ...added, label: { readers: ['owner'], record_owner: null } });
    expect(posts()).toHaveLength(3);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('knowledge_switch_follows_the_returned_label', async () => {
    const screen = await addNote();
    const [item] = posts();
    if (!item) throw new Error('the note was posted');

    // Turned on, and answered with the readers still the owner's: the switch is off again, and says why.
    mockStore.inject({ route: 'addKnowledge', status: 200, body: answered(item, ['owner']) });
    await switchOf(screen).click();
    await expect.element(main(screen).getByText(KNOWLEDGE_COPY.keptPrivate, { exact: true })).toBeVisible();
    expect(posts()[1]?.label.readers).toEqual(['public']);
    await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', 'false');
    await expect.element(main(screen).getByText(ADDED, { exact: true })).toBeVisible();

    // Answered with the public label: on, and the line no longer says only the owner can see it.
    mockStore.inject({ route: 'addKnowledge', status: 200, body: answered(item, ['public']) });
    await switchOf(screen).click();
    await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', 'true');
    await expect.element(main(screen).getByText('Added.', { exact: true })).toBeVisible();
    expect(main(screen).getByText(KNOWLEDGE_COPY.keptPrivate, { exact: true }).query()).toBeNull();

    // Off, then the kernel keeping it to the owner whatever it's posted with: on stays off.
    await switchOf(screen).click();
    await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', 'false');
    mockStore.world.keepsKnowledgeOwnerOnly = () => true;
    await switchOf(screen).click();
    await expect.element(main(screen).getByText(KNOWLEDGE_COPY.keptPrivate, { exact: true })).toBeVisible();
    await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', 'false');
    expect(posts().map((posted) => posted.label.readers)).toEqual([['owner'], ['public'], ['public'], ['owner'], ['public']]);
    await expectScreenBasics(screen.container, { owner: true });

    // While a change is out, the switch waits, and so do both adds.
    const change = held();
    mockStore.inject({ route: 'addKnowledge', status: 200, until: change.until, body: answered(item, ['owner']) });
    await switchOf(screen).click();
    await expect.element(switchOf(screen)).toHaveAttribute('aria-busy', 'true');
    await expect.element(main(screen).getByRole('button', { name: 'Add a note' })).toHaveAttribute('aria-disabled', 'true');
    change.release();
    await expect.element(switchOf(screen)).not.toHaveAttribute('aria-busy', 'true');
  });

  it('knowledge_file_too_big_sends_nothing', async () => {
    const { screen } = await renderRoute(KNOWLEDGE);
    await expect.element(main(screen).getByRole('button', { name: 'Add a file' })).toBeVisible();

    // Over 100 KB: it says so and sends nothing.
    await pick(screen, new File(['x'.repeat(MAX_FILE_BYTES + 1)], 'prices.txt', { type: 'text/plain' }));
    await expect.element(main(screen).getByRole('alert')).toHaveTextContent(KNOWLEDGE_COPY.tooBig);
    expect(KNOWLEDGE_COPY.tooBig).toBe('That file is too big. Add files up to 100 KB.');
    // Not text or Markdown, or empty: it says so and sends nothing.
    await pick(screen, new File(['%PDF-1.7'], 'menu.pdf', { type: 'application/pdf' }));
    await expect.element(main(screen).getByRole('alert')).toHaveTextContent(KNOWLEDGE_COPY.notText);
    await pick(screen, new File(['  \n'], 'blank.md', { type: 'text/markdown' }));
    await expect.element(main(screen).getByRole('alert')).toHaveTextContent(KNOWLEDGE_COPY.emptyFile);
    expect(posts()).toEqual([]);
    await expectScreenBasics(screen.container, { owner: true });

    // Text up to 100 KB: added for the owner only, as the file's words, named by the file.
    const words = '# Prices\n\nDrain clearing, flat rate. Water heater installs, quoted on site.';
    await pick(screen, new File([words], 'price-list.md', { type: 'text/markdown' }));
    await expect.element(main(screen).getByText(ADDED, { exact: true })).toBeVisible();
    expect(main(screen).getByRole('alert').query()).toBeNull();
    const [file] = posts();
    expect(file?.item_id).toMatch(/^file-[0-9a-f-]{36}$/);
    expect(file).toEqual({ item_id: file?.item_id, source: 'upload', title: 'price-list.md', text: words, label: { readers: ['owner'] } });
    await pick(screen, new File(['x'.repeat(MAX_FILE_BYTES)], 'at-the-limit.txt', { type: 'text/plain' }));
    await expect.poll(() => posts()).toHaveLength(2);
    expect(posts()[1]?.text).toHaveLength(MAX_FILE_BYTES);
  });

  it('knowledge_add_waits_then_says_what_went_wrong', async () => {
    const { screen } = await renderRoute(KNOWLEDGE);
    const field = main(screen).getByRole('textbox', { name: 'A note' });
    const addButton = main(screen).getByRole('button', { name: 'Add a note' });

    // Nothing written: it says so and sends nothing.
    await addButton.click();
    await expect.element(main(screen).getByRole('alert')).toHaveTextContent(KNOWLEDGE_COPY.emptyNote);
    expect(posts()).toEqual([]);

    // While the add is out: it spins, and "Add a file" waits.
    await field.fill(NOTE);
    const answer = held();
    const stored: KnowledgeItem = answered({ item_id: 'note-held', source: 'setup', title: NOTE.slice(0, 60), text: NOTE, label: {} }, ['owner']);
    mockStore.inject({ route: 'addKnowledge', status: 200, until: answer.until, body: stored });
    await addButton.click();
    await expect.element(addButton).toHaveAttribute('aria-busy', 'true');
    await expect.element(main(screen).getByRole('button', { name: 'Add a file' })).toHaveAttribute('aria-disabled', 'true');
    answer.release();
    await expect.element(main(screen).getByText(ADDED, { exact: true })).toBeVisible();

    // A refused add says what went wrong, and the note stays to add again.
    const again = await renderRoute(KNOWLEDGE);
    const note = main(again.screen).getByRole('textbox', { name: 'A note' });
    await note.fill(NOTE);
    mockStore.inject({ route: 'addKnowledge', status: 429 });
    await main(again.screen).getByRole('button', { name: 'Add a note' }).click();
    await expect.element(main(again.screen).getByRole('alert')).toHaveTextContent(TOO_MANY);
    await expect.element(note).toHaveValue(NOTE);
    expect(switchOf(again.screen).query()).toBeNull();
    await expectScreenBasics(again.screen.container, { owner: true });

    // A lost answer, or a server error, may have gone through: it never says it didn't, and adding
    // again posts the same item, which replaces it rather than adding a second.
    mockStore.inject({ route: 'addKnowledge', status: 503 });
    await main(again.screen).getByRole('button', { name: 'Add a note' }).click();
    await expect.element(main(again.screen).getByRole('alert')).toHaveTextContent(KNOWLEDGE_COPY.unconfirmed);
    mockStore.inject({ route: 'addKnowledge', status: 'network', afterCommit: true });
    await main(again.screen).getByRole('button', { name: 'Add a note' }).click();
    await expect.element(main(again.screen).getByRole('alert')).toHaveTextContent(KNOWLEDGE_COPY.unconfirmed);
    await main(again.screen).getByRole('button', { name: 'Add a note' }).click();
    await expect.element(switchOf(again.screen)).toBeVisible();
    const ids = new Set(posts().slice(-3).map((posted) => posted.item_id));
    expect(ids.size).toBe(1);
    expect([...mockStore.world.knowledge.values()].filter((stored) => stored.item.text === NOTE)).toHaveLength(1);
  });

  it('knowledge_fits_a_phone_in_plain_words', async () => {
    const screen = await addNote(NOTE, { viewport: 'phone' });
    mockStore.world.keepsKnowledgeOwnerOnly = () => true;
    await switchOf(screen).click();
    await expect.element(main(screen).getByText(KNOWLEDGE_COPY.keptPrivate, { exact: true })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });
    expectNoHorizontalScroll();
    const column = main(screen).element().getBoundingClientRect();
    for (const el of main(screen).element().querySelectorAll('*')) {
      expect(Math.round(el.getBoundingClientRect().right), el.className.toString()).toBeLessThanOrEqual(Math.round(column.right));
    }
  });

  it('knowledge_lists_what_i_know', async () => {
    freezeClock();
    // What the Desk knows, oldest first: one customers can see, one the owner keeps private, and one
    // the kernel keeps to the owner, whose title and words the list withholds.
    know({ item_id: 'website', source: 'website', title: 'Your website', text: 'Rivera Plumbing fixes leaks and drains around Oakland.' }, ['public'], 4);
    know({ item_id: 'note-kept', source: 'setup', title: 'Parking is on the street.', text: 'Parking is on the street.' }, ['owner'], 3);
    know({ item_id: 'note-forced', source: 'setup', title: 'Dana’s gate code', text: 'Dana’s gate code is 4471.' }, ['owner'], 2, true);
    const { screen } = await renderRoute(KNOWLEDGE);

    const known = main(screen).getByRole('region', { name: 'What I know now' });
    const list = known.getByRole('list', { name: 'What I know now' });
    await expect.element(list).toBeVisible();
    const rows = list.getByRole('listitem').elements();
    expect(rows.map((row) => row.textContent)).toEqual([
      'Your websiteAdded Oct 26Customers can see this',
      'Parking is on the street.Added Oct 27Only you',
      'A note only you can seeAdded Oct 28Only you',
    ]);
    // The withheld item: no title, no words, no switch, anywhere on the page.
    expect(main(screen).element().textContent).not.toContain('gate code');
    expect(known.getByRole('switch').query()).toBeNull();
    expect(switchOf(screen).query()).toBeNull();
    // The list sits above "Add something", under Claude's line.
    const add = main(screen).getByRole('region', { name: 'Add something' }).element();
    expect(known.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(add.getBoundingClientRect().top);
    await expectScreenBasics(screen.container, { owner: true });

    // A note just added joins the list, read again, with today's date and "Only you".
    await main(screen).getByRole('textbox', { name: 'A note' }).fill(NOTE);
    await main(screen).getByRole('button', { name: 'Add a note' }).click();
    await expect.poll(() => list.getByRole('listitem').elements().length).toBe(4);
    expect(list.getByRole('listitem').elements()[3]?.textContent).toBe(`${NOTE.slice(0, 60)}Added Oct 30Only you`);
    // Made public with its switch, its row says so.
    await switchOf(screen).click();
    await expect.poll(() => list.getByRole('listitem').elements()[3]?.textContent).toBe(`${NOTE.slice(0, 60)}Added Oct 30Customers can see this`);
  });

  it('knowledge_list_loads_fails_and_is_left_out_when_empty', async () => {
    // Nothing known yet: no list at all, only the way to add something.
    const empty = await renderRoute(KNOWLEDGE);
    await expect.element(main(empty.screen).getByRole('region', { name: 'Add something' })).toBeVisible();
    await expect.poll(() => mockStore.requests.filter((r) => r.key === 'knowledge').length).toBeGreaterThan(0);
    expect(main(empty.screen).getByRole('region', { name: 'What I know now' }).query()).toBeNull();
    expect(main(empty.screen).getByRole('status').filter({ hasText: 'Loading what I know' }).query()).toBeNull();

    // While the list is read: the loading line where it goes, until the answer lands.
    know({ item_id: 'website', source: 'website', title: 'Your website', text: 'Leaks and drains.' }, ['public'], 1);
    const list = held();
    const items = await mockStore.dispatch('knowledge', { params: { desk_id: RIVERA.deskId } });
    mockStore.inject({ route: 'knowledge', status: 200, until: list.until, body: (items as { body: unknown }).body });
    const slow = (await renderRoute(KNOWLEDGE, { pollScale: 100 })).screen;
    await expect.element(main(slow).getByRole('status').filter({ hasText: /^Loading what I know$/ })).toBeVisible();
    list.release();
    await expect.element(main(slow).getByRole('list', { name: 'What I know now' })).toBeVisible();

    // A read that fails (and its one retry, at once): what went wrong and Try again, which reads it.
    mockStore.inject({ route: 'knowledge', status: 503, times: 2 });
    const { screen } = await renderRoute(KNOWLEDGE, { pollScale: 100, retryScale: 0 });
    await expect.element(main(screen).getByText('Something went wrong on our side. Try again in a moment.', { exact: true })).toBeVisible();
    expect(main(screen).getByRole('list', { name: 'What I know now' }).query()).toBeNull();
    // Adding still works while the list can't be read.
    await expect.element(main(screen).getByRole('button', { name: 'Add a note' })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });
    await main(screen).getByRole('button', { name: 'Try again' }).click();
    await expect.element(main(screen).getByRole('list', { name: 'What I know now' })).toBeVisible();
  });

  it('knowledge_matches_its_board', async () => {
    freezeClock();
    know({ item_id: 'website', source: 'website', title: 'Your website', text: 'Leaks and drains.' }, ['public'], 4);
    know({ item_id: 'note-forced', source: 'setup', title: 'A gate code', text: 'A gate code.' }, ['owner'], 3, true);
    const screen = await addNote();
    const known = main(screen).getByRole('region', { name: 'What I know now' }).element();
    const add = main(screen).getByRole('region', { name: 'Add something' }).element();
    const added = main(screen).getByRole('region', { name: 'Added' }).element();
    await expect.poll(() => known.querySelectorAll('li').length).toBe(3);

    // N-Run2-Settings-Knowledge: Claude's line in serif leading the 720 px column, then the list,
    // "Add something" and the "Added" card, 20 px apart; "Add a note" the view's one primary.
    const lead = main(screen).getByText(LEAD, { exact: true }).element();
    expectComputed(lead, { fontFamily: /^"Source Serif 4"/, fontSize: '18px', lineHeight: '27px', fontWeight: '360' });
    const content = lead.parentElement as HTMLElement;
    expect(Math.round(content.getBoundingClientRect().width)).toBe(720);
    const gap = (above: Element, below: Element) => Math.round(below.getBoundingClientRect().top - above.getBoundingClientRect().bottom);
    expect([gap(lead, known), gap(known, add), gap(add, added)]).toEqual([20, 20, 20]);
    // (The pointer, left on "Add a note" by the add, moves off it first, so it isn't hovered.)
    await userEvent.hover(lead);
    expectComputed(main(screen).getByRole('button', { name: 'Add a note' }).element(), SPEC.primary);

    // The frame with Settings current, every card in the card look, and Tab through Knowledge's
    // SubNav row, the note, its two adds, then the switch: the list's rows hold no stop.
    const nav = main(screen).getByRole('navigation', { name: 'Settings' });
    await expectOwnerBoard(screen.container, {
      current: 'Settings',
      fill: true,
      tabStops: [
        nav.getByRole('link', { name: 'Knowledge' }).element() as HTMLElement,
        main(screen).getByRole('textbox', { name: 'A note' }).element() as HTMLElement,
        main(screen).getByRole('button', { name: 'Add a note' }).element() as HTMLElement,
        main(screen).getByRole('button', { name: 'Add a file' }).element() as HTMLElement,
        switchOf(screen).element() as HTMLElement,
      ],
    });
    expect(known.querySelectorAll('a, button, input, [tabindex]')).toHaveLength(0);
  });
});
