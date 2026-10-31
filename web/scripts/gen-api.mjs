#!/usr/bin/env node
// Generates src/api/openapi.gen.ts from backend/desk/api/openapi.json, the API's own OpenAPI
// document: the API-owned schemas as types, and API_OPERATIONS, every path and method the API
// serves with the schema each 2xx answer names. Contract schemas (the `$defs` keys of
// backend/desk/contracts.schema.json) are imported from src/api/contracts.ts, their one import
// path, and never redefined here. The web owns its client (`ROUTES` and `request()`); this output
// only checks the route table and types the API's shapes.
//   node scripts/gen-api.mjs          write openapi.gen.ts
//   node scripts/gen-api.mjs --check  exit 1 if openapi.gen.ts is stale

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { compileDefinitions, prepare } from './gen-contracts.mjs';

const ROOT_NAME = 'ApiSchema';
const SCHEMA_REF = /^#\/components\/schemas\/(.+)$/;
const TYPE_NAME = /^[A-Z][A-Za-z0-9]*$/;

const BANNER = [
  '// API types, generated, do not edit.',
  '// Source: backend/desk/api/openapi.json. Run `npm run gen:api` after it changes.',
  '// Only the API-owned schemas are here; contract types come from src/api/contracts.ts.',
].join('\n');

function fail(message) {
  throw new Error(`openapi.json: ${message}`);
}

/** The schema name a `$ref` points at; anything but a component schema fails. */
function refName(ref) {
  const match = typeof ref === 'string' ? SCHEMA_REF.exec(ref) : null;
  if (!match) fail(`$ref ${JSON.stringify(ref)} is not a component schema`);
  return match[1];
}

/** The document's component schemas, split into the API's own and the contracts it serves. */
function splitSchemas(openapi, contracts) {
  const schemas = openapi?.components?.schemas;
  if (!schemas || typeof schemas !== 'object' || Object.keys(schemas).length === 0) fail('has no components.schemas');
  const defs = contracts?.$defs;
  if (!defs || typeof defs !== 'object') throw new Error('contracts.schema.json: has no $defs');
  const contractNames = new Set(Object.keys(defs));
  const own = {};
  for (const [name, schema] of Object.entries(schemas)) {
    if (!TYPE_NAME.test(name)) fail(`schema ${JSON.stringify(name)} is not a type name`);
    if (!contractNames.has(name)) own[name] = schema;
  }
  return { schemas, own, contractNames };
}

/**
 * A prepared schema with every `$ref` resolved for the compiler: one to an API-owned schema points
 * at its `$defs` entry, one to a contract becomes that contract's type name (added to `imports`).
 */
function linkRefs(node, own, contractNames, imports) {
  if (Array.isArray(node)) return node.map((item) => linkRefs(item, own, contractNames, imports));
  if (node === null || typeof node !== 'object') return node;
  if ('$ref' in node) {
    const name = refName(node.$ref);
    if (name in own) return { ...node, $ref: `#/$defs/${name}` };
    if (contractNames.has(name)) {
      imports.add(name);
      return { tsType: name };
    }
    fail(`$ref to ${name}, which is not in components.schemas`);
  }
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] =
      key === 'properties'
        ? Object.fromEntries(Object.entries(value).map(([field, schema]) => [field, linkRefs(schema, own, contractNames, imports)]))
        : linkRefs(value, own, contractNames, imports);
  }
  return out;
}

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']);

/**
 * The schema name a 2xx answer carries: its JSON body's component schema, `Name[]` for a list of
 * one, or null when it has no JSON body (a 204, the SSE stream). Any other JSON body names no
 * model and fails, as does a response the document only points at.
 */
function responseName(response, where, schemas) {
  if (response === null || typeof response !== 'object' || '$ref' in response) fail(`${where} is not an inline response`);
  const body = response.content?.['application/json'];
  if (body === undefined) return null;
  const schema = body.schema;
  const named = (node) => {
    const name = refName(node.$ref);
    if (!(name in schemas)) fail(`${where} names ${name}, which is not in components.schemas`);
    return name;
  };
  if (schema && typeof schema.$ref === 'string') return named(schema);
  if (schema?.type === 'array' && schema.items && typeof schema.items.$ref === 'string') return `${named(schema.items)}[]`;
  fail(`${where}'s JSON body names no schema`);
}

