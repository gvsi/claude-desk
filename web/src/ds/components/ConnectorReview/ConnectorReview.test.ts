import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { ConnectorReview } from './ConnectorReview.tsx';

it('reviews a job with its title, lead and setup rows, sharing the existing tool and controls', () => {
  const root = document.createElement('div');
  root.innerHTML = renderToStaticMarkup(createElement(ConnectorReview, {
    job: { title: 'Book a free intro call', glyph: 'calendar', rows: [
      { label: 'Appointment', value: 'Free intro call' }, { label: 'Uses', value: 'Your opening hours' },
    ] },
    tools: [{ key: 'desk.intro-call', name: 'Book a free intro call', description: 'Offers open times.', mode: 'ask', coveredBy: [] }],
    onTurnOn: vi.fn(), onCancel: vi.fn(),
  }));
  expect(root.querySelector('h1')?.textContent).toBe('Book a free intro call');
  expect(root.textContent).toContain('A job from your setup questions. Here’s how it’s set up; nothing runs until you turn it on.');
  expect(root.textContent).not.toContain('built-in');
  expect(root.querySelector('h2')?.textContent).toBe('How it’s set up');
  expect([...root.querySelectorAll('dt')].map((el) => el.textContent)).toEqual(['Appointment', 'Uses']);
  expect([...root.querySelectorAll('dd')].map((el) => el.textContent)).toEqual(['Free intro call', 'Your opening hours']);
  expect(root.textContent).toContain('No rule of yours covers this yet, so it starts at Ask me first.');
  expect([...root.querySelectorAll('button')].map((el) => el.textContent)).toEqual(['Turn it on', 'Cancel']);
});

it("shows the screen's own line where no rule covers a tool, and today's line without it", () => {
  const own = 'Its own words for why it starts at Ask me first.';
  const tool = { key: 'desk.intro-call', name: 'Book a free intro call', description: 'Offers open times.', mode: 'ask' as const, coveredBy: [] };
  const lines = (tools: unknown[]) => {
    const root = document.createElement('div');
    root.innerHTML = renderToStaticMarkup(createElement(ConnectorReview, {
      job: { title: 'Book a free intro call', glyph: 'calendar', rows: [] }, tools: tools as never, onTurnOn: vi.fn(), onCancel: vi.fn(),
    }));
    return [...root.querySelectorAll('.cd-connector-review__covered')].map((el) => el.textContent);
  };
  expect(lines([{ ...tool, uncoveredLine: own }])).toEqual([own]);
  // Without it, or with only blank words, today's line.
  expect(lines([tool])).toEqual(['No rule of yours covers this yet, so it starts at Ask me first.']);
  expect(lines([{ ...tool, uncoveredLine: '  ' }])).toEqual(['No rule of yours covers this yet, so it starts at Ask me first.']);
  // A rule of the owner's that covers the tool still shows, in place of both.
  expect(lines([{ ...tool, uncoveredLine: own, coveredBy: [{ text: 'Bookings ask you first.', mode: 'ask' }] }]))
    .toEqual(['Covered by your rule: Bookings ask you first. · Ask me first']);
});

it('renders business titles, configuration and descriptions as text', () => {
  const title = '<img src=x onerror=alert(1)>';
  const value = '<script>alert(2)</script>';
  const root = document.createElement('div');
  root.innerHTML = renderToStaticMarkup(createElement(ConnectorReview, {
    job: { title, glyph: 'calendar', rows: [{ label: 'Appointment', value }] },
    tools: [{ key: 'desk.intro-call', name: title, description: value, mode: 'ask', coveredBy: [] }],
    onTurnOn: vi.fn(), onCancel: vi.fn(),
  }));
  expect(root.querySelector('h1')?.textContent).toBe(title);
  expect(root.querySelector('dd')?.textContent).toBe(value);
  expect(root.querySelector('img, script')).toBeNull();
});
