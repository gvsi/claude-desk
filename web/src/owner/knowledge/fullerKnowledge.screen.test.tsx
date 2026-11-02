import { expect, it, onTestFinished } from 'vitest';

import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { mockDrain } from '../../test/mockDrain.ts';
import { renderRoute } from '../../test/renderRoute.tsx';

it.each(['desktop', 'phone'] as const)('knowledge_sources_and_previews_%s', async (viewport) => {
  const { screen } = await renderRoute(`/app/${RIVERA.deskId}/knowledge`, { viewport, pollScale: 100 });
  const main = screen.getByRole('main');
  await expect.element(main.getByText('What Claude answers from. It never changes your rules.', { exact: true })).toBeVisible();
  const list = main.getByRole('list', { name: 'What Claude knows' });
  await expect.poll(() => list.getByRole('listitem').elements().length).toBe(6);
  await expect.element(main.getByText('6 sources. Customers can see 5.', { exact: true })).toBeVisible();
  const rows = list.getByRole('listitem').elements();
  expect(rows.slice(2).map((row) => row.querySelector('.cd-pill')?.textContent)).toEqual(['Mock', 'Mock', 'Mock', 'Mock']);
  expect(rows.slice(2).map((row) => row.querySelector('.cd-knowledge-list__title')?.textContent)).toEqual([
    'Maintenance plan.pdf', 'Warranty terms.docx', 'Service area map.pdf', 'turner-plumbing.example/faq',
  ]);
  expect(rows.slice(2).map((row) => row.querySelector('.cd-knowledge-list__detail')?.textContent)).toEqual([
    'PDF · 2 pages · Added Oct 28 · Customers can see this', 'Word document · 3 pages · Added Oct 28 · Only you',
    'PDF · 1 page · Added Oct 30 · Customers can see this', 'Website page · Read again every week · Customers can see this',
  ]);
  expect(rows.slice(2).flatMap((row) => [...row.querySelectorAll('button, a, input')])).toHaveLength(0);
  expect(rows.map((row) => row.querySelector('.cd-knowledge-list__tile')?.getAttribute('data-kind'))).toEqual(['globe', 'list', 'document', 'document', 'document', 'globe']);
  expect(rows.slice(2, 5).map((row) => row.querySelector('.cd-knowledge-list__file-tag')?.textContent)).toEqual(['PDF', 'DOCX', 'PDF']);
  const add = main.getByRole('region', { name: 'Add something' }).element();
  const known = main.getByRole('region', { name: 'What Claude knows' }).element();
  const questions = main.getByRole('region', { name: 'Questions Claude couldn’t answer' }).element();
  const more = main.getByRole('region', { name: 'More sources' }).element();
  expect(questions.querySelector('.cd-pill')?.textContent).toBe('Mock');
  expect(more.querySelector('.cd-pill')?.textContent).toBe('Mock');
  expect(questions.textContent).toContain('Sample questions, to show what this will do. It doesn’t work in this prototype yet.');
  expect(more.textContent).toContain('Connecting these doesn’t work in this prototype yet.');
  expect([...more.querySelectorAll('li')].map((row) => row.textContent)).toEqual([
    'Google DriveDocs and PDFs you pick, read again when they change.Coming later',
    'NotionPages you share with your Desk.Coming later',
    'Your website, kept freshRead again every week, so new prices and hours reach Claude.Coming later',
  ]);
  expect([...questions.querySelectorAll('button, a, input'), ...more.querySelectorAll('button, a, input')]).toHaveLength(0);

  expect([...more.querySelectorAll('li .cd-pill')].map((pill) => pill.textContent)).toEqual(['Coming later', 'Coming later', 'Coming later']);
  expect([...questions.querySelectorAll('li')].map((row) => row.textContent)).toEqual([
    'Do you install water softeners?Asked 3 times this week',
    'Can you come out on a Sunday for a burst pipe?Asked twice this week',
    'Do you take credit cards on site?Asked once, on Friday',
  ]);
  const box = (el: Element) => el.getBoundingClientRect();
  if (viewport === 'desktop') {
    expect(Math.round(box(add).width)).toBe(320);
    expect(Math.round(box(add).left - box(known).right)).toBe(40);
    expect(Math.round(box(add).top)).toBe(Math.round(box(known).top));
  } else {
    expect(box(add).top).toBeGreaterThan(box(known).bottom);
    expect(box(questions).top).toBeGreaterThan(box(add).bottom);
    expect(box(more).top).toBeGreaterThan(box(questions).bottom);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  }
  await main.getByRole('textbox', { name: 'A website', exact: true }).fill('example.com');
  await mockDrain.waitForIdle();
  const before = mockStore.requests.length;
  await main.getByRole('button', { name: 'Add a website', exact: true }).click();
  expect(mockStore.requests.length).toBe(before);
});

