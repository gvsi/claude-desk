import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { buildTokensCss } from '../../scripts/build-tokens.mjs';
import { CONTRAST_PAIRS, DECORATIVE_COLORS, contrastRatio } from './contrast';
import tokens from './tokens.json' with { type: 'json' };

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const HEX = /^#[0-9a-f]{6}$/;
const NUMBER = String.raw`\s*\d+(?:\.\d+)?\s*`;
const RGBA = new RegExp(`^rgba\\(${NUMBER},${NUMBER},${NUMBER},${NUMBER}\\)$`);
const ALIAS = /^\{([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\}$/;

const LIST_FAMILIES = ['color', 'spacing', 'radius', 'size', 'shadow', 'motion'] as const;

const colorNames = tokens.color.tokens.map((t) => t.name);

function tokenValue(name: string): string | undefined {
  const color = tokens.color.tokens.find((t) => t.name === name);
  if (color) return color.value.dark;
  for (const family of LIST_FAMILIES) {
    if (family === 'color') continue;
    const entry = tokens[family].tokens.find((t) => t.name === name);
    if (entry) return entry.value;
  }
  return undefined;
}

describe('design tokens', () => {
  test('tokens_css_is_generated_from_tokens_json', () => {
    const committed = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'tokens.css'), 'utf8');
    expect(buildTokensCss(tokens)).toBe(committed);
  });

  test('core_values_match_design_system_v2', () => {
    const expected = {
      'bg-app': '#1c1b19',
      'bg-panel': '#222220',
      'bg-surface': '#2a2927',
      'bg-selected': '#3c392f',
      'accent-blue': '#7eaeda',
      'status-handled': '#6fa859',
      'status-held': '#dabe4a',
      'status-refused': '#dc8290',
      clay: '#e08968',
      'radius-control': '8px',
      'radius-card': '12px',
      'radius-composer': '16px',
    };
    const actual = Object.fromEntries(Object.keys(expected).map((name) => [name, tokenValue(name)]));
    expect(actual).toEqual(expected);
  });

  test('intro_dialog_tokens_match_the_board', () => {
    const expected = {
      scrim: 'rgba(0,0,0,0.5)',
      'illustration-card': '#faf9f5',
      'illustration-ink': '{bg-app}',
      'illustration-ink-secondary': 'rgba(28,27,25,0.66)',
      'illustration-avatar': '#e6e0d4',
      'illustration-line': 'rgba(28,27,25,0.14)',
      'illustration-handled': '#3f7a2e',
      'illustration-arc': 'rgba(250,249,245,0.12)',
      'shadow-dialog': '0 4px 8px rgba(11,11,11,0.08), 0 12px 28px -2px rgba(0,0,0,0.24)',
      'shadow-illustration-card': '0 1px 2px rgba(28,27,25,0.16)',
      'size-intro': '880px',
      'size-intro-illustration': '400px',
    };
    const actual = Object.fromEntries(Object.keys(expected).map((name) => [name, tokenValue(name)]));
    expect(actual).toEqual(expected);

    // The dialog's title speaks in Claude's voice.
    const voice = tokens.type.groups.find((group) => group.name === "Claude's voice");
    const title = voice?.styles.find((style) => style.name === 'intro-title');
    expect(voice?.family).toBe('serif');
    expect(title).toMatchObject({
      fontSize: '28px',
      lineHeight: '35px',
      fontWeight: 460,
      letterSpacing: '-0.2px',
      opticalSize: 28,
    });
  });

  test('one_dark_theme_only', () => {
    expect(tokens.color.themes).toEqual([{ id: 'dark', name: 'Dark' }]);
    for (const token of tokens.color.tokens) {
      expect(Object.keys(token.value), token.name).toEqual(['dark']);
      expect(typeof token.value.dark, token.name).toBe('string');
    }
    for (const token of tokens.shadow.tokens) {
      expect(typeof token.value, `${token.name} has no per-theme values`).toBe('string');
    }
  });

  test('names_are_valid_and_unique', () => {
    const listNames = LIST_FAMILIES.flatMap((family) => tokens[family].tokens.map((t) => t.name));
    const styleNames = tokens.type.groups.flatMap((g) => g.styles.map((s) => s.name));

    for (const name of [...listNames, ...styleNames]) expect(name).toMatch(NAME);
    const repeated = (names: string[]) => names.filter((n, i) => names.indexOf(n) !== i);
    expect(repeated(listNames), 'names shared across families').toEqual([]);
    expect(repeated(styleNames), 'type style names').toEqual([]);

    for (const token of tokens.color.tokens) {
      const value = token.value.dark;
      const alias = ALIAS.exec(value);
      if (alias) {
        expect(alias[1], `${token.name} aliases an existing color`).not.toBe(token.name);
        expect(colorNames, `${token.name} aliases an existing color`).toContain(alias[1]);
      } else {
        expect(HEX.test(value) || RGBA.test(value), `${token.name}: ${value}`).toBe(true);
      }
    }

    // Every entry carries the usage sentence the brand book and the artifact show.
    for (const family of LIST_FAMILIES) {
      for (const token of tokens[family].tokens) {
        expect(token.usage.trim().length, `${token.name} usage`).toBeGreaterThan(0);
      }
    }
  });

  test('every_used_pair_meets_contrast', () => {
    // The ratio itself, against known WCAG values, so a broken formula can't pass the pairs.
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('rgba(0,0,0,0.5)', '#ffffff')).toBeCloseTo(contrastRatio('#808080', '#ffffff'), 1);
    expect(contrastRatio('text-primary', 'fill-card', 'bg-app')).toBeGreaterThan(1);
    expect(() => contrastRatio('text-primary', 'fill-card')).toThrow();
    expect(() => contrastRatio('not-a-color', 'bg-app')).toThrow();

    type Required = { fg: string; ground: string; over?: string; min: 4.5 | 3 };
    const required: Required[] = [];
    const add = (fgs: string[], grounds: string[], min: 4.5 | 3, over?: string) => {
      for (const fg of fgs) for (const ground of grounds) required.push({ fg, ground, over, min });
    };
    const text = ['text-primary', 'text-secondary', 'text-tertiary', 'accent-blue'];
    add(text, ['bg-app', 'bg-panel', 'bg-surface', 'bg-muted', 'bg-selected'], 4.5);
    add(text, ['fill-card', 'fill-bubble', 'fill-count', 'fill-hover', 'fill-secondary'], 4.5, 'bg-app');
    add(text, ['fill-secondary', 'fill-hover'], 4.5, 'bg-surface');
    add(['text-primary', 'text-secondary'], ['fill-secondary-hover'], 4.5, 'bg-app');
    add(['text-primary', 'text-secondary'], ['fill-secondary-hover'], 4.5, 'bg-surface');
    add(['button-primary-text'], ['button-primary', 'button-primary-hover'], 4.5);
    const marks = ['accent-blue', 'ring-composer', 'status-handled', 'status-held', 'status-refused', 'status-info'];
    add(marks, ['bg-app', 'bg-panel', 'bg-surface', 'bg-selected'], 3);
    add(marks, ['fill-card'], 3, 'bg-app');
    add(['clay'], ['bg-app', 'bg-panel'], 3);
    // The switch: its track when on, its knob on the track, on or off.
    add(['button-primary'], ['bg-app', 'bg-panel'], 3);
    add(['bg-app'], ['button-primary'], 3);
    add(['text-secondary'], ['fill-secondary'], 3, 'bg-panel');
    // The switch row's label and description while it is hovered in the sidebar.
    add(['text-primary', 'text-secondary'], ['fill-hover'], 4.5, 'bg-panel');
    // The first-visit intro dialog: the mark on its surface and the passcode in its field.
    add(['clay'], ['bg-surface'], 3);
    add(['text-primary'], ['fill-card'], 4.5, 'bg-surface');
    // The intro illustration's light cards: their text, the initials, the check and receipt dots.
    add(['illustration-ink', 'illustration-ink-secondary'], ['illustration-card'], 4.5);
    add(['illustration-ink'], ['illustration-avatar'], 4.5);
    add(['illustration-handled'], ['illustration-card'], 3);
    // A text field's outline is its boundary, so it needs 3:1 on every ground a field sits on.
    add(['line-field'], ['bg-surface', 'bg-app'], 3);

    // Every required pair is listed, at no lower a minimum, so dropping one can't pass.
    for (const want of required) {
      const listed = CONTRAST_PAIRS.find(
        (p) => p.fg === want.fg && p.ground === want.ground && p.over === want.over,
      );
      expect(listed, `${want.fg} on ${want.ground}${want.over ? ` over ${want.over}` : ''}`).toBeDefined();
      expect(listed?.min).toBeGreaterThanOrEqual(want.min);
    }

    for (const pair of CONTRAST_PAIRS) {
      const label = `${pair.fg} on ${pair.ground}${pair.over ? ` over ${pair.over}` : ''}`;
      expect(pair.use.trim().length, `${label} says where it is used`).toBeGreaterThan(0);
      expect(contrastRatio(pair.fg, pair.ground, pair.over), label).toBeGreaterThanOrEqual(pair.min);
    }
  });

  test('every_color_token_is_classified', () => {
    expect(Object.keys(DECORATIVE_COLORS).sort()).toEqual([
      'illustration-arc',
      'illustration-line',
      'line-card',
      'line-control',
      'line-control-hover',
      'line-hairline',
      'scrim',
    ]);
    for (const [name, reason] of Object.entries(DECORATIVE_COLORS)) {
      expect(colorNames, `${name} is a color token`).toContain(name);
      expect(reason.trim().length, `${name} says why no contrast applies`).toBeGreaterThan(0);
    }

    const paired = new Set(CONTRAST_PAIRS.flatMap((p) => [p.fg, p.ground]));
    const unclassified = colorNames.filter((name) => !paired.has(name) && !(name in DECORATIVE_COLORS));
    expect(unclassified).toEqual([]);
  });

  test('motion_stays_in_range', () => {
    const loops = ['motion-breathe', 'motion-writing'];
    const easings = ['motion-ease', 'motion-ease-emphasis'];
    const names = tokens.motion.tokens.map((t) => t.name);
    for (const name of [...loops, ...easings]) expect(names).toContain(name);

    for (const token of tokens.motion.tokens) {
      expect(token.name).toMatch(/^motion-/);
      if (easings.includes(token.name)) {
        expect(token.value, token.name).toMatch(/^(ease-out|cubic-bezier\([\d.,\s]+\))$/);
        continue;
      }
      const duration = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(token.value);
      expect(duration, `${token.name} is a duration: ${token.value}`).not.toBeNull();
      if (!duration || loops.includes(token.name)) continue;
      const ms = Number(duration[1]) * (duration[2] === 's' ? 1000 : 1);
      expect(ms, token.name).toBeGreaterThanOrEqual(60);
      expect(ms, token.name).toBeLessThanOrEqual(200);
    }
  });
});
