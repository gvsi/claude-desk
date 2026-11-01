import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, test } from 'vitest';

import { generateContracts } from '../../scripts/gen-contracts.mjs';
import { CLAUSE_TEMPLATES, DECISION_STATES, EV_ERROR_CODES, KERNEL_ERROR_CODES } from './contracts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(here, '..', '..', '..', 'backend', 'desk', 'contracts.schema.json');
const GENERATED_PATH = path.join(here, 'contracts.gen.ts');

type FieldSchema = { enum?: string[]; anyOf?: FieldSchema[] };

const schemaText = readFileSync(SCHEMA_PATH, 'utf8');
const schema = JSON.parse(schemaText) as {
  $defs: Record<string, { properties?: Record<string, FieldSchema> }>;
};
const generated = readFileSync(GENERATED_PATH, 'utf8');

/** The string enum of a model's field, also when the field is nullable (`anyOf` with null). */
function schemaEnum(model: string, field: string): string[] {
  const schemaOfField = schema.$defs[model]?.properties?.[field];
  const values = schemaOfField?.enum ?? schemaOfField?.anyOf?.find((option) => option.enum)?.enum;
  if (!values) throw new Error(`contracts.schema.json has no enum at ${model}.${field}`);
  return values;
}

/** The constant lists each schema value exactly once, in any order. */
function expectSameMembers(constant: readonly string[], expected: readonly string[]) {
  expect(constant.length, 'no value is listed twice').toBe(new Set(constant).size);
  expect([...constant].sort()).toEqual([...expected].sort());
}

/** The body of `export interface <name> { … }` in the generated file ('' when empty), or null. */
function interfaceBody(name: string): string | null {
  const match = new RegExp(`^export interface ${name} \\{(?:\\}$|\\n([\\s\\S]*?)^\\})`, 'm').exec(generated);
  return match ? (match[1] ?? '') : null;
}

describe('contract types', () => {
  test('contract_types_are_current', async () => {
    expect(await generateContracts(JSON.parse(schemaText))).toBe(generated);
  });

  test('generated_types_are_closed', () => {
    expect(generated).not.toContain('[k: string]: unknown');
    expect(generated).not.toMatch(/^export type \w+\d+ =/m);
    expect(generated).not.toMatch(/^export interface \w+\d+ /m);
    // Every model is its own interface, and none carries an index signature of its own
    // (a dictionary field such as PublicDesk.brand is indented one level deeper).
    const models = Object.entries(schema.$defs).filter(([, def]) => def.properties !== undefined);
    expect(models.length).toBeGreaterThan(90);
    for (const [name] of models) {
      const body = interfaceBody(name);
      expect(body, `${name} is generated as an interface`).not.toBeNull();
      expect(body, `${name} has no index signature`).not.toMatch(/^ {2}\[/m);
    }
  });

  test('clause_templates_match_the_schema', () => {
    expectSameMembers(CLAUSE_TEMPLATES, schemaEnum('RenderedBlock', 'template'));
  });

  test('decision_states_match_the_schema', () => {
    expectSameMembers(DECISION_STATES, schemaEnum('Decision', 'state'));
  });

  test('kernel_error_codes_match_the_schema', () => {
    expectSameMembers(KERNEL_ERROR_CODES, schemaEnum('KernelError', 'code'));
  });

  test('kernel_error_detail_contains_only_field_and_rule_identifiers', () => {
    const kernelError = schema.$defs.KernelError;
    if (!kernelError) throw new Error('contracts.schema.json has no KernelError');
    const validate = new Ajv2020({ strict: false }).compile(kernelError);
    expect(validate({ code: 'invalid', detail: {
      'desk.x.title': ['public_promise', 'format_control'],
      'charter:policy:service_area': ['lex.en.promise'],
    } })).toBe(true);
    for (const detail of [
      { 'A visitor wrote this': ['public_promise'] },
      { 'desk.x.title': ['This text is a promise'] },
      { ['x'.repeat(121)]: ['public_promise'] },
      { 'desk.x.title': ['x'.repeat(65)] },
    ]) expect(validate({ code: 'invalid', detail })).toBe(false);
  });

  test('ev_error_codes_match_the_schema', () => {
    expectSameMembers(EV_ERROR_CODES, schemaEnum('EvError', 'code'));
  });
});
