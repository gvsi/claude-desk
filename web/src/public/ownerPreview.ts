/**
 * The way back from the owner's own preview of the public page (`/d/{slug}?preview={deskId}`, which
 * "Chat as a customer" opens in a new tab) to the Desk's Today.
 */
import { useQuery } from '@tanstack/react-query';

import { request } from '../api/http.ts';

export interface OwnerPreviewBack {
  /** False while the owner's Desks are still being read; the page waits for them before it draws. */
  settled: boolean;
  /** The Desk's Today, when this browser's owner session holds the Desk; null for anyone else. */
  href: string | null;
}

/** A Desk's Today in the owner's app, as the app's routes have it. */
export const ownerTodayPath = (deskId: string) => `/app/${encodeURIComponent(deskId)}/today`;

/**
 * Where the owner's preview of `slug`'s Desk goes back to. The address proves nothing, since anyone
 * can add `?preview=`: the copy's Desks, read with the owner's session (`me`), decide. The Desk must be one
 * of them, with this slug; a visitor's read fails (401), so a visitor never gets a way back. Without
 * a preview, nothing is read.
 */
export function useOwnerPreviewBack(slug: string, previewDeskId: string | undefined): OwnerPreviewBack {
  const enabled = previewDeskId !== undefined && previewDeskId !== '';
  // `me`, a session probe: its 401 is an answer here, and never ends an owner's session elsewhere.
  const copy = useQuery({
    queryKey: ['me'],
    queryFn: () => request('me'),
    enabled,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    // Sent even while the browser says it's offline, so its answer or its failure (the request has a
    // timeout of its own) settles it, rather than the read pausing and the page waiting on it.
    networkMode: 'always',
  });
  if (!enabled) return { settled: true, href: null };
  // Only this page's own read counts, and only an answer: one kept from before may be from a session
  // that has since ended, and a failed read keeps it.
  if (!copy.isFetchedAfterMount) return { settled: false, href: null };
  const owned = copy.isSuccess && copy.data.desks.some((desk) => desk.desk_id === previewDeskId && desk.slug === slug);
  return { settled: true, href: owned ? ownerTodayPath(previewDeskId) : null };
}
