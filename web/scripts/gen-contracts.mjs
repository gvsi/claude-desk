#!/usr/bin/env node
// Generates src/api/contracts.gen.ts from backend/desk/contracts.schema.json, the shared
// contracts exported from the backend's Pydantic models. The web app's contract types come
// from here once; import them from src/api/contracts.ts, never from this output directly.
//   node scripts/gen-contracts.mjs          write contracts.gen.ts
//   node scripts/gen-contracts.mjs --check  exit 1 if contracts.gen.ts is stale

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { compile } from 'json-schema-to-typescript';

const ROOT_NAME = 'ContractSchema';

const BANNER = [
  '// Contract types, generated, do not edit.',
  '// Source: backend/desk/contracts.schema.json. Run `npm run gen:contracts` after it changes.',
  '// Import these from src/api/contracts.ts, the one import path for contract types.',
].join('\n');

function fail(message) {
  throw new Error(`contracts.schema.json: ${message}`);
}

/**
 * A copy of one schema node prepared for the compiler:
 * - `title` is dropped everywhere, since the compiler names a separate type after every
 *   field title (inline unions would become `Code`, `Code1`, …); `$defs` keys name the models.
 * - An object with `properties` and no `additionalProperties` of its own, a model, is closed.
 * - A dictionary keeps its value schema (`PublicDesk.brand` stays `{ [k: string]: string }`).
 * - A free-form object (`dict` in the models: `ToolProfile.input_schema`, `LedgerEvent.summary`)
 *   is `Record<string, unknown>`, so no model interface carries an open index signature.
 * gen-api.mjs prepares the API's own schemas the same way.
 */
export function prepare(node) {
  if (Array.isArray(node)) return node.map(prepare);
  if (node === null || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'title') continue;
    if (key === 'properties') {
      // Property names are data, not keywords: keep every name (`title` included).
      out.properties = Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, prepare(schema)]));
      continue;
    }
    out[key] = prepare(value);
  }
  if (out.properties && typeof out.properties === 'object') {
    if (!('additionalProperties' in out)) out.additionalProperties = false;
  } else if (out.type === 'object' && out.additionalProperties === true) {
    delete out.additionalProperties;
    out.tsType = 'Record<string, unknown>';
  }
  return out;
}

/** The synthetic root: every `$defs` entry, titled by its key, and nothing else. */
function contractsRoot(schema) {
  const defs = schema?.$defs;
  if (!defs || typeof defs !== 'object' || Object.keys(defs).length === 0) fail('has no $defs');
  const prepared = {};
  for (const [key, def] of Object.entries(defs)) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(key)) fail(`$defs key ${JSON.stringify(key)} is not a type name`);
    prepared[key] = { ...prepare(def), title: key };
  }
  return {
    title: ROOT_NAME,
    type: 'object',
    properties: {},
    additionalProperties: false,
    $defs: prepared,
  };
}

/**
 * The TypeScript for a synthetic root (`title: rootName`, its types under `$defs`), with the
 * root's own empty interface and the compiler's note on every unreachable definition dropped:
 * both name the synthetic root and say nothing about the schema. The note is a comment of its
 * own, or the last paragraph of a type's description. gen-api.mjs compiles through this too.
 */
export async function compileDefinitions(root, rootName, bannerComment) {
  const compiled = await compile(root, rootName, { bannerComment, unreachableDefinitions: true, format: true });
  const rootDeclaration = `export interface ${rootName} {}\n`;
  const note = ` \\* This interface was referenced by \`${rootName}\`'s JSON-Schema\\n \\* via the \`definition\` "[A-Za-z0-9]+"\\.\\n`;
  const noteComment = new RegExp(`/\\*\\*\\n${note} \\*/\\n`, 'g');
  const noteParagraph = new RegExp(` \\*\\n${note}`, 'g');
  if (!compiled.includes(rootDeclaration)) throw new Error(`${rootName}: the compiler output changed shape`);
  return compiled.replace(rootDeclaration, '').replace(noteComment, '').replace(noteParagraph, '');
}

/** The contracts.gen.ts text for the parsed contracts schema. */
export async function generateContracts(schema) {
  return compileDefinitions(contractsRoot(schema), ROOT_NAME, BANNER);
}

async function main(args) {
  const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const schemaPath = path.join(web, '..', 'backend', 'desk', 'contracts.schema.json');
  const outPath = path.join(web, 'src', 'api', 'contracts.gen.ts');
  const unknown = args.filter((arg) => arg !== '--check');
  if (unknown.length > 0) {
    console.error(`Unknown argument: ${unknown.join(' ')}. Use --check to verify without writing.`);
    return 2;
  }
  const text = await generateContracts(JSON.parse(readFileSync(schemaPath, 'utf8')));
  if (args.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(outPath, 'utf8');
    } catch {
      // A missing file is stale.
    }
    if (current !== text) {
      console.error('src/api/contracts.gen.ts is out of date with contracts.schema.json. Run `npm run gen:contracts`.');
      return 1;
    }
    console.log('src/api/contracts.gen.ts matches contracts.schema.json.');
    return 0;
  }
  writeFileSync(outPath, text);
  console.log('Wrote src/api/contracts.gen.ts from contracts.schema.json.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
