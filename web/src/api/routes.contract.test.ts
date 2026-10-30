// @vitest-environment node
/**
 * The web's route table against the API's own OpenAPI document (`backend/desk/api/openapi.json`,
 * the API core plan's), never skipped:
 * - `openapi.gen.ts` is what `npm run gen:api` makes of the document as it stands, so a change to
 *   the document without regenerating fails here, in CI's web tests too.
 * - The thin slice's routes (Tasks 1–6) have their method and path there, as `ROUTES` writes them.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { generateApi } from '../../scripts/gen-api.mjs';
import { ROUTES, type RouteKey } from './routes.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = path.resolve(here, '../../../backend/desk/api/openapi.json');
const CONTRACTS_PATH = path.resolve(here, '../../../backend/desk/contracts.schema.json');
const GENERATED_PATH = path.join(here, 'openapi.gen.ts');

/** Every route the thin slice's screens call (Tasks 1–6), by key. */
const THIN_SLICE_CALLS = [
  // The first visit and the owner shell
  'copies',
  'me',
  'desks',
  'startOver',
  'setAnswering',
  // Today, its full briefing and its held requests
  'today',
  'briefing',
  'needsYou',
  'answer',
  'draftRules',
  'conversation',
  'takeover',
  'handoffDone',
  // The public page
  'publicDesk',
  'openSession',
  'openPreview',
  'visitorSession',
  'sendMessage',
  'events',
  'cancelRequest',
  // Safety
  'safety',
  'ledger',
  'health',
] as const satisfies readonly RouteKey[];

/**
 * Routes the thin slice calls that the API's owner, setup and agents plan (02b) adds. The screens
 * get by without them until then: a failed preview opens a visitor's chat, a failed rule draft and
 * a failed take-over say so.
 */
const FROM_PLAN_02B: ReadonlySet<RouteKey> = new Set(['openPreview', 'draftRules', 'takeover']);

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'] as const;

/** Each "METHOD /path" the document serves. */
function served(doc: unknown): Set<string> {
  const paths = (doc as { paths?: unknown }).paths;
  if (paths === null || typeof paths !== 'object') throw new Error(`${OPENAPI_PATH} has no paths`);
  const out = new Set<string>();
  for (const [route, item] of Object.entries(paths)) {
    for (const method of METHODS) {
      if (item !== null && typeof item === 'object' && method in item) out.add(`${method.toUpperCase()} ${route}`);
    }
  }
  return out;
}

describe('routes against the API contract', () => {
  it('api_types_are_current', async () => {
    expect(existsSync(GENERATED_PATH), 'src/api/openapi.gen.ts exists: run `npm run gen:api`').toBe(true);
    const openapi: unknown = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8'));
    const contracts: unknown = JSON.parse(readFileSync(CONTRACTS_PATH, 'utf8'));
    expect(await generateApi(openapi, contracts), 'openapi.gen.ts is current: run `npm run gen:api`').toBe(
      readFileSync(GENERATED_PATH, 'utf8'),
    );
  });

  it('thin_slice_routes_exist', () => {
    const api = served(JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')));
    const route = (key: RouteKey) => `${ROUTES[key].method} ${ROUTES[key].path}`;
    const missing = THIN_SLICE_CALLS.filter((key) => !FROM_PLAN_02B.has(key) && !api.has(route(key))).map((key) => `${route(key)} (${key})`);
    expect(missing, 'routes the web calls that the API does not serve').toEqual([]);
  });
});
