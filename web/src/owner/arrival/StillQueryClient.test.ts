/**
 * The preview's query client: it answers reads only from what it was given and never runs a read
 * or a write of its own, whatever a page under it asks for.
 */
import { MutationObserver, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { StillQueryClient } from './StillQueryClient.ts';

describe('StillQueryClient', () => {
  it('reads_answer_from_what_it_holds', async () => {
    const client = new StillQueryClient([[['held'], 'what the preview holds']]);
    const read = vi.fn(async () => 'from the API');
    const held = new QueryObserver(client, { queryKey: ['held'], queryFn: read });
    const unheld = new QueryObserver(client, { queryKey: ['unheld'], queryFn: read });
    const stop = [held.subscribe(() => undefined), unheld.subscribe(() => undefined)];

    // Every read again, as a page's refresh asks: nothing is left running, and nothing was read.
    await client.refetchQueries();
    expect(client.isFetching()).toBe(0);
    expect((await held.refetch()).data).toBe('what the preview holds');
    expect(client.isFetching()).toBe(0);
    expect(read).not.toHaveBeenCalled();
    for (const unsubscribe of stop) unsubscribe();
  });

  it('writes_reject_without_running', async () => {
    const client = new StillQueryClient([]);
    const write = vi.fn(async () => 'written');
    // A write's own steps, any of which could send a request of its own.
    const steps = { onMutate: vi.fn(), onError: vi.fn(), onSuccess: vi.fn(), onSettled: vi.fn() };
    const observer = new MutationObserver(client, { mutationFn: write, ...steps });

    await expect(observer.mutate('on')).rejects.toThrow('The preview behind the intro dialog writes nothing');
    expect(write).not.toHaveBeenCalled();
    for (const step of Object.values(steps)) expect(step).not.toHaveBeenCalled();
    expect(client.isMutating()).toBe(0);
  });
});
