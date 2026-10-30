#!/usr/bin/env node
// Generates the Claude Desk mark's geometry (src/ds/components/Mark/markGeometry.ts) from the mark's
// signed drawing (src/ds/components/Mark/mark.svg), which is also the page's icon, so `Mark` draws
// exactly the same shapes.
//   node scripts/gen-mark.mjs          write markGeometry.ts
//   node scripts/gen-mark.mjs --check  exit 1 if markGeometry.ts is stale
// The drawing is read strictly: a white tile, then one group holding the clay group and the ink
// group, with nothing else. Any other element, attribute or value throws instead of being dropped.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NUMBER = /^-?\d+(?:\.\d+)?$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
// Path data: a move first, then commands, numbers, spaces and commas only.
const PATH_DATA = /^[Mm][MmLlHhVvCcSsQqTtAaZz0-9 .,-]*$/;
// The shapes, which hold no children (no animation, no title, nothing else).
const LEAVES = new Set(['rect', 'path', 'circle']);
const ART_TRANSFORM = /^translate\(-?\d+(?:\.\d+)? -?\d+(?:\.\d+)?\) scale\(\d+(?:\.\d+)?\)$/;
const VIEW_BOX = /^0 0 \d+ \d+$/;
// One tag with its attributes, or the whitespace between tags.
const TOKEN = /\s*<(\/?)([A-Za-z]+)((?:\s+[A-Za-z:-]+="[^"<>]*")*)\s*(\/?)>\s*/y;
const ATTRIBUTE = /([A-Za-z:-]+)="([^"]*)"/g;

function fail(message) {
  throw new Error(`mark.svg: ${message}`);
}

/** The drawing as a tree of `{ name, attrs, children }`, or a throw on anything that isn't a tag. */
function parse(svg) {
  const root = { name: '#root', attrs: {}, children: [] };
  const open = [root];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < svg.length) {
    const at = TOKEN.lastIndex;
    const tag = TOKEN.exec(svg);
    if (tag === null) fail(`unexpected text at ${at}: ${JSON.stringify(svg.slice(at, at + 24))}`);
    const [, closing, name, attrText, selfClosing] = tag;
    const parent = open[open.length - 1];
    if (closing) {
      if (parent.name !== name || attrText !== '' || selfClosing) fail(`unexpected </${name}>`);
      open.pop();
      continue;
    }
    const pairs = [...attrText.matchAll(ATTRIBUTE)].map(([, key, value]) => [key, value]);
    const keys = pairs.map(([key]) => key);
    const repeated = keys.find((key, i) => keys.indexOf(key) !== i);
    if (repeated !== undefined) fail(`<${name}> has the attribute ${repeated} twice`);
    const node = { name, attrs: Object.fromEntries(pairs), children: [] };
    parent.children.push(node);
    if (!selfClosing) open.push(node);
  }
  if (open.length !== 1) fail(`<${open[open.length - 1].name}> is never closed`);
  if (root.children.length !== 1) fail('expected one <svg>');
  return root.children[0];
}

/** Checks a node's name, that it has exactly the attributes listed, and that a shape has no children. */
function expectNode(node, name, keys) {
  if (node.name !== name) fail(`unexpected <${node.name}> where <${name}> belongs`);
  if (LEAVES.has(name) && node.children.length > 0) fail(`<${name}> has children, which a shape can't`);
  const extra = Object.keys(node.attrs).filter((key) => !keys.includes(key));
  if (extra.length > 0) fail(`unexpected attribute ${extra.join(', ')} on <${name}>`);
  const missing = keys.filter((key) => !(key in node.attrs));
  if (missing.length > 0) fail(`<${name}> lacks ${missing.join(', ')}`);
}

function number(value, where) {
  if (!NUMBER.test(value)) fail(`${where} is not a number: ${JSON.stringify(value)}`);
  return Number(value);
}

function hex(value, where) {
  if (!HEX.test(value)) fail(`${where} is not a hex color: ${JSON.stringify(value)}`);
  return value.toLowerCase();
}

function pathData(node, where) {
  expectNode(node, 'path', ['d']);
  if (!PATH_DATA.test(node.attrs.d)) fail(`a path in the ${where} group doesn't start with a move or has unexpected data`);
  return node.attrs.d;
}

function circle(node) {
  expectNode(node, 'circle', ['cx', 'cy', 'r']);
  const { cx, cy, r } = node.attrs;
  return { cx: number(cx, 'a circle cx'), cy: number(cy, 'a circle cy'), r: number(r, 'a circle r') };
}

/**
 * The mark read from its drawing: its geometry (what `Mark` draws) and its colors, in the forms
 * tokens.json writes them (lowercase hex; the hairline as rgba).
 */
