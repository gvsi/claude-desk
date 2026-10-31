/**
 * Claude's writing dots and the typing dots under prefers-reduced-motion: reduce, which this
 * project's browser context emulates. The ReducedMotion and PersonReducedMotion stories run with
 * their plays, so their reduced-motion branches are checked: the dots stay still in text-secondary,
 * and who is typing is still said.
 */
import { composeStory } from '@storybook/react-vite';
import { expect, it } from 'vitest';

import meta, { PersonReducedMotion, ReducedMotion } from './WritingIndicator.stories.tsx';

it('claude_writing_shows_only_three_dots_in_one_reply_line_and_announces_the_words', async () => {
  const story = composeStory({ args: { language: 'en' } }, meta);
  await story.run();

  const status = document.querySelector<HTMLElement>('[role="status"]') as HTMLElement;
  expect(status.textContent).toBe('Claude is writing');
  expect(status.lang).toBe('en');
  expect(status).toHaveClass('cd-writing-indicator--claude', 'cd-type-reply');
  const words = status.querySelector<HTMLElement>('.cd-sr-only') as HTMLElement;
  expect(words?.textContent).toBe('Claude is writing');
  expect(getComputedStyle(words).position).toBe('absolute');
  expect(words.getBoundingClientRect().width).toBe(1);
  const dots = status.querySelector<HTMLElement>('.cd-writing-indicator__dots') as HTMLElement;
  expect(dots?.getAttribute('aria-hidden')).toBe('true');
  expect(dots.textContent).toBe('');
  expect(status.children).toHaveLength(2);
  const each = [...dots.querySelectorAll<HTMLElement>('.cd-writing-indicator__dot')];
  expect(each).toHaveLength(3);
  const line = Number.parseFloat(getComputedStyle(status).lineHeight);
  expect(getComputedStyle(status).fontFamily).toContain('Source Serif 4');
  expect(dots.getBoundingClientRect().height).toBe(line);
  expect(status.getBoundingClientRect().height).toBe(line);
  expect(dots.getBoundingClientRect().left).toBe(status.getBoundingClientRect().left);
  expect(getComputedStyle(status).backgroundColor).toBe('rgba(0, 0, 0, 0)');
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  for (const dot of each) {
    const box = dot.getBoundingClientRect();
    expect(box.top + box.height / 2).toBe(dots.getBoundingClientRect().top + line / 2);
    expect(getComputedStyle(dot).animationName).toBe('none');
    expect(getComputedStyle(dot).backgroundColor).toBe('rgba(250, 249, 245, 0.64)');
  }
});

it('claude_writing_announces_spanish_with_no_visible_words', async () => {
  const story = composeStory({ args: { language: 'es' } }, meta);
  await story.run();

  const status = document.querySelector<HTMLElement>('[role="status"]') as HTMLElement;
  expect(status.lang).toBe('es');
  expect(status.textContent).toBe('Claude está escribiendo');
  expect(status.querySelector('.cd-sr-only')?.textContent).toBe('Claude está escribiendo');
  const dots = status.querySelector('[aria-hidden="true"]');
  expect(dots?.textContent).toBe('');
  expect(dots?.querySelectorAll('.cd-writing-indicator__dot')).toHaveLength(3);
});

it('typing_bubble_is_still_under_reduced_motion', async () => {
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  const story = composeStory(ReducedMotion, meta);
  await story.run();

  const status = document.querySelector<HTMLElement>('[role="status"]');
  expect(status?.textContent).toBe('Dana is typing');
  const dots = [...document.querySelectorAll<HTMLElement>('.cd-writing-indicator__dot')];
  expect(dots).toHaveLength(3);
  for (const dot of dots) {
    const style = getComputedStyle(dot);
    expect(style.animationName).toBe('none');
    expect(style.backgroundColor).toBe('rgba(250, 249, 245, 0.64)');
  }
});

it('person_typing_is_still_under_reduced_motion', async () => {
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  const story = composeStory(PersonReducedMotion, meta);
  await story.run();

  const status = document.querySelector<HTMLElement>('.cd-writing-indicator--person [role="status"]');
  expect(status?.textContent).toBe('Maria Rivera is typing');
  const dots = [...document.querySelectorAll<HTMLElement>('.cd-writing-indicator--person .cd-writing-indicator__dot')];
  expect(dots).toHaveLength(3);
  for (const dot of dots) {
    const style = getComputedStyle(dot);
    expect(style.animationName).toBe('none');
    expect(style.backgroundColor).toBe('rgba(250, 249, 245, 0.64)');
  }
});
