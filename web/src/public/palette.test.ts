import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { contrastRatio } from '../ds/contrast.ts';
import { rivera } from '../ds/fixtures/index.ts';
import { brandFrom } from './brand.ts';
import { BRAND_PALETTE } from './palette.ts';

describe('the header palette', () => {
  it('has exactly the generated BrandPalette keys, in display order', () => {
    const schema = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../backend/desk/contracts.schema.json'), 'utf8'));
    const palette = schema.$defs.DeskBusinessRequest.properties.brand_palette.anyOf.find((option: { enum?: string[] }) => option.enum).enum;
    expect(Object.keys(BRAND_PALETTE)).toEqual(palette);
  });

  it('keeps both header inks readable and preserves every coloured field', () => {
    for (const [palette, colors] of Object.entries(BRAND_PALETTE)) {
      if (!('primary' in colors)) continue;
      for (const ink of ['var(--text-primary)', 'var(--text-secondary)']) {
        expect(contrastRatio(ink, colors.primary), `${palette}: ${ink}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(brandFrom({ ...rivera.publicDesk.en, brand: { palette, ...colors } }).brand.field).toBe(colors.primary);
    }
  });
});
