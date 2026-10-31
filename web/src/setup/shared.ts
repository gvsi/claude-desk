/**
 * What setup's steps share: the rules draft's read, the line around the business's name, and how
 * to tell the client's own proving give-up from the server's answer.
 */
import { Fragment, createElement, type ReactNode } from 'react';

import { ApiError, request } from '../api/http.ts';
import type { RouteKey } from '../api/routes.ts';
import { SETUP_COPY } from './copy.ts';

/**
 * The requests that can move a setup interview on in the API: an answer, the rules draft, the
 * situations, the safety check, the confirm and going live. The copy's Desks name each Desk's
 * setup step, so each one, as it settles, has them read again (the app's providers), even once
 * setup has closed: one still out when the owner left lands later.
 */
export const MOVES_SETUP: ReadonlySet<RouteKey> = new Set<RouteKey>(['setupAnswer', 'setupRules', 'setupSituations', 'setupSafetyCheck', 'setupConfirm', 'goLive']);

/** Setup's rules draft: posted once on the way in, and read again by the same post (the API answers the same draft). */
export function setupRulesQuery(id: string) {
  return {
    queryKey: ['setupRules', id] as const,
    queryFn: () => request('setupRules', { params: { id } }),
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  };
}

/**
 * A line around the business's name: the name is the owner's own words (`data-copy="user"`), never
 * read as the screen's; "your business" until the API names it.
 */
export function aroundBusiness([before, after]: readonly [string, string] | readonly string[], business: string): ReactNode {
  const name = business === '' ? SETUP_COPY.yourBusiness : createElement('span', { 'data-copy': 'user' }, business);
  return createElement(Fragment, null, before, name, after);
}

/**
 * The checking ran out of time on this side: the client's own give-up after a minute of proving
 * retries (no answer from the server, so no status), as against the server's 409 that the rules
 * can't be checked.
 */
export function gaveUp(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'rules_cannot_be_checked' && err.status === null;
}
