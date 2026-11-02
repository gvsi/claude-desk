import { expect, it } from 'vitest';

import { RIVERA } from '../../mocks/seed.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { KNOWLEDGE_COPY } from './KnowledgePage.tsx';

it.each(['desktop', 'phone'] as const)('empty_note_error_belongs_to_the_note_and_clears_on_text_%s', async (viewport) => {
  const { screen } = await renderRoute(`/app/${RIVERA.deskId}/knowledge`, { viewport, pollScale: 100 });
  const note = screen.getByRole('textbox', { name: 'A note', exact: true });
  const website = screen.getByRole('textbox', { name: 'A website', exact: true });
  await screen.getByRole('button', { name: 'Add a note', exact: true }).click();
  const error = screen.getByText(KNOWLEDGE_COPY.emptyNote, { exact: true });
  await expect.element(error).toBeVisible();
  expect.soft(note.element().getAttribute('aria-invalid')).toBe('true');
  const descriptions = (note.element().getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id));
  expect.soft(descriptions.some((element) => element?.contains(error.element()))).toBe(true);
  expect.soft(error.element().closest('.cd-text-field')).toBe(note.element().closest('.cd-text-field'));
  expect.soft(error.element().getBoundingClientRect().bottom).toBeLessThan(website.element().getBoundingClientRect().top);
  await note.fill('   ');
  await expect.element(error).toBeVisible();
  await note.fill('We offer weekend appointments.');
  expect.soft(error.query()).toBeNull();
  expect.soft(note.element().getAttribute('aria-invalid')).toBeNull();
  expect.soft(website.element().getAttribute('aria-invalid')).toBeNull();
});
