import { expect, it } from 'vitest';

import { formatPublicHours, formatPublicPrice, publicLineLabel } from './publicLinesFormat.ts';

it('formats local windows with collapsed day ranges, minutes, noon and midnight and prices with exact cents', () => {
  expect(formatPublicHours({ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '18:00' })).toBe('Mon–Fri, 9 am – 6 pm');
  const windows = [
    { days: ['fri', 'mon', 'wed', 'tue'] as const, start: '09:30', end: '12:00' },
    { days: ['sat'] as const, start: '18:00', end: '00:00' },
  ];
  expect(windows.map((window) => formatPublicHours({ ...window, days: [...window.days] }))).toEqual([
    'Mon–Wed, Fri, 9:30 am – 12 pm', 'Sat, 6 pm – 12 am',
  ]);
  expect(formatPublicHours({ days: ['mon', 'wed', 'fri'], start: '00:00', end: '01:05' })).toBe('Mon, Wed, Fri, 12 am – 1:05 am');
  expect([25000, 186000, 4050].map((unit_cents) => formatPublicPrice({ title: 'Review', unit_cents }))).toEqual([
    'Review, $250', 'Review, $1,860', 'Review, $40.50',
  ]);
});

it('names each public line as the public About panel labels it', () => {
  expect(['policy:about', 'contact', 'policy:intake', 'policy:service_area', 'policy:how_we_help'].map(publicLineLabel)).toEqual([
    'About us', 'Contact', 'Getting started', 'Service area', 'How we help',
  ]);
});