it('mock_sources_stay_on_the_copys_starting_desk', async () => {
  const { screen } = await renderRoute(`/app/${RIVERA.emergenciesDeskId}/knowledge`, { seed: 'rivera_two_desks' });
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Knowledge' })).toBeVisible();
  await expect.element(screen.getByRole('textbox', { name: 'A note' })).toBeVisible();
  expect(screen.getByText('Maintenance plan.pdf', { exact: true }).query()).toBeNull();
});

it('source_kinds_keep_their_tiles_and_detail_prefixes', async () => {
  mockStore.inject({ route: 'knowledge', status: 200, body: [
    { item_id: 'note', title: 'A note', text: 'A note', source: 'setup', readers: ['owner'], created_at: null },
    { item_id: 'pdf', title: 'Manual.pdf', text: 'Manual', source: 'upload', readers: ['public'], created_at: null },
    { item_id: 'docx', title: 'Terms.docx', text: 'Terms', source: 'upload', readers: ['owner'], created_at: null },
  ] });
  const { screen } = await renderRoute(`/app/${RIVERA.deskId}/knowledge`);
  const list = screen.getByRole('list', { name: 'What Claude knows' });
  await expect.element(list).toBeVisible();
  const rows = list.getByRole('listitem').elements().slice(0, 3);
  expect(rows.map((row) => row.querySelector('.cd-knowledge-list__tile')?.getAttribute('data-kind'))).toEqual(['note', 'document', 'document']);
  expect(rows.map((row) => row.querySelector('.cd-knowledge-list__detail')?.textContent)).toEqual(['Note', 'File', 'File']);
  expect(rows.map((row) => row.querySelector('.cd-knowledge-list__file-tag')?.textContent ?? null)).toEqual([null, 'PDF', 'DOCX']);
  const tile = rows[0]!.querySelector('.cd-knowledge-list__tile')!;
  const style = getComputedStyle(tile);
  expect([style.width, style.height, style.borderRadius]).toEqual(['36px', '36px', '8px']);
  expect(style.backgroundColor).toBe('rgba(250, 249, 245, 0.1)');
  expect(style.color).toBe('rgba(250, 249, 245, 0.64)');
  const tag = getComputedStyle(rows[1]!.querySelector('.cd-knowledge-list__file-tag')!);
  expect([tag.fontSize, tag.lineHeight, tag.backgroundColor, tag.borderTopColor]).toEqual(['9px', '13px', 'rgb(42, 41, 39)', 'rgba(250, 249, 245, 0.14)']);
});

it('one_real_source_counts_without_mock_sources_on_another_desk', async () => {
  mockStore.reset('rivera_two_desks');
  mockStore.inject({ route: 'knowledge', status: 200, body: [
    { item_id: 'note', title: 'Ring the bell', text: 'Ring the bell', source: 'setup', readers: ['owner'], created_at: null },
  ] });
  const { screen } = await renderRoute(`/app/${RIVERA.emergenciesDeskId}/knowledge`, { pollScale: 100 });
  await expect.element(screen.getByText('1 source. Customers can see 0.', { exact: true })).toBeVisible();
  const list = screen.getByRole('list', { name: 'What Claude knows' });
  expect(list.getByRole('listitem').elements()).toHaveLength(1);
  expect(list.getByText('Mock', { exact: true }).query()).toBeNull();
});