export function readMark(svg) {
  const root = parse(svg);
  expectNode(root, 'svg', ['xmlns', 'viewBox']);
  if (root.attrs.xmlns !== 'http://www.w3.org/2000/svg') fail('unexpected xmlns');
  if (!VIEW_BOX.test(root.attrs.viewBox)) fail(`unexpected viewBox ${root.attrs.viewBox}`);
  const [tileNode, artNode, ...rest] = root.children;
  if (tileNode === undefined || artNode === undefined || rest.length > 0) fail('expected the tile, then the art group');

  expectNode(tileNode, 'rect', ['x', 'y', 'width', 'height', 'rx', 'fill', 'stroke', 'stroke-opacity']);
  const tile = Object.fromEntries(['x', 'y', 'width', 'height', 'rx'].map((key) => [key, number(tileNode.attrs[key], `the tile's ${key}`)]));
  for (const key of ['width', 'height', 'rx']) if (!(tile[key] > 0)) fail(`the tile's ${key} must be more than 0`);
  const hairlineOpacity = number(tileNode.attrs['stroke-opacity'], "the tile's stroke-opacity");
  if (hairlineOpacity <= 0 || hairlineOpacity > 1) fail("the tile's stroke-opacity is out of range");

  expectNode(artNode, 'g', ['transform']);
  if (!ART_TRANSFORM.test(artNode.attrs.transform)) fail(`unexpected transform ${artNode.attrs.transform}`);
  const [clayNode, inkNode, ...more] = artNode.children;
  if (clayNode === undefined || inkNode === undefined || more.length > 0) fail('expected the clay group, then the ink group');
  expectNode(clayNode, 'g', ['fill']);
  expectNode(inkNode, 'g', ['fill']);

  const clay = clayNode.children.map((node) => pathData(node, 'clay'));
  if (clay.length === 0) fail('the clay group is empty');
  const ink = inkNode.children.map((node) => (node.name === 'circle' ? circle(node) : { d: pathData(node, 'ink') }));
  if (ink.length === 0) fail('the ink group is empty');

  const stroke = hex(tileNode.attrs.stroke, "the tile's stroke");
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(stroke.slice(i, i + 2), 16));
  return {
    geometry: { viewBox: root.attrs.viewBox, tile, art: artNode.attrs.transform, clay, ink },
    colors: {
      tile: hex(tileNode.attrs.fill, "the tile's fill"),
      clay: hex(clayNode.attrs.fill, "the clay group's fill"),
      ink: hex(inkNode.attrs.fill, "the ink group's fill"),
      hairline: `rgba(${r},${g},${b},${hairlineOpacity})`,
    },
  };
}

/** The markGeometry.ts text for the mark in `svg`. */
export function buildMarkGeometry(svg) {
  const { viewBox, tile, art, clay, ink } = readMark(svg).geometry;
  const shape = (s) => ('d' in s ? `{ d: '${s.d}' }` : `{ cx: ${s.cx}, cy: ${s.cy}, r: ${s.r} }`);
  return [
    '// Generated from mark.svg by `npm run gen:mark`; never edit this file by hand.',
    '',
    '/**',
    " * The Claude Desk mark's geometry on its 100-unit grid, read from its signed drawing (mark.svg,",
    " * also the page's icon): the tile, then the bell drawn at `art` inside it, its clay dome under its",
    " * ink lines. `Mark` draws from it, so the mark and the drawing can't drift. Color is not geometry:",
    " * the mark's fixed colors are the `mark-*` tokens.",
    ' */',
    'export const MARK_GEOMETRY = {',
    `  viewBox: '${viewBox}',`,
    `  tile: { x: ${tile.x}, y: ${tile.y}, width: ${tile.width}, height: ${tile.height}, rx: ${tile.rx} },`,
    `  art: '${art}',`,
    '  clay: [',
    ...clay.map((d) => `    '${d}',`),
    '  ],',
    '  ink: [',
    ...ink.map((s) => `    ${shape(s)},`),
    '  ],',
    '} as const;',
    '',
  ].join('\n');
}

function main(args) {
  const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const drawingPath = path.join(web, 'src', 'ds', 'components', 'Mark', 'mark.svg');
  const outPath = path.join(web, 'src', 'ds', 'components', 'Mark', 'markGeometry.ts');
  const unknown = args.filter((arg) => arg !== '--check');
  if (unknown.length > 0) {
    console.error(`Unknown argument: ${unknown.join(' ')}. Use --check to verify without writing.`);
    return 2;
  }
  const text = buildMarkGeometry(readFileSync(drawingPath, 'utf8'));
  if (args.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(outPath, 'utf8');
    } catch {
      // A missing file is stale.
    }
    if (current !== text) {
      console.error('src/ds/components/Mark/markGeometry.ts is out of date with mark.svg. Run `npm run gen:mark`.');
      return 1;
    }
    console.log('src/ds/components/Mark/markGeometry.ts matches mark.svg.');
    return 0;
  }
  writeFileSync(outPath, text);
  console.log('Wrote src/ds/components/Mark/markGeometry.ts from mark.svg.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
