/**
 * What setup's steps share: the rules draft's read, the line around the business's name, how to
 * tell the client's own proving give-up from the server's answer, and each step opening at its top.
 */
import { Fragment, createElement, useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { ApiError, request } from '../api/http.ts';
import type { RouteKey } from '../api/routes.ts';
import { SETUP_STEPS, type SetupStep } from '../api/views.ts';
import { afterName } from '../lib/names.ts';
import { SETUP_COPY } from './copy.ts';

/**
 * The requests that can move a setup interview on in the API: an answer, the rules draft, the
 * situations, the safety check, the confirm and going live. The copy's Desks name each Desk's
 * setup step, so each one, as it settles, has them read again (the app's providers), even once
 * setup has closed: one still out when the owner left lands later.
 */
export const MOVES_SETUP: ReadonlySet<RouteKey> = new Set<RouteKey>(['setupAnswer', 'setupProposal', 'setupSuggestions', 'setupReopen', 'setupRules', 'setupSituations', 'setupSafetyCheck', 'setupConfirm', 'goLive']);

/** The step each request that moves an interview on has it at in the API once it succeeds. */
export const SETUP_REACHES: Readonly<Partial<Record<RouteKey, SetupStep>>> = {
  setupRules: 'rules',
  setupSituations: 'situations',
  setupSafetyCheck: 'safety_check',
  setupConfirm: 'preview',
  goLive: 'live',
};

/** The later of two setup steps, in setup's order (`SETUP_STEPS`): an interview only moves forward. */
export function laterStep(a: SetupStep, b: SetupStep): SetupStep {
  return SETUP_STEPS.indexOf(b) > SETUP_STEPS.indexOf(a) ? b : a;
}

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

/** An interview's setup page, at the step the API has it at. */
export function setupPath(id: string): string {
  return `/app/setup/${encodeURIComponent(id)}`;
}

/** The search parameter that opens setup's chat over a later step: "Change something". */
const CHAT_PARAM = 'chat';

/**
 * Where "Change something" leads, from Real situations or a step after the chat: the same
 * interview with its chat open again. The chat's "Continue" goes back to `setupPath`, the step the
 * API has it at.
 */
export function changeSomethingPath(id: string): string {
  return `${setupPath(id)}?${CHAT_PARAM}`;
}

/** The page's address asks for setup's chat ("Change something"). */
export function opensSetupChat(search: URLSearchParams): boolean {
  return search.has(CHAT_PARAM);
}

/** "Change something"'s handler: opens the interview's chat again, over the step the owner is on. */
export function useChangeSomething(id: string): () => void {
  const navigate = useNavigate();
  return useCallback(() => void navigate(changeSomethingPath(id)), [navigate, id]);
}

/**
 * A line around the business's name: the name is the owner's own words (`data-copy="user"`), never
 * read as the screen's; "your business" until the API names it.
 * When the name already ends a sentence ('.', '!' or '?'), the line's own leading '.' is dropped,
 * so 'Chen & Co.' doesn't read 'Chen & Co..'.
 */
export function aroundBusiness([before, after]: readonly [string, string] | readonly string[], business: string): ReactNode {
  const name = business === '' ? SETUP_COPY.yourBusiness : createElement('span', { 'data-copy': 'user' }, business);
  const suffix = after === undefined ? after : afterName(business, after);
  return createElement(Fragment, null, before, name, suffix);
}

/**
 * The checking ran out of time on this side: the client's own give-up after a minute of proving
 * retries (no answer from the server, so no status), as against the server's 409 that the rules
 * can't be checked.
 */
export function gaveUp(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'rules_cannot_be_checked' && err.status === null;
}

/**
 * Brings the window to its top, at once, whenever `screen` changes to another of setup's screens:
 * each opens at its top with its title in view, rather than where the owner had scrolled on the one
 * before (on a phone, its end, where its main button is), while what it reads is still out and once
 * it lands. The first screen keeps where the window is, and `null` (no screen yet) moves nothing.
 */
export function useOpensAtTop(screen: string | number | null): void {
  const shown = useRef(screen);
  useLayoutEffect(() => {
    if (screen === null || screen === shown.current) return;
    const first = shown.current === null;
    shown.current = screen;
    if (!first) window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [screen]);
}
