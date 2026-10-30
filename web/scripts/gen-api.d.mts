// Types for gen-api.mjs, so TypeScript callers (the route contract test) get a checked signature.

/** Each 2xx status code of an operation, with the schema name its answer carries (null: no JSON body). */
export type OperationAnswers = Record<string, string | null>;

/** The openapi.gen.ts text for the parsed OpenAPI document and contracts schema; throws on one it can't name. */
export function generateApi(openapi: unknown, contracts: unknown): Promise<string>;

/** Every operation in the document's `paths`, keyed "METHOD /path", with its 2xx answers. */
export function apiOperations(openapi: unknown): Record<string, OperationAnswers>;
