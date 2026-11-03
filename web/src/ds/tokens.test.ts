import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { buildTokensCss, type DesignTokens, type ThemedValues, type TypeStyle } from '../../scripts/build-tokens.mjs';
import {
  CONTRAST_PAIRS,
  DECORATIVE_COLORS,
  LIGHT_THEME_EXEMPTIONS,
  ON_BRAND_COLORS,
  THEMES,
  contrastRatio,
  pairContrast,
  tokenHex,
  type Theme,
} from './contrast';
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

/** A token's value: a color's or a shadow's dark value, or a plain one. */
function tokenValue(name: string): string | undefined {
  const themed = [...tokens.color.tokens, ...tokens.shadow.tokens].find((t) => t.name === name);
  if (themed) return themed.value.dark;
  for (const family of LIST_FAMILIES) {
    if (family === 'color' || family === 'shadow') continue;
    const entry = tokens[family].tokens.find((t) => t.name === name);
    if (entry) return entry.value;
  }
  return undefined;
}

/** Color tokens that alias a `mark-*` color or clay in any theme, as "name: value". */
function aliasesOfTheMarkOrClay(colors: readonly { name: string; value: ThemedValues }[]): string[] {
  return colors.flatMap((token) =>
    Object.values(token.value)
      .filter((value): value is string => {
        const target = value === undefined ? undefined : ALIAS.exec(value)?.[1];
        return target !== undefined && (target.startsWith('mark-') || target === 'clay' || target.startsWith('clay-'));
      })
      .map((value) => `${token.name}: ${value}`),
  );
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

  test('a_light_theme_overrides_only_the_tokens_it_has_values_for', () => {
    // Dark is the base: every token, on :root and on anything marked dark. Light is chosen in this
    // browser (data-theme="light" on the root) or by the system while dark isn't chosen, and sets only
    // the tokens with a light value, with the browser's own scheme. An alias without one (line-focus)
    // resolves against the light values on the same root, and a fixed color (the mark's) stays.
    const usage = 'A test token.';
    const themed: DesignTokens = structuredClone(tokens);
    themed.color = {
      themes: [
        { id: 'dark', name: 'Dark' },
        { id: 'light', name: 'Light' },
      ],
      tokens: [
        { name: 'bg-app', value: { dark: '#1c1b19', light: '#f6f4ee' }, usage },
        { name: 'text-primary', value: { dark: 'rgba(250,249,245,0.92)', light: 'rgba(28,27,25,0.92)' }, usage },
        { name: 'line-focus', value: { dark: '{text-primary}' }, usage },
        { name: 'mark-ink', value: { dark: '#141413' }, usage },
      ],
    };
    themed.shadow = {
      tokens: [{ name: 'shadow-composer', value: { dark: '0 4px 20px rgba(0,0,0,0.25)', light: '0 4px 20px rgba(28,27,25,0.08)' }, usage }],
    };
    const css = buildTokensCss(themed);
    const dark = [
      ':root,',
      '[data-theme="dark"] {',
      '  --bg-app: #1c1b19;',
      '  --text-primary: rgba(250,249,245,0.92);',
      '  --line-focus: var(--text-primary);',
      '  --mark-ink: #141413;',
      '  --shadow-composer: 0 4px 20px rgba(0,0,0,0.25);',
      '}',
    ].join('\n');
    const light = [
      '  color-scheme: light;',
      '  --bg-app: #f6f4ee;',
      '  --text-primary: rgba(28,27,25,0.92);',
      '  --shadow-composer: 0 4px 20px rgba(28,27,25,0.08);',
    ];
    const chosen = [':root[data-theme="light"] {', ...light, '}'].join('\n');
    const system = [
      '@media (prefers-color-scheme: light) {',
      '  :root:not([data-theme="dark"]) {',
      ...light.map((line) => `  ${line}`),
      '  }',
      '}',
    ].join('\n');
    expect(css).toContain(`\n${dark}\n\n${chosen}\n\n${system}\n`);
    // A token without a light value is set once, in the dark block.
    for (const name of ['--line-focus', '--mark-ink']) expect(css.split(`${name}:`), name).toHaveLength(2);

    // Without a light theme, only the dark block, as before.
    const darkOnly: DesignTokens = structuredClone(themed);
    darkOnly.color.themes = [{ id: 'dark', name: 'Dark' }];
    for (const token of [...darkOnly.color.tokens, ...darkOnly.shadow.tokens]) delete token.value.light;
    expect(buildTokensCss(darkOnly)).not.toMatch(/data-theme="light"|prefers-color-scheme|color-scheme/);

    // Every value is checked as the dark one is, and only the two themes are known.
    const broken = (change: (copy: DesignTokens) => void) => {
      const copy: DesignTokens = structuredClone(themed);
      change(copy);
      return () => buildTokensCss(copy);
    };
    expect(broken((copy) => (copy.color.tokens[2]!.value.light = '{no-such-color}'))).toThrow(/line-focus/);
    expect(broken((copy) => (copy.color.tokens[3]!.value.light = 'red'))).toThrow(/mark-ink/);
    expect(broken((copy) => (copy.shadow.tokens[0]!.value.light = '0 0 0 red; color: red'))).toThrow(/shadow-composer/);
    // As tokens.json may hold them: a misspelt theme, or a shadow with no dark value.
    const loose = (values: ThemedValues) => values as unknown as Record<string, string | undefined>;
    expect(broken((copy) => (loose(copy.color.tokens[0]!.value).dim = '#000000'))).toThrow(/bg-app/);
    expect(broken((copy) => delete loose(copy.shadow.tokens[0]!.value).dark)).toThrow(/shadow-composer/);
    expect(broken((copy) => (copy.color.themes = [{ id: 'dark', name: 'Dark' }, { id: 'dim', name: 'Dim' }]))).toThrow(/theme/);
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
      'size-reading': '640px',
      'size-conversation': '768px',
      'radius-control': '8px',
      'radius-card': '12px',
      'radius-composer': '16px',
    };
    const actual = Object.fromEntries(Object.keys(expected).map((name) => [name, tokenValue(name)]));
    expect(actual).toEqual(expected);
  });

  test('focused_field_edges_use_the_control_focus_token_on_every_ground', () => {
    expect(colorNames).not.toContain('line-field-focus');
    for (const ground of ['bg-app', 'bg-surface']) {
      const pair = CONTRAST_PAIRS.find((p) => p.fg === 'line-focus' && p.ground === ground);
      expect(pair).toBeDefined();
      for (const theme of THEMES) expect(pairContrast(pair!, theme)).toBeGreaterThanOrEqual(3);
    }
  });

  test('focus_edge_is_the_secondary_ink', () => {
    // Keyboard focus changes a control's own edge, never the link blue and never a ring outside it
    // (owner, 2026-11-01): line-focus, the secondary ink, which the About pages' paper points at its own.
    // No ring token is left.
    expect(tokenValue('line-focus')).toBe('{text-secondary}');
    expect(colorNames.filter((name) => name.startsWith('ring-'))).toEqual([]);
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
      { name: 'odd-light', value: { dark: '#1c1b19', light: '{mark-ink}' } },
    ];
    expect(aliasesOfTheMarkOrClay(sample)).toEqual([
      'odd-tile: {mark-tile}',
      'odd-field: {clay}',
      'odd-soft: {clay-soft}',
      'odd-light: {mark-ink}',
    ]);
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

  test('light_blocks_hold_exactly_the_listed_tokens', () => {
    // The light theme's values, as the design system set them: warm paper, the dark theme's ink at its
    // alpha steps, an ink primary button, darker steps of the status hues, a darker clay, a lighter
    // scrim and shadows, and Stripe's mark in Stripe's own purple, since its white would vanish on
    // paper. The aliases (line-focus, button-primary-text, status-info) follow the
    // light values by themselves; the mark, Google Calendar's blue, the illustration's other inks, the
    // QR tile and its hairline, and the inks on an owner's colour are the same in both themes. The
    // illustration's ink and the QR code's, which alias bg-app in dark, stay dark ink on paper.
    const expected = {
      'bg-app': '#f6f4ee',
      'bg-panel': '#efece4',
      'bg-surface': '#fbfaf6',
      'bg-muted': '#e9e5da',
      'bg-selected': '#e3ddcf',
      'text-primary': 'rgba(28,27,25,0.92)',
      'text-secondary': 'rgba(28,27,25,0.68)',
      'text-tertiary': 'rgba(28,27,25,0.64)',
      'line-hairline': 'rgba(28,27,25,0.10)',
      'line-card': 'rgba(28,27,25,0.13)',
      'line-control': 'rgba(28,27,25,0.22)',
      'line-control-hover': 'rgba(28,27,25,0.32)',
      'line-field': 'rgba(28,27,25,0.56)',
      'fill-card': 'rgba(255,255,255,0.55)',
      'fill-count': 'rgba(28,27,25,0.05)',
      'fill-hover': 'rgba(28,27,25,0.05)',
      'fill-bubble': 'rgba(28,27,25,0.06)',
      'fill-secondary': 'rgba(28,27,25,0.07)',
      'fill-secondary-hover': 'rgba(28,27,25,0.11)',
      'button-primary': '#1f1e1b',
      'button-primary-hover': '#3a3833',
      'button-danger-fill': 'rgba(176,58,74,0.10)',
      'button-danger-fill-hover': 'rgba(176,58,74,0.16)',
      'button-danger-text': '#9e3343',
      'accent-blue': '#285e92',
      'status-handled': '#3f7a2e',
      'status-held': '#8c6d08',
      'status-refused': '#b2475a',
      clay: '#c4673f',
      scrim: 'rgba(28,27,25,0.32)',
      'illustration-card': '#fdfcf9',
      'illustration-ink': '#1c1b19',
      'illustration-arc': 'rgba(28,27,25,0.08)',
      'qr-ink': '#1c1b19',
      'connector-stripe': '#635bff',
      'shadow-composer': '0 4px 20px rgba(28,27,25,0.08)',
      'shadow-dialog': '0 4px 8px rgba(28,27,25,0.05), 0 12px 28px -2px rgba(28,27,25,0.14)',
      'shadow-illustration-card': '0 1px 2px rgba(28,27,25,0.12)',
    };
    const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'tokens.css'), 'utf8');
    /** The declarations in the block that opens with `opening`, as a property-to-value map. */
    const declarations = (opening: string) => {
      const start = css.indexOf(`${opening} {\n`);
      expect(start, opening).toBeGreaterThanOrEqual(0);
      const body = css.slice(start + opening.length + 2, css.indexOf('}', start));
      return Object.fromEntries(body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(':')), d.slice(d.indexOf(':') + 1).trim()]));
    };
    const want = { 'color-scheme': 'light', ...Object.fromEntries(Object.entries(expected).map(([name, value]) => [`--${name}`, value])) };
    expect(declarations(':root[data-theme="light"]')).toEqual(want);
    expect(declarations('@media (prefers-color-scheme: light) {\n  :root:not([data-theme="dark"])')).toEqual(want);
    // Each theme block once: dark on the root, light chosen, light by the system.
    const count = (opening: string) => css.split(opening).length - 1;
    expect([':root,\n[data-theme="dark"] {', ':root[data-theme="light"] {', ':root:not([data-theme="dark"]) {'].map(count)).toEqual([1, 1, 1]);
  });

  test('every_color_and_shadow_has_a_dark_value', () => {
    // Dark is the base theme: every color and shadow has a dark value, and light is the only other theme.
    const themes = tokens.color.themes.map((theme) => theme.id);
    expect(themes).toEqual(['dark', 'light']);
    for (const token of [...tokens.color.tokens, ...tokens.shadow.tokens]) {
      expect(typeof token.value.dark, token.name).toBe('string');
      expect(Object.keys(token.value).filter((theme) => !themes.includes(theme)), token.name).toEqual([]);
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

  test('every_used_pair_meets_contrast_in_both_themes', () => {
    // The ratio itself, against known WCAG values, so a broken formula can't pass the pairs.
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('rgba(0,0,0,0.5)', '#ffffff')).toBeCloseTo(contrastRatio('#808080', '#ffffff'), 1);
    expect(contrastRatio('text-primary', 'fill-card', 'bg-app')).toBeGreaterThan(1);
    expect(() => contrastRatio('text-primary', 'fill-card')).toThrow();
    expect(() => contrastRatio('not-a-color', 'bg-app')).toThrow();

    // Each theme reads its own values: light where a token has one, and its dark one where it hasn't,
    // an alias resolving against the light values, as the CSS inherits them.
    expect(pairContrast({ fg: 'text-primary', ground: 'bg-app' }, 'light')).toBeCloseTo(contrastRatio('rgba(28,27,25,0.92)', '#f6f4ee'), 6);
    expect(pairContrast({ fg: 'line-focus', ground: 'bg-app' }, 'light')).toBeCloseTo(contrastRatio('rgba(28,27,25,0.68)', '#f6f4ee'), 6);
    expect(pairContrast({ fg: 'mark-ink', ground: 'mark-tile' }, 'light')).toBeCloseTo(pairContrast({ fg: 'mark-ink', ground: 'mark-tile' }), 6);
    expect(pairContrast({ fg: 'text-primary', ground: 'bg-app' })).toBeCloseTo(pairContrast({ fg: 'text-primary', ground: 'bg-app' }, 'dark'), 6);

    type Required = { fg: string; ground: string; over?: string; under?: string; opacity?: number; min: 4.5 | 3; themes: readonly Theme[] };
    const required: Required[] = [];
    let drawnIn: readonly Theme[] = THEMES;
    const add = (fgs: string[], grounds: string[], min: 4.5 | 3, over?: string, under?: string, opacity?: number) => {
      for (const fg of fgs) for (const ground of grounds) required.push({ fg, ground, over, under, opacity, min, themes: drawnIn });
    };
    /** Requires the pairs `require` adds in `themes` only. */
    const only = (themes: readonly Theme[], require: () => void) => {
      drawnIn = themes;
      require();
      drawnIn = THEMES;
    };
    const text = ['text-primary', 'text-secondary', 'text-tertiary', 'accent-blue'];
    add(text, ['bg-app', 'bg-panel', 'bg-surface', 'bg-muted', 'bg-selected'], 4.5);
    add(text, ['fill-card', 'fill-bubble', 'fill-count', 'fill-hover', 'fill-secondary'], 4.5, 'bg-app');
    add(text, ['fill-secondary', 'fill-hover'], 4.5, 'bg-surface');
    add(['text-primary', 'text-secondary'], ['fill-secondary-hover'], 4.5, 'bg-app');
    add(['text-primary', 'text-secondary'], ['fill-secondary-hover'], 4.5, 'bg-surface');
    add(['button-primary-text'], ['button-primary', 'button-primary-hover'], 4.5);
    const marks = ['accent-blue', 'line-focus', 'status-handled', 'status-held', 'status-refused', 'status-info'];
    add(marks, ['bg-app', 'bg-panel', 'bg-surface', 'bg-selected'], 3);
    add(marks, ['fill-card'], 3, 'bg-app');
    // The focus edge on the reviewer bar, and inside a menu item or a sidebar row that has focus.
    add(['line-focus'], ['bg-muted'], 3);
    add(['line-focus'], ['fill-hover'], 3, 'bg-surface');
    add(['line-focus'], ['fill-hover'], 3, 'bg-panel');
    // The focus edge inside a secondary or danger button, at rest and hovered, on a page, a dialog and a
    // card; and the primary's, drawn in bg-app on its fill, at rest and hovered.
    add(['line-focus'], ['fill-secondary', 'fill-secondary-hover', 'button-danger-fill', 'button-danger-fill-hover'], 3, 'bg-app');
    add(['line-focus'], ['fill-secondary', 'fill-secondary-hover', 'button-danger-fill', 'button-danger-fill-hover'], 3, 'fill-card', 'bg-app');
    add(['line-focus'], ['fill-secondary', 'fill-secondary-hover', 'button-danger-fill', 'button-danger-fill-hover'], 3, 'bg-surface');
    add(['bg-app'], ['button-primary', 'button-primary-hover'], 3);
    // The mark without its tile: its light ink and clay dome on the app, the sidebar and the phone
    // top bar, and the intro dialog's surface, in the dark theme; its dark ink on the same grounds in
    // the light theme, and on the intro illustration's light card in both.
    only(['dark'], () => add(['mark-ink-light', 'mark-clay'], ['bg-app', 'bg-panel', 'bg-surface'], 3));
    only(['light'], () => add(['mark-ink'], ['bg-app', 'bg-panel', 'bg-surface'], 3));
    add(['mark-ink'], ['illustration-card'], 3);
    // The mark with its tile: the tile on the app, as the design system's stories show it, and its
    // drawing on the tile, the ink where it crosses the clay dome included.
    only(['dark'], () => add(['mark-tile'], ['bg-app'], 3));
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
    // A text field's border while it has focus, one step stronger than its outline.
    add(['line-focus'], ['bg-surface', 'bg-app'], 3);
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
    // A delete that cannot be undone, in its confirmation dialog: label at rest, hover and busy.
    add(['button-danger-text'], ['button-danger-fill', 'button-danger-fill-hover'], 4.5, 'bg-surface');
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
    // buttons' on their busy grounds on a page, in a card and in a dialog.
    add(['button-primary-text'], ['button-primary-hover'], 3);
    for (const over of ['bg-app', 'bg-surface']) add(['text-secondary'], ['fill-secondary'], 3, over);
    add(['text-secondary'], ['fill-secondary'], 3, 'fill-card', 'bg-app');
    add(['text-secondary'], ['bg-app', 'bg-panel', 'bg-surface', 'bg-muted'], 3);
    add(['text-secondary'], ['fill-card'], 3, 'bg-app');
    add(['button-danger-text'], ['button-danger-fill-hover', 'fill-hover'], 3, 'bg-app');
    add(['button-danger-text'], ['button-danger-fill-hover', 'fill-hover'], 3, 'fill-card', 'bg-app');
    add(['button-danger-text'], ['button-danger-fill-hover', 'fill-hover'], 3, 'bg-surface');

    // Every required pair is listed, at no lower a minimum and in every theme it is required in, so
    // dropping one can't pass.
    for (const want of required) {
      const listed = CONTRAST_PAIRS.find(
        (p) =>
          p.fg === want.fg && p.ground === want.ground && p.over === want.over && p.under === want.under && p.opacity === want.opacity,
      );
      expect(listed, label(want)).toBeDefined();
      expect(listed?.min).toBeGreaterThanOrEqual(want.min);
      expect(listed?.themes ?? THEMES, `${label(want)} is checked in ${want.themes.join(' and ')}`).toEqual(expect.arrayContaining([...want.themes]));
    }

    // Every listed pair meets its minimum in each theme it is drawn in: both, unless it says.
    for (const pair of CONTRAST_PAIRS) {
      expect(pair.use.trim().length, `${label(pair)} says where it is used`).toBeGreaterThan(0);
      for (const theme of pair.themes ?? THEMES) {
        expect(pairContrast(pair, theme), `${label(pair)} in ${theme}`).toBeGreaterThanOrEqual(pair.min);
      }
    }

    // Only the mark's pairs are drawn in one theme: on the app's grounds its ink is light in the dark
    // theme and dark in the light one. The clay dome and the lone tile there are dark-only pairs, and
    // the light theme draws them as the logo they are, exempt from contrast, each named with why.
    const oneTheme = CONTRAST_PAIRS.filter((p) => p.themes !== undefined).map((p) => `${label(p)} in ${p.themes?.join(' and ')}`);
    expect(oneTheme.sort()).toEqual(
      [
        ...['bg-app', 'bg-panel', 'bg-surface'].flatMap((ground) => [
          `mark-ink-light on ${ground} in dark`,
          `mark-clay on ${ground} in dark`,
          `mark-ink on ${ground} in light`,
        ]),
        'mark-tile on bg-app in dark',
      ].sort(),
    );
    expect(LIGHT_THEME_EXEMPTIONS.map(label)).toEqual(['mark-clay on bg-app', 'mark-clay on bg-panel', 'mark-clay on bg-surface', 'mark-tile on bg-app']);
    for (const exempt of LIGHT_THEME_EXEMPTIONS) {
      expect(exempt.reason.trim().length, `${label(exempt)} says why it is exempt`).toBeGreaterThan(0);
      // A real exemption: it falls under the minimum its dark pair keeps, so a stale one shows.
      const dark = CONTRAST_PAIRS.find((p) => p.fg === exempt.fg && p.ground === exempt.ground && p.themes?.join() === 'dark');
      expect(dark, `${label(exempt)} is listed for the dark theme`).toBeDefined();
      expect(pairContrast(exempt, 'light'), label(exempt)).toBeLessThan(dark?.min ?? 0);
    }
  });

  test('state_change_pairs_compare_each_edge_on_the_same_ground_without_a_3_to_1_floor', () => {
    for (const theme of THEMES) {
      const resting = pairContrast({ fg: 'line-field', ground: 'bg-app' }, theme);
      const before = pairContrast({ fg: 'text-tertiary', ground: 'bg-app' }, theme) / resting;
      const after = pairContrast({ fg: 'line-focus', ground: 'bg-app' }, theme) / resting;
      expect(after).toBeGreaterThan(before);
      expect(after).toBeCloseTo(theme === 'light' ? 1.46 : 2.27, 2);
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
    // On the light theme's paper, Stripe's white mark would vanish: it takes Stripe's own purple there,
    // with no outline and no tile. Google Calendar's blue stays.
    const light = (name: string) => tokens.color.tokens.find((t) => t.name === name)?.value as { light?: string } | undefined;
    expect([light('connector-stripe')?.light, light('connector-google-blue')?.light]).toEqual(['#635bff', undefined]);

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

  test('colours_on_brand_are_the_same_in_both_themes', () => {
    // On an owner's chosen colour, the public header and Profile's header-colour preview: the dark
    // theme's paper inks for its words, and the dark theme's handled green for the open-status dot,
    // in both themes, since every colour an owner can pick is dark.
    const expected = {
      'text-on-brand': 'rgba(250,249,245,0.92)',
      'text-on-brand-secondary': 'rgba(250,249,245,0.64)',
      'status-handled-on-brand': '#6fa859',
    };
    const names = Object.keys(expected);
    expect(Object.fromEntries(names.map((name) => [name, tokenValue(name)]))).toEqual(expected);
    for (const name of names) {
      const token = tokens.color.tokens.find((t) => t.name === name);
      expect(Object.keys(token?.value ?? {}), `${name} has one value for both themes`).toEqual(['dark']);
    }
    // The colour under them isn't a token: it is checked where it is chosen, so they are classified
    // as colours on the owner's colour rather than listed against a token, the words at 4.5:1 and the
    // dot, a status mark, at 3:1.
    expect(Object.fromEntries(Object.entries(ON_BRAND_COLORS).map(([name, { min }]) => [name, min]))).toEqual({
      'text-on-brand': 4.5,
      'text-on-brand-secondary': 4.5,
      'status-handled-on-brand': 3,
    });
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

    for (const [name, { use }] of Object.entries(ON_BRAND_COLORS)) {
      expect(colorNames, `${name} is a color token`).toContain(name);
      expect(use.trim().length, `${name} says where it is used and checked`).toBeGreaterThan(0);
    }

    const paired = new Set(CONTRAST_PAIRS.flatMap((p) => [p.fg, p.ground]));
    const unclassified = colorNames.filter((name) => !paired.has(name) && !(name in DECORATIVE_COLORS) && !(name in ON_BRAND_COLORS));
    expect(unclassified).toEqual([]);
  });

  test('word_settle_is_a_token', () => {
    // Each new word of Claude's reply settles in over 150 ms as it streams or is revealed, as the
    // signed Markdown and streaming boards draw it.
    expect(tokenValue('motion-settle')).toBe('150ms');
  });

  test('follow_beat_is_a_token', () => {
    // After a revealed reply's words, its cards and then their receipts fade in 200 ms apart, one
    // after another, as the project owner asked.
    expect(tokenValue('motion-follow')).toBe('200ms');
  });

  test('follow_beat_lets_each_part_finish_first', () => {
    // Each part of a revealed reply starts only once the one before has finished: the beat is never
    // shorter than a card's or a line's fade (motion-base) or the last word's settle (motion-settle).
    const ms = (name: string) => Number.parseFloat(String(tokenValue(name)));
    expect(ms('motion-follow')).toBeGreaterThanOrEqual(ms('motion-base'));
    expect(ms('motion-follow')).toBeGreaterThanOrEqual(ms('motion-settle'));
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
