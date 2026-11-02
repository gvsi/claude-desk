/**
 * The inks on an owner's chosen colour: every colour Profile offers carries both of them at 4.5:1,
 * in either theme, since they are the same in both.
 */
import { expect, test } from 'vitest';

import { contrastRatio } from '../../ds/contrast.ts';
import { BRAND_PALETTE, PALETTE_NAMES } from '../../public/palette.ts';

test('every_palette_colour_carries_the_brand_inks', () => {
  const fields = Object.entries(BRAND_PALETTE).flatMap(([key, colours]) => ('primary' in colours ? [[key, colours.primary] as const] : []));
  expect(fields.map(([key]) => key)).toEqual(Object.keys(PALETTE_NAMES).filter((key) => key !== 'none'));
  for (const [key, field] of fields) {
    for (const ink of ['text-on-brand', 'text-on-brand-secondary']) {
      expect(contrastRatio(ink, field), `${ink} on ${key} (${field})`).toBeGreaterThanOrEqual(4.5);
    }
  }
});
