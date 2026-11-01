/**
 * Settings › Knowledge in a real browser against the mock API: what the Desk knows, each item with
 * when it was added and who can see it (one the kernel keeps to the owner shown without its words);
 * a note or a text file added for the owner only, then the "Customers can see this" switch, which
 * shows the readers the kernel returned and never the ones asked for.
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { RenderResult } from 'vitest-browser-react';

import type { KnowledgeItem } from '../../api/contracts.ts';
import type { KnowledgeBody, KnowledgeRow } from '../../api/views.ts';
import { SPEC } from '../../ds/boards/spec.ts';
import { expectComputed } from '../../ds/test/expectComputed.ts';
import { settled } from '../../ds/test/settled.ts';
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
const NOTE_TITLE = 'We don’t service tankless water heaters older than 15…';

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
  vi.restoreAllMocks();
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
  onTestFinished(() => release());
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
  it('knowledge_fresh_copy_lists_the_public_setup_items', async () => {
    freezeClock();
    const { screen } = await renderRoute(KNOWLEDGE, { seed: 'rivera' });
    const list = main(screen).getByRole('list', { name: 'What I know now' });
    await expect.element(list).toBeVisible();
    // Oldest first: the kernel stores the website read, then the price list.
    expect(list.getByRole('listitem').elements().map((row) => row.textContent)).toEqual([
      'Your website, turner-plumbing.example, read during setupAdded Oct 30Customers can see this',
      'Price list, from your answers in setupAdded Oct 30Customers can see this',
    ]);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('knowledge_note_titles_end_at_a_word_within_60_characters', async () => {
    const { screen } = await renderRoute(KNOWLEDGE);
    const field = main(screen).getByRole('textbox', { name: 'A note' });
    const addButton = main(screen).getByRole('button', { name: 'Add a note' });
    const cases = [
      // A shortened title drops the punctuation its last word ends with before the ellipsis.
      ['We service tankless water heaters from Rinnai and Navien. Saturday appointments are available.', 'We service tankless water heaters from Rinnai and Navien…'],
      ['We install tankless water heaters from Rinnai and Navien, and Saturday appointments are open.', 'We install tankless water heaters from Rinnai and Navien…'],
      ['-'.repeat(61), '…'],
      // A title that fits keeps its punctuation.
      ['Parking is on the street.', 'Parking is on the street.'],
      ['🔧'.repeat(60), '🔧'.repeat(60)],
      ['🔧'.repeat(61), `${'🔧'.repeat(59)}…`],
    ] as const;

    for (const [text, title] of cases) {
      await field.fill(text);
      await addButton.click();
      const list = main(screen).getByRole('list', { name: 'What I know now' });
      await expect.element(list.getByText(title, { exact: true })).toBeVisible();
      expect(posts().at(-1)?.title).toBe(title);
      expect([...posts().at(-1)!.title].length).toBeLessThanOrEqual(60);
    }
  });

  it.each([false, true])('knowledge_preserves_words_typed_during_add_read_back_%s', async (lost) => {
    const { screen } = await renderRoute(KNOWLEDGE, { retryScale: 0 });
    const field = main(screen).getByRole('textbox', { name: 'A note' });
    await field.fill(NOTE);
    const answer = held();
    mockStore.inject(lost
      ? { route: 'addKnowledge', status: 'network', afterCommit: true, until: answer.until }
      : { route: 'addKnowledge', status: 200, until: answer.until, body: answered({ item_id: 'note-held', source: 'setup', title: NOTE_TITLE, text: NOTE, label: {} }, ['owner']) });
    await main(screen).getByRole('button', { name: 'Add a note' }).click();
    await expect.element(main(screen).getByRole('button', { name: 'Add a note' })).toHaveAttribute('aria-busy', 'true');
    await field.fill('Parking is on the street.');
    answer.release();
    await expect.element(switchOf(screen)).toBeVisible();
    await expect.element(field).toHaveValue('Parking is on the street.');
  });

  it('knowledge_confirmed_add_cancels_the_first_list_read', async () => {
    const first = held();
    mockStore.inject({ route: 'knowledge', status: 200, body: [], until: first.until });
    const { screen } = await renderRoute(KNOWLEDGE, { pollScale: 100 });
    await expect.element(main(screen).getByText('Loading what I know', { exact: true })).toBeVisible();
    await main(screen).getByRole('textbox', { name: 'A note' }).fill(NOTE);
    await main(screen).getByRole('button', { name: 'Add a note' }).click();
    await expect.element(switchOf(screen)).toBeVisible();
    first.release();
    await expect.poll(() => mockStore.requests.filter((r) => r.key === 'knowledge').length).toBe(2);
    await expect.element(main(screen).getByRole('list', { name: 'What I know now' }).getByText(NOTE_TITLE, { exact: true })).toBeVisible();
  });

  it('knowledge_note_then_public', async () => {
    const { screen } = await renderRoute(KNOWLEDGE);
    // Settings, on Knowledge, led by Claude's line.
    await expect.element(main(screen).getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect.element(main(screen).getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Knowledge' })).toHaveAttribute('aria-current', 'page');
    await expect.element(main(screen).getByText(LEAD, { exact: true })).toBeVisible();
    expect(switchOf(screen).query()).toBeNull();

    // A note, added for the owner only: an id of its own and a title shortened at a word.
    await main(screen).getByRole('textbox', { name: 'A note' }).fill(NOTE);
    await main(screen).getByRole('button', { name: 'Add a note' }).click();
    await expect.element(main(screen).getByText(ADDED, { exact: true })).toBeVisible();
    const [added] = posts();
    expect(added?.item_id).toMatch(/^note-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(added).toEqual({ item_id: added?.item_id, source: 'setup', title: NOTE_TITLE, text: NOTE, label: { readers: ['owner'] } });
    await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', 'false');
    // Once added, the field clears; pressing Add again asks for words without posting a duplicate.
    await expect.element(main(screen).getByRole('textbox', { name: 'A note' })).toHaveValue('');
    const list = main(screen).getByRole('list', { name: 'What I know now' });
    await expect.poll(() => list.getByRole('listitem').elements().length).toBe(3);
    await main(screen).getByRole('button', { name: 'Add a note' }).click();
    await expect.element(main(screen).getByRole('alert')).toHaveTextContent(KNOWLEDGE_COPY.emptyNote);
    expect(posts()).toHaveLength(1);
    expect(list.getByRole('listitem').elements()).toHaveLength(3);
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

  it('knowledge_adds_on_a_page_served_without_random_uuid', async () => {
    // A page not served securely (http on a LAN address, say) has no `crypto.randomUUID`: a note is
    // still added, under a version 4 UUID made from random bytes.
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      await addNote();
    } finally {
      delete (crypto as { randomUUID?: unknown }).randomUUID;
    }
    expect(typeof crypto.randomUUID).toBe('function');
    expect(posts()[0]?.item_id).toMatch(/^note-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it.each([false, true])('knowledge_repeated_confirmed_words_create_a_new_item_read_back_%s', async (lost) => {
    if (lost) mockStore.inject({ route: 'addKnowledge', status: 'network', afterCommit: true });
    const screen = await addNote(NOTE, { retryScale: 0 });
    const first = posts()[0]!;
    await switchOf(screen).click();
    await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', 'true');
    await main(screen).getByRole('textbox', { name: 'A note' }).fill(NOTE);
    await main(screen).getByRole('button', { name: 'Add a note' }).click();
    await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', 'false');
    expect(posts()[2]?.item_id).not.toBe(first.item_id);
    expect(mockStore.world.knowledge.get(`${RIVERA.deskId}:${first.item_id}`)?.item.label.readers).toEqual(['public']);
    await expect.poll(() => main(screen).getByRole('list', { name: 'What I know now' }).getByRole('listitem').elements().length).toBe(4);
  });

  it.each([429, 422])('knowledge_refused_switch_preserves_readers_%s', async (status) => {
    const screen = await addNote();
    const line = status === 429 ? TOO_MANY : "That didn't go through. Check it and try again.";
    for (const wasPublic of [false, true]) {
      if (wasPublic) {
        await switchOf(screen).click();
        await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', 'true');
      }
      mockStore.inject({ route: 'addKnowledge', status, body: status === 422 ? { error: 'kernel', code: 'invalid' } : { error: 'rate_limited' } });
      await switchOf(screen).click();
      await expect.element(main(screen).getByText(line, { exact: true })).toBeVisible();
      await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', String(wasPublic));
    }
  });

  it('knowledge_lost_forced_private_add_shows_the_returned_readers_and_withheld_row', async () => {
    mockStore.world.keepsKnowledgeOwnerOnly = () => true;
    mockStore.inject({ route: 'addKnowledge', status: 'network', afterCommit: true });
    const screen = await addNote(NOTE, { retryScale: 0 });
    await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', 'false');
    await expect.element(main(screen).getByText(ADDED, { exact: true })).toBeVisible();
    const row = main(screen).getByRole('list', { name: 'What I know now' }).getByRole('listitem').filter({ hasText: 'A note only you can see' });
    await expect.element(row).toBeVisible();
    expect(row.element().textContent).toMatch(/^A note only you can seeAdded .+Only you$/);
    expect(main(screen).getByText(NOTE_TITLE, { exact: true }).query()).toBeNull();
    // A lost publish that lands but is forced private is explained by the withheld title.
    mockStore.inject({ route: 'addKnowledge', status: 'network', afterCommit: true });
    await switchOf(screen).click();
    await expect.element(main(screen).getByText(KNOWLEDGE_COPY.keptPrivate, { exact: true })).toBeVisible();
    await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', 'false');
  });

  it('knowledge_lost_publish_before_commit_says_the_change_failed', async () => {
    const screen = await addNote(NOTE, { retryScale: 0 });
    mockStore.inject({ route: 'addKnowledge', status: 'network' });
    await switchOf(screen).click();
    await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', 'false');
    await expect.element(main(screen).getByText("That didn't go through. Check it and try again.", { exact: true })).toBeVisible();
    expect(main(screen).getByText(KNOWLEDGE_COPY.keptPrivate, { exact: true }).query()).toBeNull();
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

  it('knowledge_file_requires_utf8', async () => {
    const { screen } = await renderRoute(KNOWLEDGE);
    await expect.element(main(screen).getByRole('button', { name: 'Add a file' })).toBeVisible();
    await pick(screen, new File([new Uint8Array([0x63, 0x61, 0x66, 0xe9])], 'prices.txt', { type: 'text/plain' }));
    await expect.element(main(screen).getByRole('alert')).toHaveTextContent(KNOWLEDGE_COPY.unreadable);
    expect(posts()).toEqual([]);
  });

  it('knowledge_file_with_nul_is_unreadable', async () => {
    const { screen } = await renderRoute(KNOWLEDGE);
    await expect.element(main(screen).getByRole('button', { name: 'Add a file' })).toBeVisible();
    await pick(screen, new File(['Prices\0'], 'prices.txt', { type: 'text/plain' }));
    await expect.element(main(screen).getByRole('alert')).toHaveTextContent(KNOWLEDGE_COPY.unreadable);
    expect(posts()).toEqual([]);
  });

  it('knowledge_oversize_note_counts_utf8_bytes', async () => {
    const { screen } = await renderRoute(KNOWLEDGE);
    const text = '🔧'.repeat(MAX_FILE_BYTES / 4 + 1);
    await main(screen).getByRole('textbox', { name: 'A note' }).fill(text);
    await main(screen).getByRole('button', { name: 'Add a note' }).click();
    await expect.element(main(screen).getByRole('alert')).toHaveTextContent("That didn't go through. Check it and try again.");
    expect(posts()).toEqual([]);
    await expect.element(main(screen).getByRole('textbox', { name: 'A note' })).toHaveValue(text);
  });

  it('knowledge_file_checks_decoded_utf8_bytes', async () => {
    const { screen } = await renderRoute(KNOWLEDGE);
    await expect.element(main(screen).getByRole('button', { name: 'Add a file' })).toBeVisible();
    const bytes = new TextEncoder().encode('🔧'.repeat(MAX_FILE_BYTES / 4 + 1));
    vi.spyOn(Blob.prototype, 'arrayBuffer').mockResolvedValueOnce(bytes.buffer);
    await pick(screen, new File(['Prices'], 'prices.txt', { type: 'text/plain' }));
    await expect.element(main(screen).getByRole('alert')).toHaveTextContent(KNOWLEDGE_COPY.tooBig);
    expect(posts()).toEqual([]);
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
    const stored: KnowledgeItem = answered({ item_id: 'note-held', source: 'setup', title: NOTE_TITLE, text: NOTE, label: {} }, ['owner']);
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

    // A server error may have gone through, so the page reads the list before it says: here it
    // didn't, and it says so, the note kept to add again.
    mockStore.inject({ route: 'addKnowledge', status: 503 });
    await main(again.screen).getByRole('button', { name: 'Add a note' }).click();
    await expect.element(main(again.screen).getByRole('alert')).toHaveTextContent(KNOWLEDGE_COPY.notAdded);
    await expect.element(note).toHaveValue(NOTE);
    expect(switchOf(again.screen).query()).toBeNull();
  });

  it('knowledge_lost_answers_are_read_back', async () => {
    const { screen } = await renderRoute(KNOWLEDGE, { retryScale: 0 });
    await main(screen).getByRole('textbox', { name: 'A note' }).fill(NOTE);
    const addButton = main(screen).getByRole('button', { name: 'Add a note' });

    // An add that went through, its answer lost: the list read back has it, so it shows as added.
    mockStore.inject({ route: 'addKnowledge', status: 'network', afterCommit: true });
    await addButton.click();
    await expect.element(main(screen).getByText(ADDED, { exact: true })).toBeVisible();
    await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', 'false');
    await expect.element(main(screen).getByRole('textbox', { name: 'A note' })).toHaveValue('');
    expect(main(screen).getByRole('alert').query()).toBeNull();
    expect(mockStore.requests.filter((r) => r.key === 'knowledge').length).toBeGreaterThanOrEqual(2);

    // Made public, its answer lost: read back, the switch is on, as the list says.
    mockStore.inject({ route: 'addKnowledge', status: 'network', afterCommit: true });
    await switchOf(screen).click();
    await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', 'true');
    await expect.element(main(screen).getByText('Added.', { exact: true })).toBeVisible();
    expect(main(screen).getByText(KNOWLEDGE_COPY.switchUnconfirmed, { exact: true }).query()).toBeNull();

    // Back to the owner only, its answer lost and the list unreadable too: the switch stays where it
    // was, and the page says it couldn't confirm the change.
    mockStore.inject({ route: 'addKnowledge', status: 'network', afterCommit: true });
    mockStore.inject({ route: 'knowledge', status: 503, times: 2 });
    await switchOf(screen).click();
    await expect.element(main(screen).getByText(KNOWLEDGE_COPY.switchUnconfirmed, { exact: true })).toBeVisible();
    await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', 'true');

    // An add lost the same way: not known either way. Adding it again posts the same item, which
    // replaces it rather than adding a second.
    const fresh = (await renderRoute(KNOWLEDGE, { retryScale: 0 })).screen;
    const other = 'Parking is on the street. Ring the side door when you arrive for your appointment.';
    await main(fresh).getByRole('textbox', { name: 'A note' }).fill(other);
    mockStore.inject({ route: 'addKnowledge', status: 'network', afterCommit: true });
    mockStore.inject({ route: 'knowledge', status: 503, times: 2 });
    await main(fresh).getByRole('button', { name: 'Add a note' }).click();
    // The add says it couldn't confirm; the list, which couldn't be read either, says so on its own.
    await expect.element(main(fresh).getByRole('region', { name: 'Add something' }).getByRole('alert')).toHaveTextContent(KNOWLEDGE_COPY.unconfirmed);
    await expect.element(main(fresh).getByRole('textbox', { name: 'A note' })).toHaveValue(other);
    expect(switchOf(fresh).query()).toBeNull();
    await main(fresh).getByRole('button', { name: 'Add a note' }).click();
    await expect.element(switchOf(fresh)).toBeVisible();
    const ids = new Set(posts().filter((posted) => posted.text === other).map((posted) => posted.item_id));
    expect(ids.size).toBe(1);
    expect([...mockStore.world.knowledge.values()].filter((stored) => stored.item.text === other)).toHaveLength(1);
  });

  it('knowledge_read_back_is_a_fresh_read', async () => {
    // The note's id, known ahead, so a list answer can name it.
    const uuid = '0f2c4a1e-5b6d-4c7e-8f90-a1b2c3d4e5f6';
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(uuid);
    const id = `note-${uuid}`;
    const { screen } = await renderRoute(KNOWLEDGE, { pollScale: 100, retryScale: 0 });
    await main(screen).getByRole('textbox', { name: 'A note' }).fill(NOTE);

    // 1. The list read the add sets off is held in flight, answering the note as the owner's alone.
    const stale = held();
    const ownerOnly: KnowledgeRow = { item_id: id, source: 'setup', title: NOTE_TITLE, text: NOTE, readers: ['owner'], created_at: new Date().toISOString() };
    mockStore.inject({ route: 'knowledge', status: 200, until: stale.until, body: [ownerOnly] });
    await main(screen).getByRole('button', { name: 'Add a note' }).click();
    await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', 'false');
    const reads = () => mockStore.requests.filter((r) => r.key === 'knowledge').length;
    await expect.poll(reads).toBe(2);

    // 2. Made public: it goes through, and its answer is lost.
    mockStore.inject({ route: 'addKnowledge', status: 'network', afterCommit: true });
    await switchOf(screen).click();
    await expect.poll(() => posts().length).toBe(2);
    // The read from before the change lands late, owner-only.
    stale.release();

    // 3. The read-back is a read sent after the change, never the one in flight: it says public.
    await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', 'true');
    await expect.element(main(screen).getByText('Added.', { exact: true })).toBeVisible();
    expect(main(screen).getByText(KNOWLEDGE_COPY.keptPrivate, { exact: true }).query()).toBeNull();
    expect(reads()).toBe(3);
    // The list says so too: the late, cancelled read doesn't overwrite it.
    const row = () => main(screen).getByRole('list', { name: 'What I know now' }).getByRole('listitem').filter({ hasText: NOTE_TITLE }).element().textContent;
    await expect.poll(() => row()?.endsWith('Customers can see this')).toBe(true);
  });

  it('knowledge_writes_go_one_at_a_time', async () => {
    // Item A added, its card showing.
    const screen = await addNote();
    const a = posts()[0]?.item_id;
    // Item B on its way: A's switch does nothing meanwhile, and B's add stays busy.
    const field = main(screen).getByRole('textbox', { name: 'A note' });
    await field.fill('Parking is on the street. Ring the side door.');
    const b = held();
    mockStore.inject({ route: 'addKnowledge', status: 200, until: b.until, body: answered({ item_id: 'note-b', source: 'setup', title: 'Parking is on the street.', text: 'Parking is on the street.', label: {} }, ['owner']) });
    await main(screen).getByRole('button', { name: 'Add a note' }).click();
    await expect.element(main(screen).getByRole('button', { name: 'Add a note' })).toHaveAttribute('aria-busy', 'true');
    await expect.element(switchOf(screen)).toHaveAttribute('aria-disabled', 'true');
    await expect.element(switchOf(screen)).not.toHaveAttribute('aria-busy', 'true');
    // Force the press past Playwright's disabled-control wait to check the component's guard.
    await switchOf(screen).click({ force: true });
    expect(posts()).toHaveLength(2);
    await expect.element(main(screen).getByRole('button', { name: 'Add a note' })).toHaveAttribute('aria-busy', 'true');
    await expect.element(switchOf(screen)).toHaveAttribute('aria-checked', 'false');

    // B lands: its card replaces A's, and its switch changes B, not A.
    b.release();
    await expect.element(main(screen).getByRole('button', { name: 'Add a note' })).not.toHaveAttribute('aria-busy', 'true');
    await switchOf(screen).click();
    await expect.poll(() => posts()).toHaveLength(3);
    expect(posts()[2]?.item_id).toBe('note-b');
    expect(posts().filter((posted) => posted.item_id === a)).toHaveLength(1);
  });

  it('knowledge_file_that_cannot_be_read_says_so', async () => {
    const { screen } = await renderRoute(KNOWLEDGE);
    await expect.element(main(screen).getByRole('button', { name: 'Add a file' })).toBeVisible();
    // The browser can't read the file: it says so, never that the file is empty, and sends nothing.
    const unreadable = vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValueOnce(new DOMException('The file could not be read.', 'NotReadableError'));
    await pick(screen, new File(['# Prices'], 'price-list.md', { type: 'text/markdown' }));
    await expect.element(main(screen).getByRole('alert')).toHaveTextContent(KNOWLEDGE_COPY.unreadable);
    expect(unreadable).toHaveBeenCalled();
    expect(posts()).toEqual([]);
    // Picked again, it is read and added.
    await pick(screen, new File(['# Prices'], 'price-list.md', { type: 'text/markdown' }));
    await expect.element(switchOf(screen)).toBeVisible();
    expect(posts()).toHaveLength(1);
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

  it('knowledge_unparseable_added_date_has_no_detail_line', async () => {
    mockStore.inject({ route: 'knowledge', status: 200, body: [
      { item_id: 'legacy', title: 'Your website', text: 'Your website', readers: ['public'], source: 'website', created_at: 'soon' },
    ] });
    const { screen } = await renderRoute(KNOWLEDGE);
    const row = main(screen).getByRole('list', { name: 'What I know now' }).getByRole('listitem');
    await expect.element(row).toBeVisible();
    expect(row.element().querySelector('.cd-knowledge-list__detail')).toBeNull();
    expect(row.element().textContent).toBe('Your websiteCustomers can see this');
  });

  it('knowledge_keeps_api_order_and_handles_unknown_added_dates', async () => {
    const rows: KnowledgeRow[] = [
      { item_id: 'legacy', title: 'An older note', text: 'An older note', readers: ['owner'], source: 'setup', created_at: null },
      { item_id: 'recent', title: 'A recent note', text: 'A recent note', readers: ['public'], source: 'setup', created_at: '2026-10-30T19:30:00Z' },
      { item_id: 'withheld', title: null, text: null, readers: ['owner'], source: 'memory_import', created_at: null },
      { item_id: 'earlier', title: 'An earlier note', text: 'An earlier note', readers: ['public'], source: 'setup', created_at: '2026-10-26T19:30:00Z' },
    ];
    // Keep exactly the order received, even when an injected answer is not chronological.
    for (const viewport of ['desktop', 'phone'] as const) {
      mockStore.inject({ route: 'knowledge', status: 200, body: rows });
      const { screen } = await renderRoute(KNOWLEDGE, { viewport, pollScale: 100 });
      const list = main(screen).getByRole('list', { name: 'What I know now' });
      await expect.element(list).toBeVisible();
      expect(list.getByRole('listitem').elements().map((row) => row.textContent)).toEqual([
        'An older noteOnly you',
        'A recent noteAdded Oct 30Customers can see this',
        'A note only you can seeOnly you',
        'An earlier noteAdded Oct 26Customers can see this',
      ]);
      expect(list.getByRole('listitem').elements().map((row) => row.querySelector('.cd-knowledge-list__detail')?.textContent ?? null)).toEqual([
        null,
        'Added Oct 30',
        null,
        'Added Oct 26',
      ]);
      expectNoHorizontalScroll();
      await expectScreenBasics(screen.container, { owner: true });
    }
  });

  it('knowledge_lists_what_i_know', async () => {
    freezeClock();
    mockStore.world.knowledge.clear();
    // What the Desk knows, oldest first: one customers can see, one the owner keeps private, and one
    // the kernel keeps to the owner, whose title and words the list withholds.
    know({ item_id: 'website', source: 'website', title: 'Your website', text: 'Turner Plumbing fixes leaks and drains around Oakland.' }, ['public'], 4);
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
    expect(list.getByRole('listitem').elements()[3]?.textContent).toBe(`${NOTE_TITLE}Added Oct 30Only you`);
    // Made public with its switch, its row says so.
    await switchOf(screen).click();
    await expect.poll(() => list.getByRole('listitem').elements()[3]?.textContent).toBe(`${NOTE_TITLE}Added Oct 30Customers can see this`);
  });

  it('knowledge_list_loads_fails_and_is_left_out_when_empty', async () => {
    // A copy with its items removed: no list at all, only the way to add something.
    mockStore.world.knowledge.clear();
    const empty = await renderRoute(KNOWLEDGE);
    await expect.element(main(empty.screen).getByRole('region', { name: 'Add something' })).toBeVisible();
    await expect.poll(() => mockStore.requests.filter((r) => r.key === 'knowledge').length).toBeGreaterThan(0);
    await expect.element(main(empty.screen).getByRole('status').filter({ hasText: 'Loading what I know' })).not.toBeInTheDocument();
    expect(main(empty.screen).getByRole('region', { name: 'What I know now' }).query()).toBeNull();

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
    mockStore.world.knowledge.clear();
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
    // Move the pointer off "Add a note", then let its hover-exit transition finish before
    // measuring the resting fill: leaving hover starts the color change, rather than ending it.
    await userEvent.hover(lead);
    const addNoteButton = main(screen).getByRole('button', { name: 'Add a note' }).element();
    await settled(addNoteButton);
    expectComputed(addNoteButton, SPEC.primary);

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
