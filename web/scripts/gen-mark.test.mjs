// @vitest-environment node
// The mark's generator (gen-mark.mjs): mark.svg is the mark's signed drawing, the geometry `Mark`
// draws and the page's icon are generated from it, and the mark's tokens are its colors, so none of
// them can drift.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import tokens from '../src/ds/tokens.json' with { type: 'json' };
import { LIGHT_INK, buildFavicon, buildMarkGeometry, generatedFiles, readMark } from './gen-mark.mjs';

const DRAWING = readFileSync(fileURLToPath(new URL('../src/ds/components/Mark/mark.svg', import.meta.url)), 'utf8');
const GEOMETRY = fileURLToPath(new URL('../src/ds/components/Mark/markGeometry.ts', import.meta.url));
const FAVICON = fileURLToPath(new URL('../src/ds/components/Mark/favicon.svg', import.meta.url));
const WEB = fileURLToPath(new URL('..', import.meta.url));

/** A color token's value. */
function color(name) {
  return tokens.color.tokens.find((token) => token.name === name)?.value.dark;
}

describe('the mark', () => {
  it('geometry_is_generated_from_the_drawing', () => {
    expect(buildMarkGeometry(DRAWING)).toBe(readFileSync(GEOMETRY, 'utf8'));
  });

  it('reads_the_tile_the_clay_and_the_ink', () => {
    const { geometry } = readMark(DRAWING);
    expect(geometry.viewBox).toBe('0 0 100 100');
    expect(geometry.tile).toEqual({ x: 0.5, y: 0.5, width: 99, height: 99, rx: 22 });
    expect(geometry.art).toBe('translate(3 3) scale(0.94)');
    // One clay blob for the dome; six ink strokes (the dome's outline, the knob, the counter line,
    // the reflection and two sound waves), each with a round dot at both ends.
    expect(geometry.clay).toHaveLength(1);
    expect(geometry.ink.filter((shape) => 'd' in shape)).toHaveLength(6);
    expect(geometry.ink.filter((shape) => 'r' in shape)).toHaveLength(12);
    // The paths are the drawing's own, character for character.
    expect(DRAWING).toContain(`<path d="${geometry.clay[0]}"/>`);
    for (const shape of geometry.ink) {
      expect(DRAWING).toContain('d' in shape ? `<path d="${shape.d}"/>` : `<circle cx="${shape.cx}" cy="${shape.cy}" r="${shape.r}"/>`);
    }
  });

  it('mark_tokens_are_the_drawings_colors', () => {
    expect(readMark(DRAWING).colors).toEqual({ tile: '#ffffff', clay: '#d97757', ink: '#141413', hairline: 'rgba(20,20,19,0.1)' });
    expect({
      tile: color('mark-tile'),
      clay: color('mark-clay'),
      ink: color('mark-ink'),
      hairline: color('mark-hairline'),
    }).toEqual(readMark(DRAWING).colors);
    // Without its tile on a dark ground, the bell is drawn in the light ink in place of the
    // drawing's dark ink (owner, 2026-10-30): the variant is the generator's, and its token matches it.
    expect(LIGHT_INK).toBe('#faf9f5');
    expect(color('mark-ink-light')).toBe(LIGHT_INK);
  });

  it('the_page_icon_is_the_generated_favicon', () => {
    // The browser tab shows the bell: index.html links the icon generated from the drawing, so the
    // build emits it under a hashed name and a redrawn mark never sticks in a browser's cache.
    const index = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
    const icons = [...index.matchAll(/<link\b[^>]*\brel="icon"[^>]*>/g)].map(([tag]) => tag);
    expect(icons).toEqual(['<link rel="icon" type="image/svg+xml" href="/src/ds/components/Mark/favicon.svg" />']);
  });

  it('favicon_is_generated_from_the_drawing', () => {
    expect(buildFavicon(DRAWING)).toBe(readFileSync(FAVICON, 'utf8'));
    // `--check` compares both generated files with what is on disk, and the write mode writes both.
    expect(generatedFiles(DRAWING).map(({ file }) => file)).toEqual([
      'src/ds/components/Mark/markGeometry.ts',
      'src/ds/components/Mark/favicon.svg',
    ]);
    for (const { file, text } of generatedFiles(DRAWING)) {
      expect(readFileSync(`${WEB}/${file}`, 'utf8'), file).toBe(text);
    }
  });

  it('favicon_is_the_bell_without_its_tile_in_the_tab_bars_ink', () => {
    // One icon for both tab bars: the bell with no tile, its ink dark on a light tab bar and light
    // on a dark one, by the browser's color scheme inside the icon itself.
    const favicon = buildFavicon(DRAWING);
    const { geometry, colors } = readMark(DRAWING);
    expect(favicon).not.toMatch(/<rect\b/);
    expect(favicon).toContain(`viewBox="${geometry.viewBox}"`);
    expect(favicon).toContain(`<g transform="${geometry.art}">`);
    expect(favicon).toContain(`<g fill="${colors.clay}"><path d="${geometry.clay[0]}"/></g>`);
    // The ink is the drawing's dark ink by default, so an icon read without its style still shows.
    expect(favicon).toContain(`<g class="ink" fill="${colors.ink}">`);
    expect(favicon).toContain(`<style>@media (prefers-color-scheme: dark) { .ink { fill: ${LIGHT_INK} } }</style>`);
    // Every shape of the drawing's ink, in its order, and nothing else.
    for (const shape of geometry.ink) {
      expect(favicon).toContain('d' in shape ? `<path d="${shape.d}"/>` : `<circle cx="${shape.cx}" cy="${shape.cy}" r="${shape.r}"/>`);
    }
    expect(favicon.match(/<(?:path|circle)\b/g)).toHaveLength(geometry.clay.length + geometry.ink.length);
    // The generator reads the drawing strictly before it writes the icon.
    expect(() => buildFavicon(DRAWING.replace('</svg>', '<script>alert(1)</script></svg>'))).toThrow(/script/);
  });

  it('refuses_a_drawing_it_does_not_know', () => {
    // Anything but the tile, the clay and the ink fails instead of being dropped or passed through.
    expect(() => readMark(DRAWING.replace('</svg>', '<script>alert(1)</script></svg>'))).toThrow(/script/);
    expect(() => readMark(DRAWING.replace('<g fill="#D97757">', '<g fill="#D97757" opacity="0.5">'))).toThrow(/opacity/);
    expect(() => readMark(DRAWING.replace(/<g fill="#D97757">.*?<\/g>/, ''))).toThrow(/clay/);
    expect(() => readMark(DRAWING.replace('d="M23.2', 'd="M23.2;}'))).toThrow(/path/);
    expect(() => readMark(DRAWING.replace('r="1.9"', 'r="big"'))).toThrow(/circle/);
    // A shape is a leaf: a child inside the tile, a path or a circle (an animation, say) fails.
    const clayPath = /(<g fill="#D97757"><path d="[^"]*")\/>/;
    expect(() => readMark(DRAWING.replace(clayPath, '$1><animate attributeName="fill" to="#000000"/></path>'))).toThrow(/children/);
    expect(() => readMark(DRAWING.replace(/(<rect [^>]*)\/>/, '$1><set attributeName="fill" to="#000000"/></rect>'))).toThrow(/children/);
    const firstDot = '<circle cx="27.6" cy="69.5" r="1.9"/>';
    expect(() => readMark(DRAWING.replace(firstDot, firstDot.replace('/>', '><animate attributeName="r" to="40"/></circle>')))).toThrow(/children/);
    // An attribute given twice fails, rather than the last one quietly winning.
    expect(() => readMark(DRAWING.replace('<path d="M12.4 81.2', '<path d="M0 0L100 100Z" d="M12.4 81.2'))).toThrow(/twice/);
    expect(() => readMark(DRAWING.replace('<g fill="#D97757">', '<g fill="#000000" fill="#D97757">'))).toThrow(/twice/);
    // Path data starts with a move; blank data fails.
    expect(() => readMark(DRAWING.replace(/<path d="M35\.4[^"]*"\/>/, '<path d=" "/>'))).toThrow(/path/);
    expect(() => readMark(DRAWING.replace(/<path d="M35\.4[^"]*"\/>/, '<path d=""/>'))).toThrow(/path/);
    expect(() => readMark(DRAWING.replace('d="M23.2', 'd="L23.2'))).toThrow(/path/);
    // The tile has a real size and corner.
    expect(() => readMark(DRAWING.replace('width="99"', 'width="-99"'))).toThrow(/width/);
    expect(() => readMark(DRAWING.replace('height="99"', 'height="0"'))).toThrow(/height/);
    expect(() => readMark(DRAWING.replace('rx="22"', 'rx="0"'))).toThrow(/rx/);
  });
});
