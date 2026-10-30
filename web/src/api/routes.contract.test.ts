// @vitest-environment node
/**
 * The web's route table against the API's own OpenAPI document (`backend/desk/api/openapi.json`,
 * the API core plan's), never skipped:
 * - `openapi.gen.ts` is what `npm run gen:api` makes of the document as it stands, so a change to
 *   the document without regenerating fails here, in CI's web tests too.
 * - Every `ROUTES` method and path is in the document, and each of its 2xx answers names the model
 *   in `ROUTE_MODELS`, apart from the routes in `NOT_YET_SERVED`, which must still be missing, so
 *   that list only shrinks. routes.typecheck.ts makes the same checks at compile time against
 *   `API_OPERATIONS`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { apiOperations, generateApi, type OperationAnswers } from '../../scripts/gen-api.mjs';
import { ROUTES, type RouteKey, type RouteSpec } from './routes.ts';
import { NOT_YET_SERVED, ROUTE_MODELS } from './routes.typecheck.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = path.resolve(here, '../../../backend/desk/api/openapi.json');
const CONTRACTS_PATH = path.resolve(here, '../../../backend/desk/contracts.schema.json');
const GENERATED_PATH = path.join(here, 'openapi.gen.ts');

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

/**
 * What is wrong with each route in `keys` against `operations` (from `apiOperations`), as
 * sentences: a pending route the document serves, a served route it lacks, and a 2xx answer that
 * doesn't name the route's model (a proving route's 202 retry aside).
 */
function routeProblems(
  operations: Record<string, OperationAnswers>,
  pending: ReadonlySet<RouteKey>,
  keys: readonly RouteKey[],
): string[] {
  const problems: string[] = [];
  for (const key of keys) {
    const route: RouteSpec = ROUTES[key];
    const operation = `${route.method} ${route.path}`;
    const answers = operations[operation];
    if (pending.has(key)) {
      if (answers) problems.push(`${key}: ${operation} is served now; take it off NOT_YET_SERVED`);
      continue;
    }
    if (!answers) {
      problems.push(`${key}: ${operation} is not in openapi.json`);
      continue;
    }
    for (const [status, name] of Object.entries(answers)) {
      // A proving route's 202 is the proving protocol's retry, which `request()` follows.
      if (route.proving && status === '202' && name === 'ProvingPending') continue;
      if (name !== ROUTE_MODELS[key]) problems.push(`${key}: ${operation} answers ${status} with ${name}, not ${ROUTE_MODELS[key]}`);
    }
  }
  return problems;
}

describe('routes against the API contract', () => {
  it('api_types_are_current', async () => {
    expect(existsSync(GENERATED_PATH), 'src/api/openapi.gen.ts exists: run `npm run gen:api`').toBe(true);
    expect(await generateApi(readJson(OPENAPI_PATH), readJson(CONTRACTS_PATH)), 'openapi.gen.ts is current: run `npm run gen:api`').toBe(
      readFileSync(GENERATED_PATH, 'utf8'),
    );
  });

  it('every_route_exists_in_openapi', () => {
    const pending: ReadonlySet<RouteKey> = new Set(NOT_YET_SERVED);
    const problems = routeProblems(apiOperations(readJson(OPENAPI_PATH)), pending, Object.keys(ROUTES) as RouteKey[]);
    expect(problems, 'routes the web calls that the API serves differently, or not at all').toEqual([]);
    // Not everything is pending: the check reads real answers for at least the thin slice's 20 served routes.
    expect(Object.keys(ROUTES).length - pending.size).toBeGreaterThanOrEqual(20);
  });

  it('route_check_reads_each_answer', () => {
    const op = (key: RouteKey) => `${ROUTES[key].method} ${ROUTES[key].path}`;
    const keys: RouteKey[] = ['today', 'draftRules', 'sendMessage', 'me', 'health'];
    const operations: Record<string, OperationAnswers> = {
      [op('today')]: { 200: 'Today' },
      // A proving route's 202 is the retry; any other 2xx must name its model.
      [op('draftRules')]: { 200: 'RulesDraft', 202: 'ProvingPending' },
      [op('sendMessage')]: { 202: 'MessageAccepted' },
      [op('me')]: { 200: 'CopyOut', 202: 'ProvingPending' },
    };
    expect(routeProblems(operations, new Set(['health']), keys)).toEqual(['me: GET /api/owner/me answers 202 with ProvingPending, not CopyOut']);
    // A pending route the document serves, and a served route it lacks, are problems too.
    expect(routeProblems({ ...operations, [op('health')]: { 200: 'HealthOut' } }, new Set(['health']), ['health'])).toEqual([
      'health: GET /api/health is served now; take it off NOT_YET_SERVED',
    ]);
    expect(routeProblems({}, new Set(), ['today'])).toEqual(['today: GET /api/owner/desks/{desk_id}/today is not in openapi.json']);
  });
});
