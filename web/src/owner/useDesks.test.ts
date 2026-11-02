/**
 * Desk list cancellation and `carrySetup`, on a query client of their own: cancelled HTTP reads
 * stop, and setup's cached interview only moves forward, never undoing what the API said.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ROUTES } from '../api/routes.ts';
import type { BusinessOut, DeskSetup, DeskSummary } from '../api/views.ts';
import { rivera } from '../ds/fixtures/index.ts';
import { DESKS_KEY, RIVERA_SAMPLE_BUSINESS_NAME, carrySetup, desksQuery } from './useDesks.ts';

const DESK = 'desk-okafor';
const INTERVIEW = 'setup-okafor';

function desk(setup: DeskSetup | null): DeskSummary {
  return { desk_id: DESK, slug: 'okafor-plumbing', name: 'Main line', business_name: 'Okafor Plumbing', hours: [], answering: false, setup };
}

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/**
 * A query client whose Desks were read naming `setup`, watched as a page does, and every read of
 * them from here on failing. `reads()` counts those reads.
 */
function readAs(setup: DeskSetup | null): { queryClient: QueryClient; reads: () => number } {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const businesses: BusinessOut[] = [
    { business_id: 'biz-okafor', name: 'Okafor Plumbing', owner_display_name: 'Daniel', timezone: 'America/Los_Angeles', desks: [desk(setup)] },
  ];
  queryClient.setQueryData(DESKS_KEY, businesses);
  let reads = 0;
  const observer = new QueryObserver<BusinessOut[]>(queryClient, {
    queryKey: DESKS_KEY,
    queryFn: () => {
      reads += 1;
      return Promise.reject(new Error('unavailable'));
    },
    staleTime: Infinity,
  });
  stops.push(observer.subscribe(() => undefined));
  return { queryClient, reads: () => reads };
}

/** The Desk's setup as the Desks name it now. */
function named(queryClient: QueryClient): DeskSetup | null | undefined {
  return queryClient.getQueryData<BusinessOut[]>(DESKS_KEY)?.[0]?.desks[0]?.setup;
}

it('cancelling_a_desks_read_aborts_its_http_request_without_a_query_error', async () => {
  let received: Request | undefined;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const server = setupServer(http.get(`http://localhost${ROUTES.desks.path}`, async ({ request }) => {
    received = request;
    await held;
    return HttpResponse.json([]);
  }));
  server.listen();
  const send = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => send(
    typeof input === 'string' ? new URL(input, 'http://localhost') : input, init,
  ));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  stops.push(() => { release(); queryClient.clear(); vi.unstubAllGlobals(); server.close(); });
  const reading = queryClient.fetchQuery(desksQuery()).catch((error: unknown) => error);
  await vi.waitFor(() => expect(received).toBeDefined());
  expect(received!.signal.aborted).toBe(false);

  await queryClient.cancelQueries({ queryKey: DESKS_KEY });

  expect(received!.signal.aborted).toBe(true);
  expect(queryClient.getQueryState(DESKS_KEY)).toMatchObject({ status: 'pending', fetchStatus: 'idle', error: null });
  await reading;
});

it('unsubscribing_the_last_desks_observer_aborts_and_rolls_back_without_an_error', async () => {
  let received: Request | undefined;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const server = setupServer(http.get(`http://localhost${ROUTES.desks.path}`, async ({ request }) => {
    received = request;
    await held;
    return HttpResponse.json([]);
  }));
  server.listen();
  const send = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => send(
    typeof input === 'string' ? new URL(input, 'http://localhost') : input, init,
  ));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  stops.push(() => { release(); queryClient.clear(); vi.unstubAllGlobals(); server.close(); });
  queryClient.setQueryData(DESKS_KEY, [], { updatedAt: 123 });
  const observer = new QueryObserver(queryClient, desksQuery());
  const unsubscribe = observer.subscribe(() => undefined);
  stops.push(unsubscribe);
  await vi.waitFor(() => expect(received).toBeDefined());
  expect(received!.signal.aborted).toBe(false);

  unsubscribe();

  expect(received!.signal.aborted).toBe(true);
  expect(queryClient.getQueryState(DESKS_KEY)).toMatchObject({
    status: 'success', fetchStatus: 'idle', error: null, data: [], dataUpdatedAt: 123,
  });
});

it('the_sample_business_name_matches_the_backend_seed_and_fixture', () => {
  const seedPy = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'backend', 'desk', 'kernel_service', 'seed.py'), 'utf8');
  const riveraSeed = /^def rivera_seed\b[^\n]*\n((?:[ \t].*\n|\n)*)/m.exec(seedPy)?.[1] ?? '';
  const business = /^    business = BusinessSeed\(([\s\S]*?)^    \)/m.exec(riveraSeed)?.[1] ?? '';
  const name = /^\s+name="([^"]+)"/m.exec(business)?.[1];
  expect(name).toBeDefined();
  expect(name).toBe(RIVERA_SAMPLE_BUSINESS_NAME);
  expect(name).toBe(rivera.business.name);
});

describe('carrySetup', () => {
  it('a_desk_the_api_named_live_stays_live', async () => {
    // Setup went live in another tab, and this tab's Desks were read since, naming no setup. Leaving
    // this tab's setup, still at its preview, doesn't bring the card back, though the reads fail.
    const { queryClient, reads } = readAs(null);
    await carrySetup(queryClient, { desk_id: DESK, interview_id: INTERVIEW, step: 'preview' });
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(0));
    expect(named(queryClient)).toBeNull();
  });

  it('a_later_step_the_api_named_stays', async () => {
    // The Desks already name the safety check: carrying the rules, an older step, keeps it.
    const { queryClient } = readAs({ interview_id: INTERVIEW, step: 'safety_check' });
    await carrySetup(queryClient, { desk_id: DESK, interview_id: INTERVIEW, step: 'rules' });
    expect(named(queryClient)).toEqual({ interview_id: INTERVIEW, step: 'safety_check' });
  });

  it('the_interview_moves_forward_and_another_is_left_be', async () => {
    // A later step moves the Desk's setup on, and going live clears it.
    const { queryClient } = readAs({ interview_id: INTERVIEW, step: 'rules' });
    await carrySetup(queryClient, { desk_id: DESK, interview_id: INTERVIEW, step: 'safety_check' });
    expect(named(queryClient)).toEqual({ interview_id: INTERVIEW, step: 'safety_check' });
    await carrySetup(queryClient, { desk_id: DESK, interview_id: INTERVIEW, step: 'live' });
    expect(named(queryClient)).toBeNull();

    // The Desks name another interview than the one carried: theirs stands, whatever its step.
    const other = readAs({ interview_id: 'setup-newer', step: 'questions' });
    await carrySetup(other.queryClient, { desk_id: DESK, interview_id: INTERVIEW, step: 'preview' });
    expect(named(other.queryClient)).toEqual({ interview_id: 'setup-newer', step: 'questions' });
  });
});
