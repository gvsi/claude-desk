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
// The numeral forms a type style may ask for: tabular figures, for numbers that line up.
const NUMERIC = new Set(['tabular-nums']);

function fail(message) {
  throw new Error(`tokens.json: ${message}`);
}

function checkName(name, where) {
  if (typeof name !== 'string' || !NAME.test(name)) fail(`${where} has an invalid name: ${JSON.stringify(name)}`);
}

function colorDeclarations(color, theme) {
  const names = new Set(color.tokens.map((t) => t.name));
  return color.tokens.map((token) => {
    checkName(token.name, 'a color token');
    const value = token.value?.[theme];
    if (typeof value !== 'string') fail(`${token.name} has no ${theme} value`);
    const alias = ALIAS.exec(value);
    if (alias) {
      const target = alias[1];
      if (target === token.name || !names.has(target)) fail(`${token.name} aliases a missing color: ${value}`);
      return `  --${token.name}: var(--${target});`;
    }
    if (!HEX.test(value) && !RGBA.test(value)) fail(`${token.name} has an unsupported color: ${value}`);
    return `  --${token.name}: ${value};`;
  });
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
  if (style.letterSpacing !== undefined) {
    if (!LENGTH.test(style.letterSpacing)) fail(`type style ${style.name} has an unsupported letterSpacing`);
    lines.push(`  letter-spacing: ${style.letterSpacing};`);
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
  const themes = tokens?.color?.themes;
  if (!Array.isArray(themes) || themes.length !== 1) fail('expects exactly one color theme');
  const theme = themes[0].id;
  checkName(theme, 'the theme');

  const themed = [
    ...colorDeclarations(tokens.color, theme),
    ...listDeclarations('shadow', tokens.shadow?.tokens ?? []),
  ];
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
    `:root,\n[data-theme="${theme}"] {\n${themed.join('\n')}\n}`,
    '',
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
