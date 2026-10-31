/**
 * `/d/:slug`: a Desk's public page. Today's "Chat as a customer" link adds `?preview=<desk>`, which
 * opens the owner's preview of that Desk; for anyone else it falls back to a visitor's chat. Its
 * about column links to the page for AI agents, and to that page's "Send an agent" panel.
 *
 * Today's "Try to break it" adds `?try=<key>`, naming one of its fixed ideas (`BREAK_IT_IDEAS`): the
 * page types that idea into its chat box once, for the visitor to send or not. Only those ideas,
 * looked up by key: an unknown key, more than one, or words of any kind in the address (an older
 * `?draft=` included) type nothing, since a link anyone can write would otherwise put a third
 * party's words in a visitor's own chat, one keypress from being sent as theirs. Either way `try`
 * and `draft` leave the address in place as the page opens, every other query and the hash kept,
 * so a reload doesn't type it in again. The preview takes the idea as well.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';

import { breakItIdea } from '../lib/breakItIdeas.ts';
import { browserLanguage } from '../lib/language.ts';
import { AGENTS_COPY } from './agents/copy.ts';
import { PublicChat } from './PublicChat.tsx';
import { useDocumentLanguage } from './useDocumentLanguage.ts';

/** The query naming a "Try to break it" idea by its key. */
const TRY = 'try';
/** An older link's words for the chat box: never typed in, only taken out of the address. */
const DRAFT = 'draft';

/** The idea `params` names: exactly one `try`, with a known key; otherwise none. */
function ideaFrom(params: URLSearchParams): string | null {
  const keys = params.getAll(TRY);
  return keys.length === 1 && keys[0] !== undefined ? breakItIdea(keys[0]) : null;
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
  // The idea the link named as the page opened, for this Desk only: moving to another Desk's page
  // doesn't carry it over.
  const [arrival] = useState(() => ({ slug, idea: ideaFrom(params) }));
  const idea = arrival.slug === slug ? arrival.idea : null;
  const preview = params.get('preview') ?? '';
  const agents = `/d/${encodeURIComponent(slug)}/agents`;
  const copy = AGENTS_COPY[language];
  const aboutLinks = [
    { label: copy.canDoTitle, href: agents },
    { label: copy.sendTitle, href: `${agents}#send` },
  ];

  // Once: the key leaves the address, which the browser's history replaces rather than adds to.
  const taken = useRef(false);
  useEffect(() => {
    if (taken.current || (!params.has(TRY) && !params.has(DRAFT))) return;
    taken.current = true;
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
