/**
 * Checks a mock payload against the shared contracts (`backend/desk/contracts.schema.json`), so the
 * mock API can't drift from what the kernel and API send. Each model is read from the schema's
 * `$defs` by its key. Models are closed as the generated types are: the API's Pydantic models
 * never send a field they don't declare, so a mock that does is wrong.
 */
import Ajv2020 from 'ajv/dist/2020.js';

import schema from '../../../backend/desk/contracts.schema.json';

const SCHEMA_ID = 'contracts.schema.json';

/** RFC 3339 date-time with a time zone, as Pydantic writes an aware datetime. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
/** A time of day, as Pydantic writes `datetime.time`. */
const TIME = /^\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;

/** A copy of a schema node in which every object model without its own `additionalProperties` is closed. */
function closed(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(closed);
  if (typeof node !== 'object' || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) out[key] = closed(value);
  if ('properties' in out && !('additionalProperties' in out)) out.additionalProperties = false;
  return out;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat('date-time', DATE_TIME);
ajv.addFormat('time', TIME);
ajv.addSchema(closed(schema) as object, SCHEMA_ID);

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
