import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { buildTokensCss, type DesignTokens, type TypeStyle } from '../../scripts/build-tokens.mjs';
import { CONTRAST_PAIRS, DECORATIVE_COLORS, contrastRatio, pairContrast, tokenHex } from './contrast';
import tokens from './tokens.json' with { type: 'json' };

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const HEX = /^#[0-9a-f]{6}$/;
const NUMBER = String.raw`\s*\d+(?:\.\d+)?\s*`;
const RGBA = new RegExp(`^rgba\\(${NUMBER},${NUMBER},${NUMBER},${NUMBER}\\)$`);
const ALIAS = /^\{([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\}$/;

const LIST_FAMILIES = ['color', 'spacing', 'radius', 'size', 'shadow', 'motion'] as const;

const colorNames = tokens.color.tokens.map((t) => t.name);

/** "fg on ground over a under b at 60%", for a pair or a required pair. */
function label(pair: { fg: string; ground: string; over?: string; under?: string; opacity?: number }): string {
  const over = pair.over ? ` over ${pair.over}` : '';
  const under = pair.under ? ` over ${pair.under}` : '';
  const faded = pair.opacity === undefined ? '' : ` at ${Math.round(pair.opacity * 100)}%`;
  return `${pair.fg} on ${pair.ground}${over}${under}${faded}`;
}

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

/** Color tokens that alias a `mark-*` color or clay, as "name: value". */
function aliasesOfTheMarkOrClay(colors: readonly { name: string; value: { dark: string } }[]): string[] {
  return colors
    .filter((token) => {
      const target = ALIAS.exec(token.value.dark)?.[1];
      return target !== undefined && (target.startsWith('mark-') || target === 'clay' || target.startsWith('clay-'));
    })
    .map((token) => `${token.name}: ${token.value.dark}`);
}

/** The tokens with one more interface type style, for the builder's checks. */
function withStyle(style: TypeStyle): DesignTokens {
  const copy: DesignTokens = structuredClone(tokens);
  copy.type.groups.find((group) => group.name === 'Interface')?.styles.push(style);
  return copy;
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
    // So does Claude's line on the illustration's reply card.
    const reply = voice?.styles.find((style) => style.name === 'illustration-reply');
    expect(reply).toMatchObject({ fontSize: '16px', lineHeight: '24px', fontWeight: 380, opticalSize: 20 });
    expect(reply).not.toHaveProperty('letterSpacing');
  });

  test('mark_tokens_match_the_signed_mark', () => {
    // The mark's fixed colors, the same in every theme: its white tile and the tile's hairline edge,
    // the clay of the bell's dome, the drawing's dark ink, and the light ink the bell is drawn in on
    // the dark grounds, where it has no tile. They are the drawing's and the tab icon's own colors
    // (scripts/gen-mark.test.mjs), and nothing but the mark uses them (guards.test.ts).
    const expected = {
      'mark-tile': '#ffffff',
      'mark-clay': '#d97757',
      'mark-ink': '#141413',
      'mark-ink-light': '#faf9f5',
      'mark-hairline': 'rgba(20,20,19,0.1)',
    };
    const actual = Object.fromEntries(Object.keys(expected).map((name) => [name, tokenValue(name)]));
    expect(actual).toEqual(expected);
    expect(colorNames.filter((name) => name.startsWith('mark-')).sort()).toEqual(Object.keys(expected).sort());
    // The hairline only edges the tile on a light ground; the tile itself carries the contrast.
    expect(DECORATIVE_COLORS['mark-hairline']).toBeDefined();
  });

  test('mark_and_clay_are_never_aliased', () => {
    // An alias would carry the mark's colors, or clay, out of their components under another name.
    const sample = [
      { name: 'odd-tile', value: { dark: '{mark-tile}' } },
      { name: 'odd-field', value: { dark: '{clay}' } },
      { name: 'odd-soft', value: { dark: '{clay-soft}' } },
      { name: 'fine', value: { dark: '{bg-app}' } },
    ];
    expect(aliasesOfTheMarkOrClay(sample)).toEqual(['odd-tile: {mark-tile}', 'odd-field: {clay}', 'odd-soft: {clay-soft}']);
    expect(aliasesOfTheMarkOrClay(tokens.color.tokens)).toEqual([]);
  });

  test('figure_tokens_match_the_today_board', () => {
    // Today's "Last 7 days" draws two figures at two sizes (N-Today-Run1): the booked total, and
    // the smaller stopped count. Both are interface type with tabular figures.
    const ui = tokens.type.groups.find((group) => group.name === 'Interface');
    expect(ui?.family).toBe('sans');
    const figure = ui?.styles.find((style) => style.name === 'figure');
    const small = ui?.styles.find((style) => style.name === 'figure-small');
    expect(figure).toMatchObject({ fontSize: '32px', lineHeight: '40px', fontWeight: 500, letterSpacing: '-0.3px', fontVariantNumeric: 'tabular-nums' });
    expect(small).toMatchObject({ fontSize: '24px', lineHeight: '32px', fontWeight: 420, fontVariantNumeric: 'tabular-nums' });
    expect(small).not.toHaveProperty('letterSpacing');
    for (const style of [figure, small]) expect(style?.usage.trim().length, style?.name).toBeGreaterThan(0);

    // The generated classes carry the tabular figures; the checkout's amount stays as it was.
    const css = buildTokensCss(tokens);
    const rule = (name: string) => new RegExp(`\\.cd-type-${name} \\{[^}]*\\}`).exec(css)?.[0] ?? '';
    expect(rule('figure')).toContain('font-variant-numeric: tabular-nums;');
    expect(rule('figure-small')).toContain('font-variant-numeric: tabular-nums;');
    expect(rule('amount')).not.toContain('font-variant-numeric');
    // Only tabular figures: anything else, or anything that would write more CSS, is refused.
    const odd = { name: 'odd', fontSize: '24px', lineHeight: '32px', fontWeight: 420, usage: 'A test style.' };
    for (const fontVariantNumeric of ['oldstyle-nums', 'tabular-nums; color: red']) {
      expect(() => buildTokensCss(withStyle({ ...odd, fontVariantNumeric }))).toThrow(/fontVariantNumeric/);
    }
    expect(buildTokensCss(withStyle({ ...odd, fontVariantNumeric: 'tabular-nums' }))).toContain('.cd-type-odd {');
  });

  test('badge_caps_is_the_one_all_caps_style', () => {
    // The lockup's "Preview" badge: the product's one all-caps label (owner, 2026-10-30), small,
    // weight 520 and slightly spaced (0.06em at 11 px), as N-Explore-Mark-Lockup-Inline draws it, its
    // capitals drawn by its type style over a word written in sentence case. "Beta" is gone.
    const ui = tokens.type.groups.find((group) => group.name === 'Interface');
    const badge = ui?.styles.find((style) => style.name === 'badge-caps');
    expect(badge).toMatchObject({ fontSize: '11px', lineHeight: '14px', fontWeight: 520, letterSpacing: '0.66px', textTransform: 'uppercase' });
    expect(ui?.styles.find((style) => style.name === 'beta')).toBeUndefined();
    // No other style draws capitals.
    const allStyles = tokens.type.groups.flatMap((group) => group.styles as TypeStyle[]);
    expect(allStyles.filter((style) => style.textTransform !== undefined).map((style) => style.name)).toEqual(['badge-caps']);
    const css = buildTokensCss(tokens);
    expect(new RegExp(String.raw`\.cd-type-badge-caps \{[^}]*\}`).exec(css)?.[0]).toContain('text-transform: uppercase;');
    expect(css.match(/text-transform/g)).toHaveLength(1);
    // The builder writes only `uppercase`, and only for the badge's style: another transform, more CSS,
    // or capitals on any other style is refused.
    const odd = { name: 'odd', fontSize: '11px', lineHeight: '14px', fontWeight: 460, usage: 'A test style.' };
    for (const textTransform of ['capitalize', 'lowercase', 'uppercase; color: red']) {
      expect(() => buildTokensCss(withStyle({ ...odd, name: 'badge-caps', textTransform }))).toThrow(/textTransform/);
    }
    expect(() => buildTokensCss(withStyle({ ...odd, textTransform: 'uppercase' }))).toThrow(/textTransform/);
  });

  test('reading_page_tokens_match_the_design_ask', () => {
    // The two About this prototype reading pages: their reading text in serif (the named exception),
    // their headings and captions in the interface's sans, and a phone size of the body and heading.
    const reading = tokens.type.groups.find((group) => group.name === 'Reading pages');
    expect(reading?.family).toBe('serif');
    const styles = Object.fromEntries((reading?.styles ?? []).map((style) => [style.name, style]));
    expect(Object.keys(styles)).toEqual([
      'article-title',
      'article-body',
      'article-body-phone',
      'article-heading',
      'article-heading-phone',
      'article-quote',
      'article-caption',
    ]);
    const spec = (name: string) => {
      const { usage, ...rest } = styles[name] ?? {};
      expect(usage?.trim().length, `${name} usage`).toBeGreaterThan(0);
      return rest;
    };
    expect(spec('article-title')).toEqual({ name: 'article-title', fontSize: '72px', lineHeight: '78px', fontWeight: 300 });
    expect(spec('article-body')).toEqual({ name: 'article-body', fontSize: '18px', lineHeight: '30px', fontWeight: 380 });
    expect(spec('article-body-phone')).toEqual({ name: 'article-body-phone', fontSize: '17px', lineHeight: '28px', fontWeight: 380 });
    expect(spec('article-heading')).toEqual({ name: 'article-heading', family: 'sans', fontSize: '30px', lineHeight: '36px', fontWeight: 620 });
    expect(spec('article-heading-phone')).toEqual({
      name: 'article-heading-phone',
      family: 'sans',
      fontSize: '25px',
      lineHeight: '31px',
      fontWeight: 620,
    });
    expect(spec('article-quote')).toEqual({ name: 'article-quote', fontSize: '32px', lineHeight: '42px', fontWeight: 300, fontStyle: 'italic' });
    expect(spec('article-caption')).toEqual({ name: 'article-caption', family: 'sans', fontSize: '13px', lineHeight: '19px', fontWeight: 380 });
    // Today's number styles keep their names; the reading page's caption is not a figure style.
    expect(tokens.type.groups.flatMap((group) => group.styles.map((style) => style.name)).filter((name) => name.startsWith('figure'))).toEqual([
      'figure',
      'figure-small',
    ]);

    // The text column and the column beside it.
    expect(tokenValue('size-article-measure')).toBe('648px');
    expect(tokenValue('size-article-side')).toBe('200px');

    // The generated classes: each family as set, and italic only on the quote.
    const css = buildTokensCss(tokens);
    const rule = (name: string) => new RegExp(`\\.cd-type-${name} \\{[^}]*\\}`).exec(css)?.[0] ?? '';
    expect(rule('article-body')).toContain('font-family: var(--font-serif);');
    expect(rule('article-heading')).toContain('font-family: var(--font-sans);');
    expect(rule('article-caption')).toContain('font-family: var(--font-sans);');
    expect(rule('article-quote')).toContain('font-style: italic;');
    expect(css.match(/font-style:/g)).toHaveLength(1);
    // Only italic: anything else, or anything that would write more CSS, is refused.
    const odd = { name: 'odd', fontSize: '24px', lineHeight: '32px', fontWeight: 420, usage: 'A test style.' };
    for (const fontStyle of ['oblique', 'normal', 'italic; color: red']) {
      expect(() => buildTokensCss(withStyle({ ...odd, fontStyle }))).toThrow(/fontStyle/);
    }
    expect(buildTokensCss(withStyle({ ...odd, fontStyle: 'italic' }))).toContain('font-style: italic;');
  });

  test('danger_buttons_are_the_refused_rose', () => {
    // The deny answers: a soft fill of the refused status color, and a lighter rose for their words.
    expect(tokenValue('button-danger-text')).toBe('#eba3ae');
    expect(tokenValue('button-danger-fill')).toBe('rgba(220,130,144,0.16)');
    expect(tokenValue('button-danger-fill-hover')).toBe('rgba(220,130,144,0.24)');
    const refused = tokenValue('status-refused') ?? '';
    const rgb = [1, 3, 5].map((i) => parseInt(refused.slice(i, i + 2), 16)).join(',');
    for (const name of ['button-danger-fill', 'button-danger-fill-hover']) {
      expect(tokenValue(name), `${name} is status-refused (${refused}) at an alpha`).toMatch(new RegExp(`^rgba\\(${rgb},0\\.\\d+\\)$`));
    }
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

    type Required = { fg: string; ground: string; over?: string; under?: string; opacity?: number; min: 4.5 | 3 };
    const required: Required[] = [];
    const add = (fgs: string[], grounds: string[], min: 4.5 | 3, over?: string, under?: string, opacity?: number) => {
      for (const fg of fgs) for (const ground of grounds) required.push({ fg, ground, over, under, opacity, min });
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
    // The mark without its tile: its light ink and clay dome on the app, the sidebar and the phone
    // top bar, and the intro dialog's surface; its dark ink on the intro illustration's light card.
    add(['mark-ink-light', 'mark-clay'], ['bg-app', 'bg-panel', 'bg-surface'], 3);
    add(['mark-ink'], ['illustration-card'], 3);
    // The mark with its tile: the tile on the app, as the design system's stories show it, and its
    // drawing on the tile, the ink where it crosses the clay dome included.
    add(['mark-tile'], ['bg-app'], 3);
    add(['mark-ink', 'mark-clay'], ['mark-tile'], 3);
    add(['mark-ink'], ['mark-clay'], 3);
    // Claude's writing dots carry the waiting status on the page and in the Ask Claude panel;
    // the About pages' app icon has its clay field, the icon's edge, on the page too.
    add(['clay'], ['bg-app', 'bg-panel'], 3);
    // The switch: its track when on, its knob on the track, on or off.
    add(['button-primary'], ['bg-app', 'bg-panel'], 3);
    add(['bg-app'], ['button-primary'], 3);
    add(['text-secondary'], ['fill-secondary'], 3, 'bg-panel');
    // The switch row's label and description while it is hovered in the sidebar.
    add(['text-primary', 'text-secondary'], ['fill-hover'], 4.5, 'bg-panel');
    // The first-visit intro dialog: the passcode in its field.
    add(['text-primary'], ['fill-card'], 4.5, 'bg-surface');
    // The intro illustration's light cards: their text, the initials, the check and receipt dots.
    add(['illustration-ink', 'illustration-ink-secondary'], ['illustration-card'], 4.5);
    add(['illustration-ink'], ['illustration-avatar'], 4.5);
    add(['illustration-handled'], ['illustration-card'], 3);
    // The owner's words in a bubble in the Ask Claude panel, on the panel ground.
    add(['text-primary'], ['fill-bubble'], 4.5, 'bg-panel');
    // An agent's signed limit in the "Send an agent" card: its words on its own fill over the card's.
    add(['text-primary', 'text-secondary'], ['fill-card'], 4.5, 'fill-card', 'bg-app');
    // A text field's outline is its boundary, so it needs 3:1 on every ground a field sits on.
    add(['line-field'], ['bg-surface', 'bg-app'], 3);
    // The outlined value of an inline CopyField, in a card on the agents page.
    add(['line-field'], ['fill-card'], 3, 'bg-app');
    // The deny answers in a held request's card: danger at rest and on hover, then danger-ghost,
    // whose ground is the card itself, at rest and on hover.
    add(['button-danger-text'], ['button-danger-fill', 'button-danger-fill-hover'], 4.5, 'fill-card', 'bg-app');
    add(['button-danger-text'], ['fill-card'], 4.5, 'bg-app');
    add(['button-danger-text'], ['fill-hover'], 4.5, 'fill-card', 'bg-app');
    // The same buttons straight on the app background.
    add(['button-danger-text'], ['bg-app'], 4.5);
    add(['button-danger-text'], ['button-danger-fill', 'button-danger-fill-hover', 'fill-hover'], 4.5, 'bg-app');
    // Every answer while it is sent, in its card: a busy danger answer on its hover fill or the
    // hover ground (listed above), a busy secondary answer's text-secondary label on its fill.
    add(['text-secondary'], ['fill-secondary'], 4.5, 'fill-card', 'bg-app');
    // A busy button: a secondary one's label in text-secondary on its fill, on a page and in a
    // dialog; a ghost one's on the ground under it; the primary's label on its hover fill.
    add(['text-secondary'], ['fill-secondary'], 4.5, 'bg-app');
    add(['text-secondary'], ['fill-secondary'], 4.5, 'bg-surface');
    add(['text-secondary'], ['bg-app', 'bg-panel', 'bg-surface', 'bg-muted'], 4.5);
    add(['button-primary-text'], ['button-primary-hover'], 4.5);
    // Deny's menu on a held request: its answers in red words on the raised surface, at rest and
    // while one is hovered or has focus.
    add(['button-danger-text'], ['bg-surface'], 4.5);
    add(['button-danger-text'], ['fill-hover'], 4.5, 'bg-surface');
    // A busy button's spinner, a graphic (3:1) in its busy label color, on every ground its busy pair
    // is listed for: the primary's on its own fill, a secondary's on its fill on a page, a dialog and
    // a card, a ghost's on the page, the sidebar, a dialog, the reviewer bar and a card, and the red
    // answers' on their busy grounds on a page and in a card (danger-ghost in a dialog too).
    add(['button-primary-text'], ['button-primary-hover'], 3);
    for (const over of ['bg-app', 'bg-surface']) add(['text-secondary'], ['fill-secondary'], 3, over);
    add(['text-secondary'], ['fill-secondary'], 3, 'fill-card', 'bg-app');
    add(['text-secondary'], ['bg-app', 'bg-panel', 'bg-surface', 'bg-muted'], 3);
    add(['text-secondary'], ['fill-card'], 3, 'bg-app');
    add(['button-danger-text'], ['button-danger-fill-hover', 'fill-hover'], 3, 'bg-app');
    add(['button-danger-text'], ['button-danger-fill-hover', 'fill-hover'], 3, 'fill-card', 'bg-app');
    add(['button-danger-text'], ['fill-hover'], 3, 'bg-surface');

    // Every required pair is listed, at no lower a minimum, so dropping one can't pass.
    for (const want of required) {
      const listed = CONTRAST_PAIRS.find(
        (p) =>
          p.fg === want.fg && p.ground === want.ground && p.over === want.over && p.under === want.under && p.opacity === want.opacity,
      );
      expect(listed, label(want)).toBeDefined();
      expect(listed?.min).toBeGreaterThanOrEqual(want.min);
    }

    for (const pair of CONTRAST_PAIRS) {
      expect(pair.use.trim().length, `${label(pair)} says where it is used`).toBeGreaterThan(0);
      expect(pairContrast(pair), label(pair)).toBeGreaterThanOrEqual(pair.min);
    }
  });

  test('contrast_composites_layers_and_opacity', () => {
    // A translucent ground over a translucent card over the app equals the same ground over the
    // card's opaque composite, worked out by hand.
    const cardOverApp = 'rgb(34.66,33.66,31.6)'; // fill-card (rgba(250,249,245,0.03)) over #1c1b19
    expect(pairContrast({ fg: 'text-primary', ground: 'fill-secondary', over: 'fill-card', under: 'bg-app' })).toBeCloseTo(
      contrastRatio('text-primary', 'fill-secondary', cardOverApp),
      6,
    );
    expect(contrastRatio('text-primary', 'fill-secondary', 'fill-card', 'bg-app')).toBeCloseTo(
      contrastRatio('text-primary', 'fill-secondary', cardOverApp),
      6,
    );
    // A control drawn at half opacity: black on white over white reads as mid gray on white.
    expect(pairContrast({ fg: '#000000', ground: '#ffffff', over: '#ffffff', opacity: 0.5 })).toBeCloseTo(
      contrastRatio('rgba(0,0,0,0.5)', '#ffffff'),
      6,
    );
    // A control with an opaque fill on a different ground, at half opacity: the label and the
    // fill fade together, so the label sits over only what's beneath, once. Black on a white
    // button over black reads as black on mid gray.
    expect(pairContrast({ fg: '#000000', ground: '#ffffff', over: '#000000', opacity: 0.5 })).toBeCloseTo(
      contrastRatio('#000000', 'rgba(255,255,255,0.5)', '#000000'),
      6,
    );
    // A ghost control has no fill of its own: only its label fades.
    expect(pairContrast({ fg: '#000000', ground: 'transparent', over: '#ffffff', opacity: 0.5 })).toBeCloseTo(
      contrastRatio('rgba(0,0,0,0.5)', '#ffffff'),
      6,
    );
    // Faded or not, the layers under a control must end on something opaque.
    expect(() => pairContrast({ fg: 'text-primary', ground: 'fill-secondary', over: 'fill-card' })).toThrow(/translucent/);
    expect(() => pairContrast({ fg: 'text-primary', ground: 'fill-secondary', under: 'bg-app' })).toThrow(/under/);
    expect(() => pairContrast({ fg: 'text-primary', ground: 'bg-app', opacity: 0.6 })).toThrow(/opacity/);
    expect(() => pairContrast({ fg: 'text-primary', ground: 'bg-app', over: 'bg-app', opacity: 0 })).toThrow(/opacity/);
  });

  test('connector_tokens_are_decorative', () => {
    // Each third-party connector's mark, with no tile behind it: Stripe's in white on the dark grounds,
    // as Stripe's guidelines allow, and Google Calendar's in its own blue. Nothing is read on them.
    const expected = {
      'connector-stripe': '#ffffff',
      'connector-google-blue': '#4285f4',
      'size-side-panel': '400px',
    };
    const actual = Object.fromEntries(Object.keys(expected).map((name) => [name, tokenValue(name)]));
    expect(actual).toEqual(expected);

    const connectorColors = colorNames.filter((name) => name.startsWith('connector-'));
    expect(connectorColors.sort()).toEqual(['connector-google-blue', 'connector-stripe']);
    for (const name of connectorColors) {
      expect(DECORATIVE_COLORS[name], `${name} is decorative`).toBe("A third-party brand mark beside its name; nothing is read on it.");
    }
    // None of them is a ground or a color in a contrast pair: nothing is read on them.
    const paired = new Set(CONTRAST_PAIRS.flatMap((p) => [p.fg, p.ground, p.over, p.under]));
    expect(connectorColors.filter((name) => paired.has(name))).toEqual([]);
  });

  test('connector_page_measures_are_tokens', () => {
    // The connector pages' measures, read off their signed boards, as tokens the components use.
    const expected = {
      'space-18': '18px',
      'size-connector-title-tile': '44px',
      'size-connection-term': '200px',
      'size-recent-when': '120px',
    };
    const actual = Object.fromEntries(Object.keys(expected).map((name) => [name, tokenValue(name)]));
    expect(actual).toEqual(expected);
    // A connector's quoted definition is mono at 12 px, a size smaller than the full trace's values.
    const mono = tokens.type.groups.find((group) => group.family === 'mono');
    expect(mono?.styles.find((style) => style.name === 'quote')).toMatchObject({ fontSize: '12px', lineHeight: '18px', fontWeight: 400 });
  });

  test('agents_measures_are_tokens', () => {
    // The agents page's one column, 760 px between its gutters, as the signed agents boards draw it.
    expect(tokenValue('size-agents-column')).toBe('760px');
  });

  test('touch_target_is_a_token', () => {
    // The least a finger needs in each dimension on a touch screen. Controls drawn smaller keep
    // their look and reach it with an unseen hit area under a coarse pointer.
    expect(tokenValue('size-touch')).toBe('44px');
  });

  test('qr_tile_tokens_match_the_board', () => {
    // N-Live-REV-QR-B: the QR code on Share's card, its dark modules on a sand tile with an inset hairline.
    expect({ tile: tokenValue('qr-tile'), ink: tokenValue('qr-ink'), hairline: tokenValue('qr-hairline') }).toEqual({
      tile: '#eae6dc',
      ink: '{bg-app}',
      hairline: 'rgba(28,27,25,0.13)',
    });
    // The code reads no CSS, so it takes them as hex, its ink through its alias; a translucent one has none.
    expect([tokenHex('qr-ink'), tokenHex('qr-tile')]).toEqual(['#1c1b19', '#eae6dc']);
    expect(() => tokenHex('qr-hairline')).toThrow();
  });

  test('settings_measures_are_tokens', () => {
    // Settings' section links, 200 px wide beside the content, as the signed Settings boards draw them.
    expect(tokenValue('size-sub-nav')).toBe('200px');
  });

  test('skeleton_band_is_a_token', () => {
    // The one band of light that sweeps a loading page's shapes, 900 px wide, as the signed skeleton
    // boards draw it. Its loop is the writing indicator's, so it adds no motion token.
    expect(tokenValue('size-skeleton-band')).toBe('900px');
    expect(tokens.motion.tokens.map((t) => t.name).filter((name) => name.includes('skeleton'))).toEqual([]);
  });

  test('every_color_token_is_classified', () => {
    expect(Object.keys(DECORATIVE_COLORS).sort()).toEqual([
      'clay',
      'connector-google-blue',
      'connector-stripe',
      'illustration-arc',
      'illustration-line',
      'line-card',
      'line-control',
      'line-control-hover',
      'line-hairline',
      'mark-hairline',
      'qr-hairline',
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

  test('word_settle_is_a_token', () => {
    // Each new word of Claude's reply settles in over 150 ms as it streams or is revealed, as the
    // signed Markdown and streaming boards draw it.
    expect(tokenValue('motion-settle')).toBe('150ms');
  });

  test('motion_stays_in_range', () => {
    const loops = ['motion-breathe', 'motion-writing', 'motion-dots', 'motion-spin'];
    const easings = ['motion-ease', 'motion-ease-emphasis', 'motion-ease-bounce'];
    const names = tokens.motion.tokens.map((t) => t.name);
    for (const name of [...loops, ...easings]) expect(names).toContain(name);
    expect(tokenValue('motion-dots')).toBe('1200ms');
    expect(tokenValue('motion-ease-bounce')).toBe('cubic-bezier(0.37, 0, 0.63, 1)');

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
