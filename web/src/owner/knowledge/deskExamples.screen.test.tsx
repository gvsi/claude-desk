import { expect, it } from 'vitest';

import { RIVERA } from '../../mocks/seed.ts';
import { liveSetupDeskIds } from '../../test/liveSetupDesk.ts';
import { renderRoute } from '../../test/renderRoute.tsx';

const QUESTIONS = 'Questions Claude couldn’t answer';
const QUESTION_NOTE = 'Sample questions, to show what this will do. It doesn’t work in this prototype yet.';
const MORE_NOTE = 'Connecting these doesn’t work in this prototype yet.';

it.each(['desktop', 'phone'] as const)('knowledge_examples_belong_only_to_the_starting_desk_%s', async (viewport) => {
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
  const salonQuestions = screen.getByRole('region', { name: QUESTIONS, exact: true });
  await expect.element(screen.getByRole('textbox', { name: 'A website', exact: true })).toBeVisible();
  expect.soft(salonQuestions.query()).toBeNull();
  expect.soft(screen.getByRole('heading', { name: QUESTIONS, exact: true }).query()).toBeNull();
  expect.soft(screen.getByText(QUESTION_NOTE, { exact: true }).query()).toBeNull();
  expect.soft(screen.getByRole('textbox', { name: 'A website', exact: true }).element().hasAttribute('placeholder')).toBe(false);
  const more = screen.getByRole('region', { name: 'More sources', exact: true });
  await expect.element(more.getByText(MORE_NOTE, { exact: true })).toBeVisible();
  await expect.element(more.getByText('Mock', { exact: true })).toBeVisible();
  expect(more.getByRole('listitem').elements().map((row) => row.querySelector('.cd-knowledge-list__title')?.textContent)).toEqual([
    'Google Drive', 'Notion', 'Your website, kept fresh',
  ]);
});
