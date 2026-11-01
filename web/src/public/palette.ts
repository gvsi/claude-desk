import type { BrandPalette } from '../api/contracts.ts';

// These hex values mirror the kernel's BRAND_PALETTE. Keep colors in this shared table,
// so swatches, previews and mock reads use the same fields and accents.
export const BRAND_PALETTE = {
  none: {},
  teal: { primary: '#1F4E4A', accent: '#B87333' },
  clay: { primary: '#773624', accent: '#D97757' },
  navy: { primary: '#1F3A5C', accent: '#C9A24B' },
  forest: { primary: '#28452B', accent: '#B5A05E' },
  plum: { primary: '#4A2D4D', accent: '#C98FA3' },
  rust: { primary: '#6B2F22', accent: '#D9A578' },
  slate: { primary: '#33383F', accent: '#8FA4B8' },
} as const satisfies Record<BrandPalette, { primary?: string; accent?: string }>;

export const PALETTE_NAMES = {
  none: 'No colour', teal: 'Teal', clay: 'Clay', navy: 'Navy',
  forest: 'Forest', plum: 'Plum', rust: 'Rust', slate: 'Slate',
} as const satisfies Record<BrandPalette, string>;

export const PALETTE_KEYS = Object.keys(BRAND_PALETTE) as BrandPalette[];

/** A legacy free-form brand has no selected swatch. */
export function paletteKey(brand: Record<string, string> | undefined): BrandPalette | null {
  const key = brand?.palette;
  return key !== undefined && Object.hasOwn(BRAND_PALETTE, key) ? key as BrandPalette : null;
}

export function paletteBrand(palette: BrandPalette): Record<string, string> {
  return { palette, ...BRAND_PALETTE[palette] };
}