/** A single status code, the only response key besides `default` this generator reads. */
const STATUS_CODE = /^[1-5]\d\d$/;

/**
 * Every operation in `paths`, keyed "METHOD /path" in the document's order, with the schema name
 * of each of its 2xx answers by status code. An operation with no 2xx answer fails, as does a
 * response key that is neither a status code nor `default`, such as the range `2XX`, which would
 * otherwise drop out unread.
 */
export function apiOperations(openapi) {
  const paths = openapi?.paths;
  const schemas = openapi?.components?.schemas ?? {};
  if (!paths || typeof paths !== 'object' || Object.keys(paths).length === 0) fail('has no paths');
  const operations = {};
  for (const [route, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      if (!HTTP_METHODS.has(method)) continue;
      const key = `${method.toUpperCase()} ${route}`;
      const answers = {};
      for (const [status, response] of Object.entries(operation?.responses ?? {})) {
        if (status === 'default') continue;
        if (!STATUS_CODE.test(status)) fail(`${key} answers ${JSON.stringify(status)}, which is neither a status code nor default`);
        if (status.startsWith('2')) answers[status] = responseName(response, `${key} ${status}`, schemas);
      }
      if (Object.keys(answers).length === 0) fail(`${key} has no 2xx answer`);
      operations[key] = answers;
    }
  }
  return operations;
}

/** API_OPERATIONS as TypeScript: one operation a line, status codes as numeric keys. */
function operationsSource(operations) {
  const lines = Object.entries(operations).map(([key, answers]) => {
    const fields = Object.entries(answers).map(([status, name]) => `${status}: ${JSON.stringify(name)}`);
    return `  ${JSON.stringify(key)}: { ${fields.join(', ')} },`;
  });
  return [
    '/**',
    ' * Every operation the API serves, as "METHOD /path", with the schema each 2xx answer carries by',
    ' * status code: `Name[]` for a list, null for an answer with no JSON body. routes.typecheck.ts',
    ' * checks the route table against it.',
    ' */',
    'export const API_OPERATIONS = {',
    ...lines,
    '} as const;',
    '',
  ].join('\n');
}

/** The openapi.gen.ts text for the parsed OpenAPI document and contracts schema. */
export async function generateApi(openapi, contracts) {
  const { own, contractNames } = splitSchemas(openapi, contracts);
  const operations = apiOperations(openapi);
  const imports = new Set();
  const defs = {};
  for (const [name, schema] of Object.entries(own)) {
    defs[name] = { ...linkRefs(prepare(schema), own, contractNames, imports), title: name };
  }
  const root = { title: ROOT_NAME, type: 'object', properties: {}, additionalProperties: false, $defs: defs };
  const types = await compileDefinitions(root, ROOT_NAME, '');
  const importLine = imports.size > 0 ? `import type { ${[...imports].sort().join(', ')} } from './contracts.ts';\n\n` : '';
  return `${BANNER}\n\n${importLine}${types.trimStart()}\n${operationsSource(operations)}`;
}

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What the command reads and writes: the API's document, the contracts schema and openapi.gen.ts. */
const PATHS = {
  openapi: path.join(WEB, '..', 'backend', 'desk', 'api', 'openapi.json'),
  contracts: path.join(WEB, '..', 'backend', 'desk', 'contracts.schema.json'),
  out: path.join(WEB, 'src', 'api', 'openapi.gen.ts'),
};

/**
 * The command: writes openapi.gen.ts, or with --check only compares it. Returns the exit code: 1
 * when the file is stale or missing, 2 on an unknown argument. Tests point `paths` at a temp folder.
 */
export async function main(args, paths = PATHS) {
  const unknown = args.filter((arg) => arg !== '--check');
  if (unknown.length > 0) {
    console.error(`Unknown argument: ${unknown.join(' ')}. Use --check to verify without writing.`);
    return 2;
  }
  const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const text = await generateApi(read(paths.openapi), read(paths.contracts));
  if (args.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(paths.out, 'utf8');
    } catch {
      // A missing file is stale.
    }
    if (current !== text) {
      console.error('src/api/openapi.gen.ts is out of date with openapi.json. Run `npm run gen:api`.');
      return 1;
    }
    console.log('src/api/openapi.gen.ts matches openapi.json.');
    return 0;
  }
  writeFileSync(paths.out, text);
  console.log('Wrote src/api/openapi.gen.ts from openapi.json.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
