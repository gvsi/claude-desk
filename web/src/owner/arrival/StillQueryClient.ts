/**
 * A query client whose reads only ever answer from what it was given, and whose writes never run:
 * nothing it holds is fetched, polled or read again from the API, and nothing is sent. The preview
 * behind the intro dialog draws Today itself under one, before any copy exists, so a read Today
 * makes (on mount, on a poll, or a `refetch` a hook asks for) can never reach the network: every
 * query is disabled, and its query function answers with what the client holds for it, or never,
 * when it holds nothing. A write rejects at once, with none of its own steps run (before it, on
 * failure, after it), since any of them could send a request of its own. The preview is inert, so
 * neither should happen; this is what holds if one does.
 */
import {
  QueryClient,
  type DefaultedQueryObserverOptions,
  type DefaultError,
  type MutationOptions,
  type QueryFunction,
  type QueryKey,
  type QueryObserverOptions,
} from '@tanstack/react-query';

export class StillQueryClient extends QueryClient {
  /** One answer per query, kept so the options a query gets stay the same from render to render. */
  readonly #answers = new Map<string, () => Promise<unknown>>();

  constructor(reads: readonly (readonly [QueryKey, unknown])[]) {
    // Kept for as long as the client is: no timer outlives the preview.
    super({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
    for (const [key, data] of reads) this.setQueryData(key, data);
  }

  override defaultQueryOptions<
    TQueryFnData = unknown,
    TError = DefaultError,
    TData = TQueryFnData,
    TQueryData = TQueryFnData,
    TQueryKey extends QueryKey = QueryKey,
    TPageParam = never,
  >(
    options:
      | QueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey, TPageParam>
      | DefaultedQueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey>,
  ): DefaultedQueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey> {
    const defaulted = super.defaultQueryOptions(options);
    return { ...defaulted, enabled: false, queryFn: this.#answerFor(defaulted.queryHash) as QueryFunction<TQueryFnData, TQueryKey> };
  }

  // `MutationOptions<any, …>` is the base method's own constraint.
  override defaultMutationOptions<T extends MutationOptions<any, any, any, any>>(options?: T): T {
    return {
      ...super.defaultMutationOptions(options),
      mutationFn: refuseWrite,
      onMutate: undefined,
      onError: undefined,
      onSuccess: undefined,
      onSettled: undefined,
      retry: false,
    };
  }

  /** What the client holds for the query `hash`, or a promise that never settles when it holds nothing. */
  #answerFor(hash: string): () => Promise<unknown> {
    let answer = this.#answers.get(hash);
    if (answer === undefined) {
      answer = () => {
        const data = this.getQueryCache().get(hash)?.state.data;
        return data === undefined ? new Promise<never>(() => undefined) : Promise.resolve(data);
      };
      this.#answers.set(hash, answer);
    }
    return answer;
  }
}

/** Every write under the still client: refused before anything is sent. */
function refuseWrite(): Promise<never> {
  return Promise.reject(new Error('The preview behind the intro dialog writes nothing'));
}
