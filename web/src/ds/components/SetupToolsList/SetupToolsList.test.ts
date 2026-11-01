import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { SetupToolsList, type SetupJobRow } from './SetupToolsList.tsx';

it('lists jobs first with named Review buttons and On status, omitting an empty jobs group', () => {
  const jobs: SetupJobRow[] = [
    { key: 'desk.intro-call', title: 'Book a free intro call', line: 'Free intro call, 20 minutes, in your opening hours', glyph: 'calendar', state: 'needs_review', onReview: vi.fn() },
    { key: 'desk.intake', title: 'New client intake', line: '3 questions before a booking', glyph: 'person', state: 'on' },
  ];
  const root = document.createElement('div');
  root.innerHTML = renderToStaticMarkup(createElement(SetupToolsList, { jobs, builtIn: [], external: [] }));
  expect(root.querySelector('h2')?.textContent).toBe('Your Desk’s jobs');
  const rows = root.querySelectorAll('li');
  expect(rows).toHaveLength(2);
  expect(rows[0]?.querySelector('button .cd-sr-only')?.textContent).toBe('Review Book a free intro call');
  expect(rows[0]?.querySelector('button [aria-hidden="true"]')?.textContent).toBe('Review');
  expect(rows[0]?.textContent).toContain('Needs review');
  expect(rows[0]?.querySelector('.cd-status-dot--held')).not.toBeNull();
  expect(rows[1]?.textContent).toContain('On');
  expect(rows[1]?.querySelector('button')).toBeNull();
  expect(rows[1]?.querySelector('.cd-status-dot--handled')).not.toBeNull();
  for (const value of [undefined, []]) {
    expect(renderToStaticMarkup(createElement(SetupToolsList, { jobs: value, builtIn: [], external: [] }))).not.toContain('Your Desk');
  }
});
