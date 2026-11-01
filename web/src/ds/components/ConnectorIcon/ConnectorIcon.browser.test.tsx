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
