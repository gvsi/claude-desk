/**
 * Checks a mock payload against the shared contracts (`backend/desk/contracts.schema.json`), so the
 * mock API can't drift from what the kernel and API send. Each model is read from the schema's
 * `$defs` by its key. Models are checked as the API's Pydantic models serialize them: every field
 * they declare, defaulted ones included, and nothing else, so a mock that leaves a field out or
 * adds one is wrong. The one exception is a field the contracts mark `x-omitted-when-default`, which
 * its model leaves out while it holds its default (a turn end's `generation`): it may be absent.
 */
import Ajv2020 from 'ajv/dist/2020.js';

import schema from '../../../backend/desk/contracts.schema.json';

const SCHEMA_ID = 'contracts.schema.json';

/** RFC 3339 date-time with a time zone, as Pydantic writes an aware datetime. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
/** A time of day, as Pydantic writes `datetime.time`. */
const TIME = /^\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const mapValues = (record: Record<string, unknown>, fn: (value: unknown) => unknown): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fn(value)]));

/** A field its model leaves out while it holds its default, as the contracts mark it. */
const omittedWhenDefault = (property: unknown): boolean => isRecord(property) && property['x-omitted-when-default'] === true;

/**
 * A copy of a schema node in which every object model sends exactly its fields: each one required,
 * defaults included, but those the contracts mark as left out while they hold their default; and none
 * it doesn't declare (unless it sets its own `additionalProperties`).
 */
function closed(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(closed);
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    // `properties` maps field names to schemas: close each schema, never the map itself.
    out[key] = key === 'properties' && isRecord(value) ? mapValues(value, closed) : closed(value);
  }
  if (isRecord(out.properties)) {
    if (!('additionalProperties' in out)) out.additionalProperties = false;
    const properties = out.properties;
    out.required = Object.keys(properties).filter((key) => !omittedWhenDefault(properties[key]));
  }
  return out;
}

/**
 * Fields the web types by hand ahead of the contracts (`api/views.ts`), by model, each with its own
 * shape: the mock sends them, so they are checked here until `contracts.schema.json` has them, and
 * then their entry goes (`pending_fields_wait_for_the_contracts`).
 */
export const PENDING_FIELDS: Readonly<Record<string, Readonly<Record<string, object>>>> = {};

/** The schema with each pending field added to its model; a field the schema already has is left as the schema says. */
function withPending(contracts: typeof schema): unknown {
  const defs: Record<string, unknown> = { ...contracts.$defs };
  for (const [model, fields] of Object.entries(PENDING_FIELDS)) {
    const def = defs[model];
    if (!isRecord(def)) throw new Error(`a pending field names ${model}, which the contracts don't have`);
    const properties = isRecord(def.properties) ? def.properties : {};
    defs[model] = { ...def, properties: { ...fields, ...properties } };
  }
  return { ...contracts, $defs: defs };
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat('date-time', DATE_TIME);
ajv.addFormat('time', TIME);
ajv.addSchema(closed(withPending(schema)) as object, SCHEMA_ID);

/** Every way `value` breaks the contract `model` (a `$defs` key), one line each; empty when it fits. */
export function validateContract(model: string, value: unknown): string[] {
  const validate = Object.hasOwn(schema.$defs, model) ? ajv.getSchema(`${SCHEMA_ID}#/$defs/${model}`) : undefined;
  if (!validate) return [`${model}: the contracts have no such model`];
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => {
    const extra = error.keyword === 'additionalProperties' ? ` (${String(error.params.additionalProperty)})` : '';
    return `${model}${error.instancePath || '/'} ${error.message ?? 'is invalid'}${extra}`;
  });
}
