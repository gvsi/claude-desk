// @vitest-environment node
/**
 * The web's route table against the API's own OpenAPI document (`backend/desk/api/openapi.json`,
 * the API core plan's), never skipped:
 * - `openapi.gen.ts` is what `npm run gen:api` makes of the document as it stands, so a change to
 *   the document without regenerating fails here, in CI's web tests too.
 * - Every `ROUTES` method and path is in the document, and each of its 2xx answers names the model
 *   in `ROUTE_MODELS` (but a proving route's 202, which must be the retry, `ProvingPending`),
 *   apart from the routes in `NOT_YET_SERVED`, which must still be missing, so that list only
 *   shrinks.
 * - Every operation in the document is some route's, apart from those on `NEVER_CALLED`, so a route
 *   the API serves under another path or method fails here rather than staying pending.
 * routes.typecheck.ts makes the same checks at compile time against `API_OPERATIONS`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { apiOperations, generateApi, type OperationAnswers } from '../../scripts/gen-api.mjs';
import { ROUTES, type RouteKey, type RouteSpec } from './routes.ts';
import { NEVER_CALLED, NOT_YET_SERVED, ROUTE_MODELS } from './routes.typecheck.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = path.resolve(here, '../../../backend/desk/api/openapi.json');
const CONTRACTS_PATH = path.resolve(here, '../../../backend/desk/contracts.schema.json');
const GENERATED_PATH = path.join(here, 'openapi.gen.ts');

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

/** A route's operation key, "METHOD /path", as `apiOperations` keys it. */
const op = (key: RouteKey) => `${ROUTES[key].method} ${ROUTES[key].path}`;

/**
 * What is wrong with the routes in `keys` against `operations` (from `apiOperations`), as
 * sentences: a pending route the document serves, a served route it lacks, a proving route's 202
 * that isn't the retry (`ProvingPending`), a route with no final answer besides that 202, a final
 * 2xx answer that doesn't name the route's model, an operation that none of the routes calls and
 * `neverCalled` doesn't list (such as one the API serves under another path or method), and a
 * listed operation that a route calls or the document doesn't serve.
 */
