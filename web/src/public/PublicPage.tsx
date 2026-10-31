/**
 * `/d/:slug`: a Desk's public page. Today's "Chat as a customer" link adds `?preview=<desk>`, which
 * opens the owner's preview of that Desk; for anyone else it falls back to a visitor's chat. Its
 * about column links to the page for AI agents, and to that page's "Send an agent" panel.
 *
 * Today's "Try to break it" hands one of its fixed ideas (`BREAK_IT_IDEAS`) over in this browser's
 * storage and adds the hand-off's one-time token, `?try=<token>`: as the page opens, it types that
 * idea into its chat box, for the visitor to send or not, only when the link has exactly one `try`,
 * equal to the token of the hand-off this browser holds for this Desk, under ten minutes old. The
 * page drops the hand-off as it reads it, whether or not it matched. Anything else types nothing:
 * an idea's key or words in the address, an unknown or used token, another Desk's hand-off, an old
 * one, or storage that can't be read. So only the owner's own Today, in this browser, can type one
 * of the three fixed lines, once for each pick; a link on its own, from anyone, types nothing.
 * A `draft` (an older link's words) is ignored and removed: its words are never typed in, alone or
 * beside a `try`, and a valid `try` beside it still types the handed-off idea. `try` and `draft`
 * leave the address in place as the page opens, every other query and the hash kept, so a reload
 * doesn't type it in again. The preview takes the idea as well.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';

import { dropBreakItHandoff, handedOffBreakItIdea } from '../lib/breakItIdeas.ts';
import { browserLanguage } from '../lib/language.ts';
import { AGENTS_COPY } from './agents/copy.ts';
import { PublicChat } from './PublicChat.tsx';
import { useDocumentLanguage } from './useDocumentLanguage.ts';

/** The query carrying the token of Today's "Try to break it" hand-off. */
const TRY = 'try';
/** An older link's words for the chat box: ignored, never typed in, and taken out of the address. */
const DRAFT = 'draft';

/** The idea handed over to `slug`'s page under the link's one `try` token; none for anything else. */
function ideaFrom(params: URLSearchParams, slug: string): string | null {
  const tokens = params.getAll(TRY);
  return tokens.length === 1 && tokens[0] !== undefined ? handedOffBreakItIdea(slug, tokens[0]) : null;
}

/** `search` without its `try` and `draft` parts; every other part stays exactly as written. */
function withoutTry(search: string): string {
  const kept = search
    .replace(/^\?/, '')
    .split('&')
    .filter((part) => {
      if (part === '') return false;
      const one = new URLSearchParams(part);
      return !one.has(TRY) && !one.has(DRAFT);
    });
  return kept.length === 0 ? '' : `?${kept.join('&')}`;
}

export function PublicPage() {
  const { slug = '' } = useParams();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [language] = useState(browserLanguage);
  useDocumentLanguage(language);
  // The idea handed over as the page opened, for this Desk only: moving to another Desk's page
  // doesn't carry it over. Reading changes nothing, so a render that runs twice reads the same.
  const [arrival, setArrival] = useState(() => ({ slug, idea: ideaFrom(params, slug), read: params.has(TRY) }));
  const idea = arrival.slug === slug ? arrival.idea : null;
  const preview = params.get('preview') ?? '';
  const agents = `/d/${encodeURIComponent(slug)}/agents`;
  const copy = AGENTS_COPY[language];
  const aboutLinks = [
    { label: copy.canDoTitle, href: agents },
    { label: copy.sendTitle, href: `${agents}#send` },
  ];

  // A hand-off is read once: a page that opened with a `try` drops it, whether or not it matched.
  // And the idea goes to the chat that opened with the page, once: the chat keeps it from its first
  // render, so the page lets go of it, and a later chat here (another Desk's, then back) gets none.
  useEffect(() => {
    if (arrival.read) dropBreakItHandoff();
    if (arrival.idea !== null) setArrival((now) => ({ ...now, idea: null }));
  }, [arrival.read, arrival.idea]);

  // Each arrival that brings `try` or `draft` loses them, once: the browser's history replaces
  // the address rather than adds to it. The guard is the navigation being handled, by its key, so a
  // later arrival is cleaned as well, and a render that runs the effect twice cleans once.
  const cleaned = useRef<string | null>(null);
  useEffect(() => {
    if (cleaned.current === location.key || (!params.has(TRY) && !params.has(DRAFT))) return;
    cleaned.current = location.key;
    void navigate(
      { pathname: location.pathname, search: withoutTry(location.search), hash: location.hash },
      { replace: true, state: location.state, preventScrollReset: true },
    );
  }, [params, location, navigate]);

  return (
    <PublicChat
      key={slug}
      slug={slug}
      previewDeskId={preview === '' ? undefined : preview}
      idea={idea ?? undefined}
      aboutLinks={aboutLinks}
    />
  );
}
