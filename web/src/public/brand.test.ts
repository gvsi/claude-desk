/**
 * The business's look on its public page, from the Desk the kernel serves: only plain colors pass,
 * and only when the shell's text stays readable over them.
 */
import { describe, expect, it } from 'vitest';

import type { PublicDesk } from '../api/contracts.ts';
import { rivera } from '../ds/fixtures/index.ts';
import { brandFrom } from './brand.ts';

const desk: PublicDesk = rivera.publicDesk.en;

function withBrand(brand: Record<string, string>): PublicDesk {
  return { ...desk, brand };
}

describe('brandFrom', () => {
  it('rivera_brand_maps_to_the_shell', () => {
    expect(brandFrom(desk).brand).toEqual({
      name: 'Rivera Plumbing',
      tagline: 'Main line',
      monogram: 'R',
      field: '#1F4E4A',
      ink: 'var(--text-primary)',
      inkSecondary: 'var(--text-secondary)',
      accent: '#B87333',
    });
  });

  it('low_contrast_brand_falls_back', () => {
    // Near-white: the shell's light text would be unreadable over it.
    expect(brandFrom(withBrand({ primary: '#f0f0f0', accent: '#B87333' })).brand.field).toBe('var(--bg-panel)');
    // Light enough for the primary text but not the tagline's secondary text: both must hold 4.5:1.
    expect(brandFrom(withBrand({ primary: '#2f625c', accent: '#B87333' })).brand.field).toBe('var(--bg-panel)');
    expect(brandFrom(withBrand({ primary: '#222220', accent: '#B87333' })).brand.field).toBe('#222220');
  });

  it('non_hex_brand_falls_back', () => {
    for (const value of ['url(https://x)', 'red; x', 'red', '#fff', '#1F4E4A ', 'var(--bg-app)', '']) {
      const { brand } = brandFrom(withBrand({ primary: value, accent: value }));
      expect(brand.field, value).toBe('var(--bg-panel)');
      expect(brand.accent, value).toBe('var(--line-hairline)');
    }
    // Missing keys, or values that aren't strings at all, fall back the same way.
    const { brand } = brandFrom({ ...desk, brand: { primary: 42, accent: null } as unknown as Record<string, string> });
    expect([brand.field, brand.accent]).toEqual(['var(--bg-panel)', 'var(--line-hairline)']);
    expect(brandFrom(withBrand({})).brand).toMatchObject({ field: 'var(--bg-panel)', accent: 'var(--line-hairline)' });
  });

  it('owner_name_from_the_business', () => {
    expect(brandFrom(desk).ownerName).toBe('Maria Rivera');
    expect(brandFrom({ ...desk, owner_display_name: 'Linda Chen', business_name: 'Chen & Co. CPA' })).toMatchObject({
      ownerName: 'Linda Chen',
      brand: { name: 'Chen & Co. CPA', monogram: 'C' },
    });
  });
});
