// Types for gen-contracts.mjs, so TypeScript callers (the contract tests) get a checked signature.

/** The contracts.gen.ts text for the parsed contracts schema; throws on a schema it can't name. */
export function generateContracts(schema: unknown): Promise<string>;
