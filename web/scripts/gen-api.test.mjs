// @vitest-environment node
// The API type generator (gen-api.mjs) on small documents: the API's own schemas become types,
// contract schemas are imported from contracts.ts instead, and every operation names its 2xx
// schemas. Anything it can't name fails, so a stale or odd document never becomes loose types.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { apiOperations, generateApi } from './gen-api.mjs';

const SCRIPT = fileURLToPath(new URL('./gen-api.mjs', import.meta.url));

/** A contracts schema with one model, `Decision`. */
const CONTRACTS = {
  $defs: {
    Decision: {
      type: 'object',
      title: 'Decision',
      properties: { decision_id: { type: 'string', title: 'Decision Id' } },
      required: ['decision_id'],
    },
  },
};

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

/** An OpenAPI document with `components.schemas` as given, and `paths` (by default one read of a Thing). */
function doc(schemas, paths = { '/things/{id}': { get: { responses: { 200: json(ref('Thing')) } } } }) {
  return { openapi: '3.1.0', info: { title: 'Test', version: '0' }, paths, components: { schemas } };
}

const ITEM = {
  type: 'object',
  title: 'Item',
  properties: { n: { type: 'integer', title: 'N' } },
  required: ['n'],
};

const THING = {
  type: 'object',
  title: 'Thing',
  description: 'A thing the API owns.',
  properties: {
    id: { type: 'string', title: 'Id' },
    decision: { anyOf: [ref('Decision'), { type: 'null' }] },
    items: { type: 'array', items: ref('Item'), title: 'Items' },
  },
  required: ['id', 'decision', 'items'],
};

describe('gen-api', () => {
  it('api_schemas_become_types_and_contracts_are_imported', async () => {
    const text = await generateApi(doc({ Thing: THING, Item: ITEM, Decision: CONTRACTS.$defs.Decision }), CONTRACTS);

    expect(text).toContain("import type { Decision } from './contracts.ts';");
    expect(text).toMatch(/^export interface Thing \{$/m);
    expect(text).toMatch(/^ {2}decision: Decision \| null;$/m);
    expect(text).toMatch(/^ {2}items: Item\[\];$/m);
    expect(text).toMatch(/^export interface Item \{$/m);
    // A contract is never redefined here: its one import path is contracts.ts.
    expect(text).not.toMatch(/^export (?:interface|type) Decision\b/m);
    // Field titles name no types of their own.
    expect(text).not.toMatch(/^export type (?:Id|Items|N)\b/m);
    // A schema's description stays its doc comment, without the compiler's note on the synthetic root.
    expect(text).toContain('/**\n * A thing the API owns.\n */\nexport interface Thing {');
    expect(text).not.toContain('referenced by');
  });

  it('api_operations_name_each_2xx_schema', async () => {
    const schemas = { Thing: THING, Item: ITEM, Decision: CONTRACTS.$defs.Decision, ApiError: ITEM };
    const paths = {
      '/things/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: { responses: { 200: json(ref('Thing')), 404: json(ref('ApiError')) } },
        delete: { responses: { 204: { description: 'Gone' } } },
      },
      '/things': {
        get: { responses: { 200: json({ type: 'array', items: ref('Thing'), title: 'Response List Things' }) } },
        post: { responses: { 201: json(ref('Decision')), 422: json(ref('ApiError')) } },
      },
      '/events': { get: { responses: { 200: { description: 'Events', content: { 'text/event-stream': { schema: {} } } } } } },
      '/slow': { post: { responses: { 200: json(ref('Thing')), 202: json(ref('Item')) } } },
    };
    const expected = {
      'GET /things/{id}': { 200: 'Thing' },
      'DELETE /things/{id}': { 204: null },
      'GET /things': { 200: 'Thing[]' },
      'POST /things': { 201: 'Decision' },
      'GET /events': { 200: null },
      'POST /slow': { 200: 'Thing', 202: 'Item' },
    };
    expect(apiOperations(doc(schemas, paths))).toEqual(expected);

    const text = await generateApi(doc(schemas, paths), CONTRACTS);
    const table = /^export const API_OPERATIONS = \{\n([\s\S]*?)^\} as const;$/m.exec(text);
    expect(table, 'API_OPERATIONS is exported as a const').not.toBeNull();
    expect(table[1].split('\n').filter(Boolean)).toEqual([
      '  "GET /things/{id}": { 200: "Thing" },',
      '  "DELETE /things/{id}": { 204: null },',
      '  "GET /things": { 200: "Thing[]" },',
      '  "POST /things": { 201: "Decision" },',
      '  "GET /events": { 200: null },',
      '  "POST /slow": { 200: "Thing", 202: "Item" },',
    ]);
  });

  it('documents_it_cannot_name_fail', async () => {
    const schemas = { Thing: THING, Item: ITEM, Decision: CONTRACTS.$defs.Decision };
    const generate = (openapi, contracts = CONTRACTS) => generateApi(openapi, contracts);
    const answering = (responses) => doc(schemas, { '/x': { get: { responses } } });

    // A schema that points at one the document doesn't have.
    await expect(generate(doc({ ...schemas, Thing: { ...THING, properties: { ghost: ref('Ghost') } } }))).rejects.toThrow(
      /Ghost, which is not in components\.schemas/,
    );
    // A 2xx body that names no one model, or a model the document doesn't have.
    await expect(generate(answering({ 200: json({ anyOf: [ref('Thing'), ref('Item')] }) }))).rejects.toThrow(
      /GET \/x 200's JSON body names no schema/,
    );
    await expect(generate(answering({ 200: json(ref('Ghost')) }))).rejects.toThrow(/GET \/x 200 names Ghost/);
    // A response only pointed at, which would otherwise read as one with no body.
    await expect(generate(answering({ 200: { $ref: '#/components/responses/Thing' } }))).rejects.toThrow(
      /GET \/x 200 is not an inline response/,
    );
    // An operation with no success answer, and a document with no operations or no schemas.
    await expect(generate(answering({ 404: json(ref('Item')) }))).rejects.toThrow(/GET \/x has no 2xx answer/);
    await expect(generate(doc(schemas, {}))).rejects.toThrow(/has no paths/);
    await expect(generate(doc({}))).rejects.toThrow(/has no components\.schemas/);
    // A schema name that isn't a type name, and a contracts schema with nothing in it.
    await expect(generate(doc({ ...schemas, 'Body_x-y': ITEM }))).rejects.toThrow(/"Body_x-y" is not a type name/);
    await expect(generate(doc(schemas), {})).rejects.toThrow(/contracts\.schema\.json: has no \$defs/);
  });

  it('command_refuses_unknown_arguments', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--chek'], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Unknown argument: --chek. Use --check to verify without writing.');
    expect(run.stdout).not.toContain('Wrote');
  });
});

/** A response whose JSON body is `schema`. */
function json(schema) {
  return { description: 'Successful Response', content: { 'application/json': { schema } } };
}
