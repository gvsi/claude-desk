/**
 * The business's look on its public page, from the Desk the kernel serves: only plain colors pass,
 * and only when the header's paper ink stays readable over them.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PublicDesk } from '../api/contracts.ts';
import { rivera } from '../ds/fixtures/index.ts';
import { OWNER_NAME_FALLBACK, brandFrom } from './brand.ts';

/** The API's setup, which names the owner (`owner_name`) and falls back to `OWNER_NAME_FALLBACK`. */
const SETUP_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'backend', 'desk', 'api', 'setup.py');

// The design system's contrast check, which a test can make throw, as it does on a color it can't read.
// It also notes each ink it was asked about.
const contrast = vi.hoisted(() => ({ throws: false, inks: [] as string[] }));
vi.mock('../ds/contrast.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ds/contrast.ts')>();
  return {
    ...actual,
    contrastRatio: (...args: Parameters<typeof actual.contrastRatio>) => {
      contrast.inks.push(args[0]);
      if (contrast.throws) throw new Error('Unsupported color');
      return actual.contrastRatio(...args);
    },
  };
});

afterEach(() => {
  contrast.throws = false;
  contrast.inks = [];
});

const desk: PublicDesk = rivera.publicDesk.en;

function withBrand(brand: Record<string, string>): PublicDesk {
  return { ...desk, brand };
}

describe('brandFrom', () => {
  it('rivera_brand_maps_to_the_shell', () => {
    expect(brandFrom(desk).brand).toEqual({
      name: 'Turner Plumbing',
      tagline: 'Main line',
      monogram: 'T',
      field: '#1F4E4A',
      ink: 'var(--text-on-brand)',
      inkSecondary: 'var(--text-on-brand-secondary)',
      accent: '#B87333',
    });
  });

  it('the_owners_colour_keeps_paper_ink_in_either_theme', () => {
    // On the owner's colour the header's text is paper ink, which no theme changes, and that is the
    // ink the contrast check measures. Where the colour can't be used, the panel takes the theme's
    // own ink, dark on light paper and light on the dark ground.
    expect(brandFrom(desk).brand).toMatchObject({ field: '#1F4E4A', ink: 'var(--text-on-brand)', inkSecondary: 'var(--text-on-brand-secondary)' });
    expect(new Set(contrast.inks)).toEqual(new Set(['var(--text-on-brand)', 'var(--text-on-brand-secondary)']));
    for (const primary of ['#f0f0f0', 'red', undefined]) {
      const { brand } = brandFrom(withBrand(primary === undefined ? {} : { primary, accent: '#B87333' }));
      expect(brand, String(primary)).toMatchObject({ field: 'var(--bg-panel)', ink: 'var(--text-primary)', inkSecondary: 'var(--text-secondary)' });
    }
  });

  it('low_contrast_brand_falls_back', () => {
    // Near-white: the header's paper ink would be unreadable over it.
    expect(brandFrom(withBrand({ primary: '#f0f0f0', accent: '#B87333' })).brand.field).toBe('var(--bg-panel)');
    // Light enough for the primary text but not the tagline's secondary text: both must hold 4.5:1.
    expect(brandFrom(withBrand({ primary: '#2f625c', accent: '#B87333' })).brand.field).toBe('var(--bg-panel)');
    expect(brandFrom(withBrand({ primary: '#222220', accent: '#B87333' })).brand.field).toBe('#222220');

    // A contrast check that throws can't vouch for the field either.
    contrast.throws = true;
    expect(brandFrom(withBrand({ primary: '#222220', accent: '#B87333' })).brand).toMatchObject({ field: 'var(--bg-panel)', ink: 'var(--text-primary)', inkSecondary: 'var(--text-secondary)' });
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
    expect(brandFrom(desk).ownerName).toBe('Mike Turner');
    expect(brandFrom({ ...desk, owner_display_name: 'Linda Chen', business_name: 'Chen & Co. CPA' })).toMatchObject({
      ownerName: 'Linda Chen',
      brand: { name: 'Chen & Co. CPA', monogram: 'C' },
    });
  });

  it('no_owner_name_when_setup_gave_its_fallback', () => {
    // Exactly setup's fallback is no name: the page asks for "a person", never for "Owner".
    expect(brandFrom({ ...desk, owner_display_name: OWNER_NAME_FALLBACK }).ownerName).toBeNull();
    // Anything else is a name the owner gave, shown as written.
    for (const name of ['owner', 'OWNER', 'Owner ', ' Owner', 'Owners', 'Mike Owner', 'Owner Turner']) {
      expect(brandFrom({ ...desk, owner_display_name: name }).ownerName, name).toBe(name);
    }
  });

  it('the_no_name_value_is_setups_fallback', () => {
    // Setup gives a Desk whose owner gave no name this one value (`OWNER_NAME_FALLBACK` in setup.py),
    // and the page reads exactly that value as "no name": the two have to stay the same.
    const setup = readFileSync(SETUP_PATH, 'utf8');
    const fallback = /^OWNER_NAME_FALLBACK = "([^"]*)"$/m.exec(setup)?.[1];
    expect(fallback, 'setup.py sets OWNER_NAME_FALLBACK to a plain string').toBeDefined();
    expect(OWNER_NAME_FALLBACK).toBe(fallback);
  });
});
