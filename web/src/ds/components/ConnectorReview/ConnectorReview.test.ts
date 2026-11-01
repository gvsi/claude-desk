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
