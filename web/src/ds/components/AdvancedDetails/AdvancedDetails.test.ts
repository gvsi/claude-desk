import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { AdvancedDetails, DetailsSlot, type AdvancedDetailsProps } from './AdvancedDetails.tsx';

const RULE: Omit<AdvancedDetailsProps, 'children'> = {
  fields: [
    { label: 'Rule', value: 'rv-link', mono: true },
    { label: 'Version', value: '7, proved against the always-on rules' },
  ],
  code: { label: 'The rule as you set it', value: { card_id: 'rv-link', mode: 'auto' } },
  onCopy: () => {},
  describedBy: 'rule-sentence',
};

function draw(props: Omit<AdvancedDetailsProps, 'children'>): HTMLElement {
  const host = document.createElement('div');
  const row = (toggle: ReactElement) => createElement('div', { className: 'row' }, createElement('p', { id: 'rule-sentence' }, 'Claude can send payment links up to $300'), toggle);
  host.innerHTML = renderToStaticMarkup(createElement(AdvancedDetails, { ...props, children: row }));
  return host;
}

it('collapsed_by_default_with_the_button_where_the_row_puts_it', () => {
  const el = draw(RULE);
  const toggle = el.querySelector('.row > button')!;
  expect(toggle.textContent).toBe('Details');
  expect(toggle.getAttribute('type')).toBe('button');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.getAttribute('aria-describedby')).toBe('rule-sentence');
  expect(toggle.classList.contains('cd-type-control')).toBe(true);
  // The chevron is drawn only; the words name the button.
  expect(toggle.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  // The panel it controls follows the row, hidden and empty until it's opened.
  const panel = el.querySelector(`#${CSS.escape(toggle.getAttribute('aria-controls')!)}`)!;
  expect(panel.previousElementSibling?.classList.contains('row')).toBe(true);
  expect(panel.hasAttribute('hidden')).toBe(true);
  expect(panel.textContent).toBe('');
  expect(el.textContent).not.toContain('rv-link');
});

it('a_row_without_details_keeps_an_empty_slot_its_width', () => {
  // REV-RULES-D v351: every status dot sits in one column just left of Details, so a row with no
  // Details (an always-on rule) keeps an empty slot the button's width: drawn as the button is, but
  // unseen, unread and never focused.
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(createElement(DetailsSlot));
  const slot = host.firstElementChild!;
  expect(slot.getAttribute('aria-hidden')).toBe('true');
  expect(slot.classList.contains('cd-advanced-details__toggle')).toBe(true);
  expect(slot.classList.contains('cd-advanced-details__slot')).toBe(true);
  expect(slot.classList.contains('cd-type-control')).toBe(true);
  expect(slot.textContent).toBe('Details');
  expect(host.querySelector('button, a, [tabindex]')).toBeNull();
});
