/**
 * `/d/:slug`: a Desk's public page. Today's "Chat as a customer" link adds `?preview=<desk>`, which
 * opens the owner's preview of that Desk; for anyone else it falls back to a visitor's chat. Its
 * about column links to the page for AI agents, and to that page's "Send an agent" panel.
 *
 * A link can carry words for the chat box, `?draft=<text>` (Today's "Try to break it" sends its
 * idea this way): read once as the page opens, as plain text the visitor sends or not, then taken
 * out of the address in place, every other query and the hash kept, so a reload doesn't type it in
 * again. The preview takes it as well.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';

import { browserLanguage } from '../lib/language.ts';
import { AGENTS_COPY } from './agents/copy.ts';
import { PublicChat } from './PublicChat.tsx';
import { useDocumentLanguage } from './useDocumentLanguage.ts';

/** The query that carries words for the chat box. */
const DRAFT = 'draft';

/** `search` without its `draft` parts; every other part stays exactly as written. */
function withoutDraft(search: string): string {
  const kept = search
    .replace(/^\?/, '')
    .split('&')
    .filter((part) => part !== '' && !new URLSearchParams(part).has(DRAFT));
  return kept.length === 0 ? '' : `?${kept.join('&')}`;
}

export function PublicPage() {
  const { slug = '' } = useParams();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [language] = useState(browserLanguage);
  useDocumentLanguage(language);
  // The link's words for the chat box, as the page opened.
  const [draft] = useState(() => params.get(DRAFT) ?? undefined);
  const preview = params.get('preview') ?? '';
  const agents = `/d/${encodeURIComponent(slug)}/agents`;
  const copy = AGENTS_COPY[language];
  const aboutLinks = [
    { label: copy.canDoTitle, href: agents },
    { label: copy.sendTitle, href: `${agents}#send` },
  ];

  // Once: the words leave the address, which the browser's history replaces rather than adds to.
  const taken = useRef(false);
  useEffect(() => {
    if (taken.current || !params.has(DRAFT)) return;
    taken.current = true;
    void navigate(
      { pathname: location.pathname, search: withoutDraft(location.search), hash: location.hash },
      { replace: true, state: location.state, preventScrollReset: true },
    );
  }, [params, location, navigate]);

  return <PublicChat key={slug} slug={slug} previewDeskId={preview === '' ? undefined : preview} draft={draft} aboutLinks={aboutLinks} />;
}
