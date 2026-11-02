import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { contrastRatio } from '../ds/contrast.ts';
import { rivera } from '../ds/fixtures/index.ts';
import { brandFrom } from './brand.ts';
import { BRAND_PALETTE, PALETTE_KEYS, PALETTE_NAMES, paletteBrand, paletteKey } from './palette.ts';

describe('the header palette', () => {
  it('has exactly the generated BrandPalette keys, in display order', () => {
    const schema = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../backend/desk/contracts.schema.json'), 'utf8'));
    const palette = schema.$defs.DeskBusinessRequest.properties.brand_palette.anyOf.find((option: { enum?: string[] }) => option.enum).enum;
    expect(Object.keys(BRAND_PALETTE)).toEqual(palette);
  });

  it('names each pick and leaves legacy or unknown brands unselected', () => {
    expect(Object.keys(PALETTE_NAMES)).toEqual(PALETTE_KEYS);
    for (const key of PALETTE_KEYS) expect(paletteKey(paletteBrand(key))).toBe(key);
    const legacyBrands: (Record<string, string> | undefined)[] = [undefined, {}, { primary: '#222220' }, { palette: 'magenta' }, { palette: '__proto__' }];
    for (const brand of legacyBrands) {
      expect(paletteKey(brand)).toBeNull();
    }
    expect(paletteBrand('none')).toEqual({ palette: 'none' });
  });

  it('keeps both header inks readable and preserves every coloured field', () => {
    for (const [palette, colors] of Object.entries(BRAND_PALETTE)) {
      if (!('primary' in colors)) continue;
      for (const ink of ['var(--text-on-brand)', 'var(--text-on-brand-secondary)']) {
        expect(contrastRatio(ink, colors.primary), `${palette}: ${ink}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(brandFrom({ ...rivera.publicDesk.en, brand: { palette, ...colors } }).brand.field).toBe(colors.primary);
    }
  });
});
