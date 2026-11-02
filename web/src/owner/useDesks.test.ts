/**
 * Desk list cancellation, Needs you's reads as its readers come and go, and `carrySetup`, on a query
 * client of their own: cancelled HTTP reads stop, a Needs you read carries on while its readers swap
 * and gives way to the read of a page that reads it as it opens, and setup's cached interview only
 * moves forward, never undoing what the API said.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { QueryClient, QueryClientProvider, QueryObserver, type UseQueryResult } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { StrictMode, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ROUTES, apiPath } from '../api/routes.ts';
import type { BusinessOut, DeskSetup, DeskSummary, NeedsYouItem } from '../api/views.ts';
import { rivera } from '../ds/fixtures/index.ts';
import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { DESKS_KEY, RIVERA_SAMPLE_BUSINESS_NAME, carrySetup, desksQuery, needsYouKey, needsYouQuery, useNeedsYou } from './useDesks.ts';

const DESK = 'desk-okafor';
const INTERVIEW = 'setup-okafor';

function desk(setup: DeskSetup | null): DeskSummary {
  return { desk_id: DESK, slug: 'okafor-plumbing', name: 'Main line', business_name: 'Okafor Plumbing', hours: [], answering: false, setup, business_type: 'trade', unread_conversations: 0 };
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

/**
 * Serves the main Desk's Needs you, holding each read until `release(n)` lets the nth (from 0)
 * through with `answers[n]` (an empty list past them). `received` lists the reads as they came.
 */
function serveNeedsYou(answers: NeedsYouItem[][] = []): { received: Request[]; release: (n: number) => void } {
  const received: Request[] = [];
  const gates: { opened: Promise<void>; open: () => void }[] = [];
  const gate = (n: number) => {
    if (gates[n] === undefined) {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => { open = resolve; });
      gates[n] = { opened, open };
    }
    return gates[n];
  };
  const server = setupServer(http.get(`http://localhost${apiPath('needsYou', { desk_id: RIVERA.deskId })}`, async ({ request }) => {
    const n = received.push(request) - 1;
    await gate(n).opened;
    return HttpResponse.json(answers[n] ?? []);
  }));
  server.listen();
  const send = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => send(
    typeof input === 'string' ? new URL(input, 'http://localhost') : input, init,
  ));
  stops.push(() => { for (let n = 0; n <= received.length; n += 1) gate(n).open(); vi.unstubAllGlobals(); server.close(); });
  return { received, release: (n) => gate(n).open() };
}

it('a_needs_you_read_carries_on_as_its_readers_swap', async () => {
  // As a page opens, its readers of Needs you can swap: the last one leaves just before the next
  // comes. The read already out carries on for the next one, rather than being stopped and sent again.
  const reads = serveNeedsYou();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  stops.push(() => queryClient.clear());
  const leave = new QueryObserver(queryClient, needsYouQuery(RIVERA.deskId)).subscribe(() => undefined);
  await vi.waitFor(() => expect(reads.received).toHaveLength(1));

  leave();
  stops.push(new QueryObserver(queryClient, needsYouQuery(RIVERA.deskId)).subscribe(() => undefined));

  expect(reads.received[0]!.signal.aborted).toBe(false);
  reads.release(0);
  await vi.waitFor(() => expect(queryClient.getQueryState(needsYouKey(RIVERA.deskId))?.status).toBe('success'));
  expect(reads.received).toHaveLength(1);
});

describe('a page that reads Needs you as it opens', () => {
  /** The page's Needs you, as it last rendered. */
  let page: UseQueryResult<NeedsYouItem[]> | undefined;
  function RulesProbe() {
    page = useNeedsYou(RIVERA.deskId, { readOnOpen: true });
    return null;
  }

  /** Opens the page on `queryClient`, under StrictMode when `strict`, as `main.tsx` renders the app. */
  function open(queryClient: QueryClient, strict: boolean): void {
    const root = createRoot(document.createElement('div'));
    const app = createElement(QueryClientProvider, { client: queryClient }, createElement(RulesProbe));
    root.render(strict ? createElement(StrictMode, null, app) : app);
    stops.push(() => root.unmount());
  }

  /** The seed's Needs you, its quote held. */
  let heldQuote: NeedsYouItem[];
  beforeEach(async () => {
    page = undefined;
    mockStore.reset('rivera');
    heldQuote = (await mockStore.dispatch('needsYou', { params: { desk_id: RIVERA.deskId } }) as { body: NeedsYouItem[] }).body;
    expect(heldQuote.some((item) => item.decision?.state === 'held')).toBe(true);
  });

  for (const strict of [false, true]) {
    const underStrictMode = strict ? '_under_strict_mode' : '';
    for (const kept of [true, false]) {
      it(`replaces_a_read_sent_before_it_opened${kept ? '' : '_with_nothing_kept'}${underStrictMode}`, async () => {
        // Another read went out on a page since left (the app kept an earlier read with the quote
        // held, or none yet). The quote is answered meanwhile: that read's answer, from before this
        // page opened, isn't the page's own. Its own read goes out once as it opens, before the
        // earlier read comes back, under StrictMode too.
        const reads = serveNeedsYou([heldQuote, []]);
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        stops.push(() => queryClient.clear());
        if (kept) queryClient.setQueryData(needsYouKey(RIVERA.deskId), heldQuote);
        const leave = new QueryObserver(queryClient, needsYouQuery(RIVERA.deskId)).subscribe(() => undefined);
        await vi.waitFor(() => expect(reads.received).toHaveLength(1));
        leave();

        open(queryClient, strict);
        await vi.waitFor(() => expect(reads.received).toHaveLength(2));
        reads.release(0);
        // Time for the earlier read's answer to land, had it been kept.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(page?.isFetchedAfterMount).toBe(false);
        expect(page?.data).toEqual(kept ? heldQuote : undefined);

        reads.release(1);
        await vi.waitFor(() => expect(page?.isFetchedAfterMount).toBe(true));
        expect(page?.data).toEqual([]);
        expect(reads.received).toHaveLength(2);
      });
    }

    it(`reads_once_as_it_first_opens${underStrictMode}`, async () => {
      // Nothing read yet and no read out: the page's read as it mounts is its own, sent once.
      const reads = serveNeedsYou();
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      stops.push(() => queryClient.clear());

      open(queryClient, strict);
      await vi.waitFor(() => expect(reads.received).toHaveLength(1));
      // Time for a second read to go out, had there been one.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(reads.received).toHaveLength(1);
      reads.release(0);
      await vi.waitFor(() => expect(page?.isFetchedAfterMount).toBe(true));
      expect(page?.data).toEqual([]);
    });
  }
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
