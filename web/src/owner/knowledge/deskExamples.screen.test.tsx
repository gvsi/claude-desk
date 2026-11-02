import { expect, it } from 'vitest';

import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { liveSetupDeskIds } from '../../test/liveSetupDesk.ts';
import { renderRoute } from '../../test/renderRoute.tsx';

import { MOCK_SOURCES } from './previewSources.ts';

const QUESTIONS = 'Questions Claude couldn’t answer';
const QUESTION_NOTE = 'Sample questions, to show what this will do. It doesn’t work in this prototype yet.';
const MORE_NOTE = 'Connecting these doesn’t work in this prototype yet.';
const OTHER_QUESTIONS = ['Do you sell gift cards?', 'Is there parking nearby?', 'Do you take credit cards?'];

/** A preview list's question titles, in order. */
function titles(list: Element): (string | null | undefined)[] {
  return [...list.querySelectorAll('li')].map((row) => row.querySelector('.cd-knowledge-list__title')?.textContent);
}

it.each(['desktop', 'phone'] as const)('knowledge_examples_belong_to_their_business_%s', async (viewport) => {
  const starting = await renderRoute(`/app/${RIVERA.deskId}/knowledge`, { viewport, pollScale: 100 });
  const questions = starting.screen.getByRole('region', { name: QUESTIONS, exact: true });
  await expect.element(questions).toBeVisible();
  expect(questions.getByRole('listitem').elements().map((row) => row.querySelector('.cd-knowledge-list__title')?.textContent)).toEqual([
    'Do you install water softeners?',
    'Can you come out on a Sunday for a burst pipe?',
    'Do you take credit cards on site?',
  ]);
  expect.soft(starting.screen.getByRole('textbox', { name: 'A website', exact: true }).element().getAttribute('placeholder')).toBe('turner-plumbing.example/blog');

  const salon = await liveSetupDeskIds('A hair salon in Oakland');
  const { screen } = await renderRoute(`/app/${salon.deskId}/knowledge`, { viewport, pollScale: 100 });
  // A salon's Desk shows its own business type's sample questions, never the plumber's.
  const salonQuestions = screen.getByRole('region', { name: QUESTIONS, exact: true });
  await expect.element(screen.getByRole('textbox', { name: 'A website', exact: true })).toBeVisible();
  await expect.element(salonQuestions.getByText(QUESTION_NOTE, { exact: true })).toBeVisible();
  expect(titles(salonQuestions.element())).toEqual(OTHER_QUESTIONS);
  expect.soft(screen.getByRole('textbox', { name: 'A website', exact: true }).element().hasAttribute('placeholder')).toBe(false);
  const more = screen.getByRole('region', { name: 'More sources', exact: true });
  await expect.element(more.getByText(MORE_NOTE, { exact: true })).toBeVisible();
  await expect.element(more.getByText('Mock', { exact: true })).toBeVisible();
  expect(more.getByRole('listitem').elements().map((row) => row.querySelector('.cd-knowledge-list__title')?.textContent)).toEqual([
    'Google Drive', 'Notion', 'Your website, kept fresh',
  ]);
});

it('deleting_the_starting_desk_and_reloading_keeps_samples_off_other_businesses', async () => {
  const salon = await liveSetupDeskIds('A hair salon in Oakland');
  const starting = await renderRoute(`/app/${RIVERA.deskId}/knowledge`, { pollScale: 100 });
  await expect.element(starting.screen.getByText('Maintenance plan.pdf', { exact: true })).toBeVisible();
  await starting.router.navigate(`/app/${RIVERA.deskId}/settings/general`);
  await starting.screen.getByRole('button', { name: 'Delete this Desk', exact: true }).click();
  await starting.screen.getByRole('dialog').getByRole('button', { name: 'Delete Desk', exact: true }).click();
  await expect.poll(() => starting.router.state.location.pathname).toBe(`/app/${salon.deskId}/today`);
  expect(mockStore.world.desk(RIVERA.deskId)).toBeUndefined();

  const { screen } = await renderRoute(`/app/${salon.deskId}/knowledge`, { pollScale: 100 });
  const website = screen.getByRole('textbox', { name: 'A website', exact: true });
  await expect.element(website).toBeVisible();
  await expect.element(screen.getByRole('status', { name: 'Loading what I know', exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByRole('region', { name: QUESTIONS, exact: true })).toBeVisible();
  expect(titles(screen.getByRole('region', { name: QUESTIONS, exact: true }).element())).toEqual(OTHER_QUESTIONS);
  for (const sample of MOCK_SOURCES) expect.soft(screen.getByText(sample.title!, { exact: true }).query()).toBeNull();
  expect.soft(website.element().hasAttribute('placeholder')).toBe(false);
  await expect.element(screen.getByRole('region', { name: 'More sources', exact: true })).toBeVisible();
});
