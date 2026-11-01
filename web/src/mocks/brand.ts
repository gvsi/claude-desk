import { paletteBrand, paletteKey } from '../public/palette.ts';

/** The kernel's effective read: empty storage defaults to teal; legacy colors stay as stored. */
export function effectiveBrand(stored: Record<string, string> = {}): Record<string, string> {
  const palette = paletteKey(stored);
  if (palette !== null) return paletteBrand(palette);
  return Object.keys(stored).length === 0 || 'palette' in stored ? paletteBrand('teal') : { ...stored };
}
