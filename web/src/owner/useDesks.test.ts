/**
 * `carrySetup`, on a query client of its own: setup's interview written into the copy's Desks only
 * ever moves a Desk's setup forward, so an older interview state never undoes what the API said.
 */
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BusinessOut, DeskSetup, DeskSummary } from '../api/views.ts';
import { DESKS_KEY, carrySetup } from './useDesks.ts';

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