function routeProblems(
  operations: Record<string, OperationAnswers>,
  pending: ReadonlySet<RouteKey>,
  keys: readonly RouteKey[],
  neverCalled: ReadonlySet<string> = new Set(),
): string[] {
  const problems: string[] = [];
  const called = new Set(keys.map(op));
  for (const key of keys) {
    const route: RouteSpec = ROUTES[key];
    const operation = op(key);
    const answers = operations[operation];
    if (pending.has(key)) {
      if (answers) problems.push(`${key}: ${operation} is served now; take it off NOT_YET_SERVED`);
      continue;
    }
    if (!answers) {
      problems.push(`${key}: ${operation} is not in openapi.json`);
      continue;
    }
    // A proving route's 202 is the proving protocol's retry, which `request()` follows whatever it
    // names, so it must be `ProvingPending` and is never the final answer. The final answers' names
    // must be exactly the route's model, as the typecheck's `Equal` requires: none other, and not
    // none at all.
    const model = ROUTE_MODELS[key];
    if (route.proving && '202' in answers && answers['202'] !== 'ProvingPending') {
      problems.push(`${key}: ${operation} answers 202 with ${answers['202']}, but a proving route's 202 is the retry request() follows, so it must be ProvingPending`);
    }
    const named = Object.entries(answers).filter(([status]) => !(route.proving && status === '202'));
    if (named.length === 0) problems.push(`${key}: ${operation} has no final answer besides its 202, so nothing names ${model}`);
    for (const [status, name] of named) {
      if (name !== model) problems.push(`${key}: ${operation} answers ${status} with ${name}, not ${model}`);
    }
  }
  for (const operation of neverCalled) {
    if (called.has(operation)) problems.push(`${operation} is on NEVER_CALLED, but a route calls it`);
    else if (!(operation in operations)) problems.push(`${operation} is on NEVER_CALLED, but openapi.json doesn't serve it`);
  }
  for (const operation of Object.keys(operations)) {
    if (called.has(operation) || neverCalled.has(operation)) continue;
    problems.push(`${operation} is in openapi.json, but no route calls it: match a route to it, or put it on NEVER_CALLED`);
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
    const neverCalled: ReadonlySet<string> = new Set(NEVER_CALLED);
    const problems = routeProblems(apiOperations(readJson(OPENAPI_PATH)), pending, Object.keys(ROUTES) as RouteKey[], neverCalled);
    expect(problems, 'routes the web calls that the API serves differently or not at all, and operations no route calls').toEqual([]);
    // Not everything is pending: the check reads real answers for at least the thin slice's 20 served routes.
    expect(Object.keys(ROUTES).length - pending.size).toBeGreaterThanOrEqual(20);
  });

  it('route_check_reads_each_answer', () => {
    const keys: RouteKey[] = ['today', 'draftRules', 'sendMessage', 'me', 'health'];
    const operations: Record<string, OperationAnswers> = {
      [op('today')]: { 200: 'Today' },
      // A proving route's 202 is the retry; any other 2xx must name its model.
      [op('draftRules')]: { 200: 'RulesDraft', 202: 'ProvingPending' },
      [op('sendMessage')]: { 202: 'MessageAccepted' },
      [op('me')]: { 200: 'CopyOut', 202: 'ProvingPending' },
    };
    expect(routeProblems(operations, new Set(['health']), keys)).toEqual(['me: GET /api/owner/me answers 202 with ProvingPending, not CopyOut']);
    // `request()` follows every proving 202 as the retry, so a proving route's 202 must be
    // `ProvingPending`, and never counts as its final answer even when it names the model.
    const notTheRetry =
      "draftRules: POST /api/owner/policy/{desk_id}/draft answers 202 with RulesDraft, but a proving route's 202 is the retry request() follows, so it must be ProvingPending";
    expect(routeProblems({ [op('draftRules')]: { 200: 'RulesDraft', 202: 'RulesDraft' } }, new Set(), ['draftRules'])).toEqual([notTheRetry]);
    expect(routeProblems({ [op('draftRules')]: { 202: 'RulesDraft' } }, new Set(), ['draftRules'])).toEqual([
      notTheRetry,
      'draftRules: POST /api/owner/policy/{desk_id}/draft has no final answer besides its 202, so nothing names RulesDraft',
    ]);
    // A proving route that answers only with the retry names no model either, as the typecheck finds too.
    expect(routeProblems({ [op('draftPreset')]: { 202: 'ProvingPending' } }, new Set(), ['draftPreset'])).toEqual([
      'draftPreset: POST /api/owner/policy/{desk_id}/preset has no final answer besides its 202, so nothing names RulesDraft',
    ]);
    // A pending route the document serves, and a served route it lacks, are problems too.
    expect(routeProblems({ [op('health')]: { 200: 'HealthOut' } }, new Set(['health']), ['health'])).toEqual([
      'health: GET /api/health is served now; take it off NOT_YET_SERVED',
    ]);
    expect(routeProblems({}, new Set(), ['today'])).toEqual(['today: GET /api/owner/desks/{desk_id}/today is not in openapi.json']);
  });

  it('route_check_reads_each_operation', () => {
    // An operation no route calls is a problem: here the pending `reports` route, served under another path.
    const renamed = 'GET /api/owner/desks/{desk_id}/report';
    const served: Record<string, OperationAnswers> = { [op('today')]: { 200: 'Today' }, [renamed]: { 200: 'Reports' } };
    const pending = new Set<RouteKey>(['reports']);
    const keys: RouteKey[] = ['today', 'reports'];
    expect(routeProblems(served, pending, keys)).toEqual([
      `${renamed} is in openapi.json, but no route calls it: match a route to it, or put it on NEVER_CALLED`,
    ]);
    // One on NEVER_CALLED is not, but each listed operation must be served and called by no route.
    expect(routeProblems(served, pending, keys, new Set([renamed]))).toEqual([]);
    expect(routeProblems(served, pending, keys, new Set([op('today'), 'GET /api/gone']))).toEqual([
      'GET /api/owner/desks/{desk_id}/today is on NEVER_CALLED, but a route calls it',
      "GET /api/gone is on NEVER_CALLED, but openapi.json doesn't serve it",
      `${renamed} is in openapi.json, but no route calls it: match a route to it, or put it on NEVER_CALLED`,
    ]);
  });
});
