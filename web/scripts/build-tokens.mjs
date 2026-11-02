#!/usr/bin/env node
// Generates src/ds/tokens.css from src/ds/tokens.json, the one token source.
//   node scripts/build-tokens.mjs          write tokens.css
//   node scripts/build-tokens.mjs --check  exit 1 if tokens.css is stale
// Invalid tokens throw instead of producing CSS, so a bad value never ships.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const HEX = /^#[0-9a-f]{6}$/;
const RGBA = /^rgba\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*\)$/;
const ALIAS = /^\{([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\}$/;
const LENGTH = /^-?\d+(?:\.\d+)?px$/;
// Plain CSS values for the list families: no var(), url() or declarations.
const PLAIN_VALUE = /^[A-Za-z0-9 #%(),./+_-]{1,200}$/;
const LIST_FAMILIES = ['spacing', 'radius', 'size', 'motion'];
// The color themes: dark is the base; light overrides it where it has values.
const BASE_THEME = 'dark';
const LIGHT_THEME = 'light';
// The numeral forms a type style may ask for: tabular figures, for numbers that line up.
const NUMERIC = new Set(['tabular-nums']);
// The font styles a type style may ask for: italic, for a reading page's quotations.
const FONT_STYLES = new Set(['italic']);
// The one style that draws capitals, and how: the lockup's "Preview" badge, the product's one
// all-caps label. Any other style, or any other transform, is refused.
const CAPS_STYLE = 'badge-caps';
const TEXT_TRANSFORMS = new Set(['uppercase']);

function fail(message) {
  throw new Error(`tokens.json: ${message}`);
}

function checkName(name, where) {
  if (typeof name !== 'string' || !NAME.test(name)) fail(`${where} has an invalid name: ${JSON.stringify(name)}`);
}

/**
 * The color themes: dark, the base every token has a value for, then optionally light, which sets
 * only the tokens it has a value for.
 */
function themeIds(color) {
  const ids = Array.isArray(color?.themes) ? color.themes.map((theme) => theme?.id) : [];
  const known = ids[0] === BASE_THEME && (ids.length === 1 || (ids.length === 2 && ids[1] === LIGHT_THEME));
  if (!known) fail(`expects the color themes ${BASE_THEME}, then optionally ${LIGHT_THEME}; found ${JSON.stringify(ids)}`);
  return ids;
}

/**
 * A themed token's value for `theme`, or undefined when it has none. Dark is required; a value for
 * a theme that isn't declared is refused, so a misspelt one can't be dropped unnoticed.
 */
function themedValue(token, themes, theme) {
  const values = token.value;
  if (values === null || typeof values !== 'object' || Array.isArray(values)) fail(`${token.name} has no per-theme values`);
  for (const key of Object.keys(values)) {
    if (!themes.includes(key)) fail(`${token.name} has a value for an unknown theme: ${JSON.stringify(key)}`);
  }
  const value = values[theme];
  if (value === undefined && theme !== BASE_THEME) return undefined;
  if (typeof value !== 'string') fail(`${token.name} has no ${theme} value`);
  return value;
}

function colorDeclarations(color, themes, theme) {
  const names = new Set(color.tokens.map((t) => t.name));
  return color.tokens.flatMap((token) => {
    checkName(token.name, 'a color token');
    const value = themedValue(token, themes, theme);
    if (value === undefined) return [];
    const alias = ALIAS.exec(value);
    if (alias) {
      const target = alias[1];
      if (target === token.name || !names.has(target)) fail(`${token.name} aliases a missing color: ${value}`);
      return [`  --${token.name}: var(--${target});`];
    }
    if (!HEX.test(value) && !RGBA.test(value)) fail(`${token.name} has an unsupported color: ${value}`);
    return [`  --${token.name}: ${value};`];
  });
}

function shadowDeclarations(shadows, themes, theme) {
  return shadows.flatMap((token) => {
    checkName(token.name, 'a shadow token');
    const value = themedValue(token, themes, theme);
    if (value === undefined) return [];
    if (!PLAIN_VALUE.test(value)) fail(`${token.name} has an unsupported value: ${JSON.stringify(value)}`);
    return [`  --${token.name}: ${value};`];
  });
}

/** The color and shadow declarations for `theme`: every token for dark, those with a value for light. */
function themedDeclarations(tokens, themes, theme) {
  return [...colorDeclarations(tokens.color, themes, theme), ...shadowDeclarations(tokens.shadow?.tokens ?? [], themes, theme)];
}

/**
 * The theme blocks. Dark is the base, on :root and on anything marked dark. Light is chosen on the
 * root (data-theme="light"), or by the system while dark isn't chosen, and carries the browser's
 * own scheme with it, so its scrollbars and form controls follow. A token without a light value
 * keeps its dark one: an alias resolves against the light values on the same root.
 */
function themeBlocks(tokens) {
  const themes = themeIds(tokens.color);
  const blocks = [`:root,\n[data-theme="${BASE_THEME}"] {\n${themedDeclarations(tokens, themes, BASE_THEME).join('\n')}\n}`];
  if (!themes.includes(LIGHT_THEME)) return blocks;
  const light = [`  color-scheme: ${LIGHT_THEME};`, ...themedDeclarations(tokens, themes, LIGHT_THEME)];
  blocks.push(`:root[data-theme="${LIGHT_THEME}"] {\n${light.join('\n')}\n}`);
  blocks.push(
    `@media (prefers-color-scheme: ${LIGHT_THEME}) {\n  :root:not([data-theme="${BASE_THEME}"]) {\n${light.map((line) => `  ${line}`).join('\n')}\n  }\n}`,
  );
  return blocks;
}

function listDeclarations(family, entries) {
  return entries.map((token) => {
    checkName(token.name, `a ${family} token`);
    if (typeof token.value !== 'string' || !PLAIN_VALUE.test(token.value)) {
      fail(`${token.name} has an unsupported value: ${JSON.stringify(token.value)}`);
    }
    return `  --${token.name}: ${token.value};`;
  });
}

function fontFamilyDeclarations(families) {
  return Object.entries(families).map(([key, stack]) => {
    checkName(key, 'a font family');
    if (typeof stack !== 'string' || /[;{}<>\\()]/.test(stack)) fail(`font family ${key} is not a plain stack`);
    return `  --font-${key}: ${stack};`;
  });
}

function typeStyleRule(style, groupFamily, families) {
  checkName(style.name, 'a type style');
  const family = style.family ?? groupFamily;
  if (!(family in families)) fail(`type style ${style.name} uses an unknown family: ${family}`);
  for (const key of ['fontSize', 'lineHeight']) {
    if (!LENGTH.test(style[key])) fail(`type style ${style.name} has an unsupported ${key}: ${style[key]}`);
  }
  if (!Number.isInteger(style.fontWeight) || style.fontWeight < 1 || style.fontWeight > 1000) {
    fail(`type style ${style.name} has an unsupported fontWeight: ${style.fontWeight}`);
  }
  const lines = [
    `.cd-type-${style.name} {`,
    `  font-family: var(--font-${family});`,
    `  font-size: ${style.fontSize};`,
    `  line-height: ${style.lineHeight};`,
    `  font-weight: ${style.fontWeight};`,
  ];
  if (style.fontStyle !== undefined) {
    if (!FONT_STYLES.has(style.fontStyle)) fail(`type style ${style.name} has an unsupported fontStyle`);
    lines.push(`  font-style: ${style.fontStyle};`);
  }
  if (style.letterSpacing !== undefined) {
    if (!LENGTH.test(style.letterSpacing)) fail(`type style ${style.name} has an unsupported letterSpacing`);
    lines.push(`  letter-spacing: ${style.letterSpacing};`);
  }
  if (style.textTransform !== undefined) {
    if (style.name !== CAPS_STYLE || !TEXT_TRANSFORMS.has(style.textTransform)) {
      fail(`type style ${style.name} has an unsupported textTransform: only ${CAPS_STYLE} draws capitals`);
    }
    lines.push(`  text-transform: ${style.textTransform};`);
  }
  if (style.fontVariantNumeric !== undefined) {
    if (!NUMERIC.has(style.fontVariantNumeric)) fail(`type style ${style.name} has an unsupported fontVariantNumeric`);
    lines.push(`  font-variant-numeric: ${style.fontVariantNumeric};`);
  }
  if (style.opticalSize !== undefined) {
    if (typeof style.opticalSize !== 'number' || !(style.opticalSize > 0)) {
      fail(`type style ${style.name} has an unsupported opticalSize`);
    }
    lines.push(`  font-variation-settings: 'opsz' ${style.opticalSize};`);
  }
  lines.push('}');
  return lines.join('\n');
}

/** The tokens.css text for a tokens object in the design system's list shape. */
export function buildTokensCss(tokens) {
  const themed = themeBlocks(tokens);
  const plain = [
    ...LIST_FAMILIES.flatMap((family) => listDeclarations(family, tokens[family]?.tokens ?? [])),
    ...fontFamilyDeclarations(tokens.type.families),
  ];
  const typeRules = tokens.type.groups.flatMap((group) =>
    group.styles.map((style) => typeStyleRule(style, group.family, tokens.type.families)),
  );

  return [
    `/* ${tokens.name} — generated from tokens.json */`,
    '/* Run `npm run tokens` after changing tokens.json; never edit this file by hand. */',
    '',
    ...themed.flatMap((block) => [block, '']),
    `:root {\n${plain.join('\n')}\n}`,
    '',
    typeRules.join('\n\n'),
    '',
  ].join('\n');
}

function main(args) {
  const ds = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ds');
  const tokensPath = path.join(ds, 'tokens.json');
  const cssPath = path.join(ds, 'tokens.css');
  const unknown = args.filter((arg) => arg !== '--check');
  if (unknown.length > 0) {
    console.error(`Unknown argument: ${unknown.join(' ')}. Use --check to verify without writing.`);
    return 2;
  }
  const css = buildTokensCss(JSON.parse(readFileSync(tokensPath, 'utf8')));
  if (args.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(cssPath, 'utf8');
    } catch {
      // A missing file is stale.
    }
    if (current !== css) {
      console.error('src/ds/tokens.css is out of date with tokens.json. Run `npm run tokens`.');
      return 1;
    }
    console.log('src/ds/tokens.css matches tokens.json.');
    return 0;
  }
  writeFileSync(cssPath, css);
  console.log('Wrote src/ds/tokens.css from tokens.json.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