it('mock_sources_do_not_follow_the_deleted_starting_desk', async () => {
  const { screen, router } = await renderRoute(`/app/${RIVERA.deskId}/knowledge`, { seed: 'rivera_two_desks', pollScale: 100 });
  await expect.element(screen.getByText('Maintenance plan.pdf', { exact: true })).toBeVisible();
  await router.navigate(`/app/${RIVERA.deskId}/settings/general`);
  await screen.getByRole('button', { name: 'Delete this Desk', exact: true }).click();
  await screen.getByRole('dialog', { name: "Delete Turner Plumbing's Main line?" }).getByRole('button', { name: 'Delete Desk', exact: true }).click();
  await expect.poll(() => router.state.location.pathname).toBe(`/app/${RIVERA.emergenciesDeskId}/today`);
  await router.navigate(`/app/${RIVERA.emergenciesDeskId}/knowledge`);
  await expect.poll(() => mockStore.requests.filter(({ key, path }) => key === 'knowledge' && path.includes(RIVERA.emergenciesDeskId)).length).toBeGreaterThan(0);
  await mockDrain.waitForIdle();
  const list = screen.getByRole('list', { name: 'What Claude knows' });
  expect(list.getByText('Mock', { exact: true }).elements()).toHaveLength(0);
  expect(screen.getByText('Maintenance plan.pdf', { exact: true }).query()).toBeNull();
});


it.each(['desktop', 'phone'] as const)('setup_sources_have_short_single_line_titles_%s', async (viewport) => {
  for (const [index, stored] of [...mockStore.world.knowledge.values()].entries()) stored.createdAt = Date.parse('2026-11-01T20:00:00Z') + index;
  const { screen } = await renderRoute(`/app/${RIVERA.deskId}/knowledge`, { viewport, pollScale: 100 });
  const list = screen.getByRole('list', { name: 'What Claude knows' });
  await expect.element(list).toBeVisible();
  const rows = list.getByRole('listitem').elements().slice(0, 2);
  expect(rows.map((row) => row.querySelector('.cd-knowledge-list__title')?.textContent)).toEqual(['turner-plumbing.example', 'Price list']);
  expect(rows.map((row) => row.querySelector('.cd-knowledge-list__detail')?.textContent)).toEqual([
    'Website · Read during setup · Added Nov 1', 'From your answers in setup · Added Nov 1',
  ]);
  for (const row of rows) {
    const title = row.querySelector('.cd-knowledge-list__title')!;
    expect(title.getBoundingClientRect().height).toBe(parseFloat(getComputedStyle(title).lineHeight));
  }
});


it('the_phone_source_list_keeps_its_skeleton_until_knowledge_arrives', async () => {
  let release!: () => void;
  const until = new Promise<void>((resolve) => { release = resolve; });
  onTestFinished(() => release());
  const answer = await mockStore.dispatch('knowledge', { params: { desk_id: RIVERA.deskId } });
  mockStore.inject({ route: 'knowledge', status: 200, until, body: 'body' in answer ? answer.body : [] });
  const { screen } = await renderRoute(`/app/${RIVERA.deskId}/knowledge`, { viewport: 'phone', pollScale: 100 });
  await expect.element(screen.getByRole('region', { name: 'Add something', exact: true })).toBeVisible();
  const known = screen.container.querySelector('.cd-knowledge__known')!;
  const add = screen.getByRole('region', { name: 'Add something', exact: true }).element();
  const pendingTop = add.getBoundingClientRect().top;
  expect(known.querySelectorAll('.cd-knowledge-list__row')).toHaveLength(6);
  release();
  await expect.element(screen.getByRole('list', { name: 'What Claude knows' })).toBeVisible();
  const loadedTop = add.getBoundingClientRect().top;
  // The unknown rows can be taller than their shapes, but the source list never collapses to a line.
  expect(Math.abs(loadedTop - pendingTop)).toBeLessThan(250);
});
