// @vitest-environment node
/**
 * The thin slice's routes against the API's own OpenAPI document (`backend/desk/api/openapi.json`,
 * the API core plan's): every route the first visit, Today with its briefing, the public page and
 * Safety call has its method and path there, as `ROUTES` writes them. Skipped, with a message,
 * while the document is absent. The adoption of the generated client (Task 16) widens this to
 * every key.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ROUTES, type RouteKey } from './routes.ts';

const OPENAPI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../backend/desk/api/openapi.json');

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
  it('thin_slice_routes_exist', (ctx) => {
    ctx.skip(
      !existsSync(OPENAPI_PATH),
      'backend/desk/api/openapi.json is absent: the thin slice routes are checked once the API core (plan 02a) is on this branch',
    );
    const api = served(JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')));
    const route = (key: RouteKey) => `${ROUTES[key].method} ${ROUTES[key].path}`;
    const missing = THIN_SLICE_CALLS.filter((key) => !FROM_PLAN_02B.has(key) && !api.has(route(key))).map((key) => `${route(key)} (${key})`);
    expect(missing, 'routes the web calls that the API does not serve').toEqual([]);
  });
});
