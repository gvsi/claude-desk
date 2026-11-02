/**
 * The colours on an owner's chosen colour: every colour Profile offers carries each of them at its
 * minimum, the words at 4.5:1 and the open-status dot at 3:1, in either theme, since they are the
 * same in both.
 */
import { expect, test } from 'vitest';

import { ON_BRAND_COLORS, contrastRatio } from '../../ds/contrast.ts';
import { BRAND_PALETTE, PALETTE_NAMES } from '../../public/palette.ts';

test('every_palette_colour_carries_the_colours_on_it', () => {
  const fields = Object.entries(BRAND_PALETTE).flatMap(([key, colours]) => ('primary' in colours ? [[key, colours.primary] as const] : []));
  expect(fields.map(([key]) => key)).toEqual(Object.keys(PALETTE_NAMES).filter((key) => key !== 'none'));
  expect(Object.keys(ON_BRAND_COLORS)).toEqual(['text-on-brand', 'text-on-brand-secondary', 'status-handled-on-brand']);
  for (const [key, field] of fields) {
    for (const [name, { min }] of Object.entries(ON_BRAND_COLORS)) {
      expect(contrastRatio(name, field), `${name} on ${key} (${field})`).toBeGreaterThanOrEqual(min);
    }
  }
});
