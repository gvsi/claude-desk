import { expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { ConnectorIcon } from './ConnectorIcon.tsx';

it('draws_an_explicit_glyph_on_a_built_in_tile_even_with_a_brand_icon', async () => {
  const screen = await render(<ConnectorIcon icon="stripe" glyph="conversations" size="section" />);
  const tile = screen.container.querySelector('.cd-connector-icon')!;
  expect(tile.classList.contains('cd-connector-icon--built-in')).toBe(true);
  expect(tile.getAttribute('aria-hidden')).toBe('true');
  expect(tile.querySelector('svg')).not.toBeNull();
  expect(tile.querySelector('path[fill]')).toBeNull();
});

// Share's More channels (board REV-CHAN A) draws each channel's line icon on the section tile.
it.each(['app-window', 'message-circle', 'message-square', 'phone'] as const)('draws_the_%s_channel_glyph_on_a_36px_built_in_tile', async (glyph) => {
  const screen = await render(<ConnectorIcon icon="quotes" glyph={glyph} size="section" />);
  const tile = screen.container.querySelector<HTMLElement>('.cd-connector-icon')!;
  expect(tile.classList.contains('cd-connector-icon--built-in')).toBe(true);
  const box = tile.getBoundingClientRect();
  expect([box.width, box.height]).toEqual([36, 36]);
  const svg = tile.querySelector('svg')!;
  expect(svg.getAttribute('stroke')).toBe('currentColor');
  const mark = svg.getBoundingClientRect();
  expect([mark.width, mark.height]).toEqual([20, 20]);
  // Centred on the tile.
  expect(mark.left - box.left).toBe(8);
  expect(mark.top - box.top).toBe(8);
});
