// @vitest-environment node
// The API type generator (gen-api.mjs) on small documents: the API's own schemas become types,
// contract schemas are imported from contracts.ts instead, and every operation names its 2xx
// schemas. Anything it can't name fails, so a stale or odd document never becomes loose types. The
// command's --check fails when openapi.gen.ts is stale or missing, and writes nothing, and the
// command runs when started through a symlinked path too.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiOperations, generateApi, main } from './gen-api.mjs';

const SCRIPT = fileURLToPath(new URL('./gen-api.mjs', import.meta.url));

/** Every temp folder made by a test, removed after it. */
const made = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
        get: { responses: { 200: json(ref('Thing')), 404: json(ref('ApiError')), default: json(ref('ApiError')) } },
        delete: { responses: { 204: { description: 'Gone' } } },
      },
      '/things': {
        get: { responses: { 200: json({ type: 'array', items: ref('Thing'), title: 'Response List Things' }) } },
        post: { responses: { 201: json(ref('Decision')), 422: json(ref('ApiError')) } },
      },
      '/events': { get: { responses: { 200: { description: 'Events', content: { 'text/event-stream': { schema: {} } } } } } },
      '/slow': { post: { responses: { 200: json(ref('Thing')), 202: json(ref('Item')) } } },
      // Every JSON media type names the model, parameters aside, and a document link's bytes carry none.
      '/problems': {
        get: {
          responses: { 200: both(body('application/json; charset=utf-8', ref('Thing')), body('application/problem+json', ref('Thing'))) },
        },
      },
      '/d/{token}': { get: { responses: { 200: body('application/octet-stream', {}) } } },
    };
    const expected = {
      'GET /things/{id}': { 200: 'Thing' },
      'DELETE /things/{id}': { 204: null },
      'GET /things': { 200: 'Thing[]' },
      'POST /things': { 201: 'Decision' },
      'GET /events': { 200: null },
      'POST /slow': { 200: 'Thing', 202: 'Item' },
      'GET /problems': { 200: 'Thing' },
      'GET /d/{token}': { 200: null },
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
      '  "GET /problems": { 200: "Thing" },',
      '  "GET /d/{token}": { 200: null },',
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
    // A JSON body under another JSON media type is still a JSON body, never one with no model.
    await expect(generate(answering({ 200: body('application/problem+json', { type: 'object' }) }))).rejects.toThrow(
      /GET \/x 200's JSON body names no schema/,
    );
    // JSON bodies that name different models, a JSON body beside one that carries none, and a
    // media type that is neither JSON nor known to carry no model.
    await expect(generate(answering({ 200: both(json(ref('Thing')), body('application/problem+json', ref('Item'))) }))).rejects.toThrow(
      /GET \/x 200's JSON bodies name different schemas: Thing, Item/,
    );
    await expect(generate(answering({ 200: both(json(ref('Thing')), body('text/event-stream', {})) }))).rejects.toThrow(
      /GET \/x 200 answers with a JSON body and with one that carries no model/,
    );
    await expect(generate(answering({ 200: body('image/png', { type: 'string', format: 'binary' }) }))).rejects.toThrow(
      /GET \/x 200 answers "image\/png", which is neither JSON nor a body known to carry no model/,
    );
    // A response only pointed at, which would otherwise read as one with no body.
    await expect(generate(answering({ 200: { $ref: '#/components/responses/Thing' } }))).rejects.toThrow(
      /GET \/x 200 is not an inline response/,
    );
    // A status range beside a single code, which would otherwise drop out of the answers unread,
    await expect(generate(answering({ 200: json(ref('Thing')), '2XX': json(ref('Item')) }))).rejects.toThrow(
      /GET \/x answers "2XX", which is neither a status code nor default/,
    );
    // and any other key that isn't a status code or `default`, a failure range included.
    await expect(generate(answering({ 200: json(ref('Thing')), '4XX': json(ref('Item')) }))).rejects.toThrow(
      /GET \/x answers "4XX", which is neither a status code nor default/,
    );
    // A path item the document only points at, whose operations would otherwise drop out unread.
    const pointed = doc(schemas, { '/x': { get: { responses: { 200: json(ref('Thing')) } } }, '/y': { $ref: '#/components/pathItems/Y' } });
    await expect(generate(pointed)).rejects.toThrow(/path "\/y" points at "#\/components\/pathItems\/Y", which is not read yet/);
    // An operation with no success answer, and a document with no operations or no schemas.
    await expect(generate(answering({ 404: json(ref('Item')) }))).rejects.toThrow(/GET \/x has no 2xx answer/);
    await expect(generate(doc(schemas, {}))).rejects.toThrow(/has no paths/);
    await expect(generate(doc({}))).rejects.toThrow(/has no components\.schemas/);
    // A schema name that isn't a type name, and a contracts schema with nothing in it.
    await expect(generate(doc({ ...schemas, 'Body_x-y': ITEM }))).rejects.toThrow(/"Body_x-y" is not a type name/);
    await expect(generate(doc(schemas), {})).rejects.toThrow(/contracts\.schema\.json: has no \$defs/);
  });

  it('contract_names_keep_the_contract_shape', async () => {
    // A schema under a contract's name with another shape fails, rather than being swapped for the contract.
    const other = { ...CONTRACTS.$defs.Decision, properties: { decision_id: { type: 'integer', title: 'Decision Id' } } };
    await expect(generateApi(doc({ Thing: THING, Item: ITEM, Decision: other }), CONTRACTS)).rejects.toThrow(
      /schema Decision differs from the contract of the same name/,
    );
    // A property named like an annotation is still a property.
    const extra = { ...CONTRACTS.$defs.Decision, properties: { ...CONTRACTS.$defs.Decision.properties, description: { type: 'string' } } };
    await expect(generateApi(doc({ Thing: THING, Item: ITEM, Decision: extra }), CONTRACTS)).rejects.toThrow(
      /schema Decision differs from the contract of the same name/,
    );

    // Titles, descriptions, defaults and how a reference is spelled may differ, a discriminator's
    // mapping included: the shape is the same.
    const review = (score) => ({ type: 'object', properties: { score }, required: [] });
    const choice = (prefix, reviewIs = 'Review') => ({
      oneOf: [{ $ref: `${prefix}Decision` }, { $ref: `${prefix}Review` }],
      discriminator: { propertyName: 'kind', mapping: { decision: `${prefix}Decision`, review: `${prefix}${reviewIs}` } },
    });
    const contracts = {
      $defs: {
        Decision: {
          ...CONTRACTS.$defs.Decision,
          properties: { ...CONTRACTS.$defs.Decision.properties, review: { $ref: '#/$defs/Review' } },
        },
        Review: { ...review({ type: 'number', title: 'Score', default: 0 }), title: 'Review' },
        Choice: choice('#/$defs/'),
      },
    };
    const served = {
      Thing: THING,
      Item: ITEM,
      Decision: {
        ...contracts.$defs.Decision,
        description: 'One decision.',
        properties: { ...contracts.$defs.Decision.properties, review: ref('Review') },
      },
      Review: review({ type: 'number', title: 'How sure', description: 'From 0 to 1.', default: 1 }),
      Choice: choice('#/components/schemas/'),
    };
    const text = await generateApi(doc(served), contracts);
    expect(text).toContain("import type { Decision } from './contracts.ts';");
    expect(text).not.toMatch(/^export (?:interface|type) (?:Decision|Review|Choice)\b/m);
    // A mapping that points at another schema is another shape.
    await expect(generateApi(doc({ ...served, Choice: choice('#/components/schemas/', 'Decision') }), contracts)).rejects.toThrow(
      /schema Choice differs from the contract of the same name/,
    );
  });

  it('command_check_fails_when_stale_or_missing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gen-api-'));
    made.push(dir);
    const paths = {
      openapi: path.join(dir, 'openapi.json'),
      contracts: path.join(dir, 'contracts.schema.json'),
      out: path.join(dir, 'openapi.gen.ts'),
    };
    const schemas = { Thing: THING, Item: ITEM, Decision: CONTRACTS.$defs.Decision };
    writeFileSync(paths.openapi, JSON.stringify(doc(schemas)));
    writeFileSync(paths.contracts, JSON.stringify(CONTRACTS));
    const printed = [];
    vi.spyOn(console, 'log').mockImplementation((line) => printed.push(`log: ${line}`));
    vi.spyOn(console, 'error').mockImplementation((line) => printed.push(`error: ${line}`));
    const stale = 'error: src/api/openapi.gen.ts is out of date with openapi.json. Run `npm run gen:api`.';
    const current = 'log: src/api/openapi.gen.ts matches openapi.json.';

    // A missing file is stale, and the check writes nothing.
    expect(await main(['--check'], paths)).toBe(1);
    expect(existsSync(paths.out)).toBe(false);
    // Once written, it is current.
    expect(await main([], paths)).toBe(0);
    expect(readFileSync(paths.out, 'utf8')).toBe(await generateApi(doc(schemas), CONTRACTS));
    expect(await main(['--check'], paths)).toBe(0);
    // A document that changes without a rerun makes it stale again, and the check leaves it as it was.
    const written = readFileSync(paths.out, 'utf8');
    writeFileSync(paths.openapi, JSON.stringify(doc({ ...schemas, Thing: { ...THING, description: 'A thing, renamed.' } })));
    expect(await main(['--check'], paths)).toBe(1);
    expect(readFileSync(paths.out, 'utf8')).toBe(written);

    expect(printed).toEqual([stale, 'log: Wrote src/api/openapi.gen.ts from openapi.json.', current, stale]);
  });

  it('command_refuses_unknown_arguments', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--chek'], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Unknown argument: --chek. Use --check to verify without writing.');
    expect(run.stdout).not.toContain('Wrote');
  });

  it('command_runs_through_a_symlinked_path', () => {
    // Run from a folder that links to scripts/, the command still runs rather than doing nothing.
    const dir = mkdtempSync(path.join(tmpdir(), 'gen-api-link-'));
    made.push(dir);
    symlinkSync(path.dirname(SCRIPT), path.join(dir, 'scripts'), 'dir');
    const run = spawnSync(process.execPath, [path.join(dir, 'scripts', 'gen-api.mjs'), '--chek'], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Unknown argument: --chek.');
  });
});

/** A response whose JSON body is `schema`. */
function json(schema) {
  return body('application/json', schema);
}

/** A response whose one body, of `mediaType`, is `schema`. */
function body(mediaType, schema) {
  return { description: 'Successful Response', content: { [mediaType]: { schema } } };
}

/** A response with the bodies of both `one` and `other`. */
function both(one, other) {
  return { description: 'Successful Response', content: { ...one.content, ...other.content } };
}
