import { expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { errorCopy } from '../../ds/index.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { KNOWLEDGE_COPY, MAX_FILE_BYTES } from './KnowledgePage.tsx';

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

it.each(['desktop', 'phone'] as const)('too_long_note_error_belongs_to_the_note_and_clears_on_text_%s', async (viewport) => {
  const { screen } = await renderRoute(`/app/${RIVERA.deskId}/knowledge`, { viewport, pollScale: 100 });
  const note = screen.getByRole('textbox', { name: 'A note', exact: true });
  const website = screen.getByRole('textbox', { name: 'A website', exact: true });
  await note.fill('x'.repeat(MAX_FILE_BYTES + 1));
  await screen.getByRole('button', { name: 'Add a note', exact: true }).click();
  const error = screen.getByText(errorCopy('invalid'), { exact: true });
  await expect.element(error).toBeVisible();
  expect.soft(note.element().getAttribute('aria-invalid')).toBe('true');
  const descriptions = (note.element().getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id));
  expect.soft(descriptions.some((element) => element?.contains(error.element()))).toBe(true);
  expect.soft(error.element().closest('.cd-text-field') === note.element().closest('.cd-text-field')).toBe(true);
  expect.soft(error.element().closest('[aria-live="polite"]')).not.toBeNull();
  expect.soft(error.element().getBoundingClientRect().bottom).toBeLessThan(website.element().getBoundingClientRect().top);
  expect.soft(website.element().getAttribute('aria-invalid')).toBeNull();
  await note.fill('We offer weekend appointments.');
  expect.soft(error.query()).toBeNull();
  expect.soft(note.element().getAttribute('aria-invalid')).toBeNull();
});

it('each_add_clears_previous_note_and_general_errors', async () => {
  const { screen } = await renderRoute(`/app/${RIVERA.deskId}/knowledge`, { pollScale: 100 });
  const addNote = screen.getByRole('button', { name: 'Add a note', exact: true });
  const noteError = screen.getByText(KNOWLEDGE_COPY.emptyNote, { exact: true });
  const fileError = screen.getByText(KNOWLEDGE_COPY.tooBig, { exact: true });
  await addNote.click();
  await expect.element(noteError).toBeVisible();
  const picker = screen.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(['x'.repeat(MAX_FILE_BYTES + 1)], 'price-list.md', { type: 'text/markdown' });
  await userEvent.upload(picker, file);
  await expect.element(fileError).toBeVisible();
  expect(noteError.query()).toBeNull();
  await addNote.click();
  await expect.element(noteError).toBeVisible();
  expect(fileError.query()).toBeNull();
  await userEvent.upload(picker, file);
  await screen.getByRole('textbox', { name: 'A note', exact: true }).fill('We offer weekend appointments.');
  await expect.element(fileError).toBeVisible();
  await addNote.click();
  await expect.element(screen.getByRole('region', { name: 'Added', exact: true })).toBeVisible();
  expect(noteError.query()).toBeNull();
  expect(fileError.query()).toBeNull();
});
