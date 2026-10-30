// @vitest-environment node
// The mark's generator (gen-mark.mjs): the favicon is the mark's source drawing, the geometry `Mark`
// draws is generated from it, and the mark's tokens are its colors, so the three can't drift.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import tokens from '../src/ds/tokens.json' with { type: 'json' };
import { buildMarkGeometry, readMark } from './gen-mark.mjs';

const FAVICON = readFileSync(fileURLToPath(new URL('../public/favicon.svg', import.meta.url)), 'utf8');
const GEOMETRY = fileURLToPath(new URL('../src/ds/components/Mark/markGeometry.ts', import.meta.url));

/** A color token's value. */
function color(name) {
  return tokens.color.tokens.find((token) => token.name === name)?.value.dark;
}

describe('the mark', () => {
  it('geometry_is_generated_from_the_favicon', () => {
    expect(buildMarkGeometry(FAVICON)).toBe(readFileSync(GEOMETRY, 'utf8'));
  });

  it('reads_the_tile_the_clay_and_the_ink', () => {
    const { geometry } = readMark(FAVICON);
    expect(geometry.viewBox).toBe('0 0 100 100');
    expect(geometry.tile).toEqual({ x: 0.5, y: 0.5, width: 99, height: 99, rx: 22 });
    expect(geometry.art).toBe('translate(3 3) scale(0.94)');
    // One clay blob for the dome; six ink strokes (the dome's outline, the knob, the counter line,
    // the reflection and two sound waves), each with a round dot at both ends.
    expect(geometry.clay).toHaveLength(1);
    expect(geometry.ink.filter((shape) => 'd' in shape)).toHaveLength(6);
    expect(geometry.ink.filter((shape) => 'r' in shape)).toHaveLength(12);
    // The paths are the drawing's own, character for character.
    expect(FAVICON).toContain(`<path d="${geometry.clay[0]}"/>`);
    for (const shape of geometry.ink) {
      expect(FAVICON).toContain('d' in shape ? `<path d="${shape.d}"/>` : `<circle cx="${shape.cx}" cy="${shape.cy}" r="${shape.r}"/>`);
    }
  });

  it('mark_tokens_are_the_favicons_colors', () => {
    expect(readMark(FAVICON).colors).toEqual({ tile: '#ffffff', clay: '#d97757', ink: '#141413', hairline: 'rgba(20,20,19,0.1)' });
    expect({
      tile: color('mark-tile'),
      clay: color('mark-clay'),
      ink: color('mark-ink'),
      hairline: color('mark-hairline'),
    }).toEqual(readMark(FAVICON).colors);
  });

  it('the_page_icon_is_the_mark', () => {
    // The browser tab shows the mark: index.html links the favicon, served from public/ as is.
    const index = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
    const icons = [...index.matchAll(/<link\b[^>]*\brel="icon"[^>]*>/g)].map(([tag]) => tag);
    expect(icons).toEqual(['<link rel="icon" type="image/svg+xml" href="/favicon.svg" />']);
  });

  it('refuses_a_drawing_it_does_not_know', () => {
    // Anything but the tile, the clay and the ink fails instead of being dropped or passed through.
    expect(() => readMark(FAVICON.replace('</svg>', '<script>alert(1)</script></svg>'))).toThrow(/script/);
    expect(() => readMark(FAVICON.replace('<g fill="#D97757">', '<g fill="#D97757" opacity="0.5">'))).toThrow(/opacity/);
    expect(() => readMark(FAVICON.replace(/<g fill="#D97757">.*?<\/g>/, ''))).toThrow(/clay/);
    expect(() => readMark(FAVICON.replace('d="M23.2', 'd="M23.2;}'))).toThrow(/path/);
    expect(() => readMark(FAVICON.replace('r="1.9"', 'r="big"'))).toThrow(/circle/);
  });
});
