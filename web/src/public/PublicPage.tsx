/**
 * `/d/:slug`: a Desk's public page. Today's "Chat as a customer" link adds `?preview=<desk>`, which
 * opens the owner's preview of that Desk; for anyone else it falls back to a visitor's chat. Its
 * about column links to the page for AI agents, and to that page's "Send an agent" panel.
 */
import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router';

import { browserLanguage } from '../lib/language.ts';
import { AGENTS_COPY } from './agents/copy.ts';
import { PublicChat } from './PublicChat.tsx';
import { useDocumentLanguage } from './useDocumentLanguage.ts';

export function PublicPage() {
  const { slug = '' } = useParams();
  const [params] = useSearchParams();
  const [language] = useState(browserLanguage);
  useDocumentLanguage(language);
  const preview = params.get('preview') ?? '';
  const agents = `/d/${encodeURIComponent(slug)}/agents`;
  const copy = AGENTS_COPY[language];
  const aboutLinks = [
    { label: copy.canDoTitle, href: agents },
    { label: copy.sendTitle, href: `${agents}#send` },
  ];
  return <PublicChat key={slug} slug={slug} previewDeskId={preview === '' ? undefined : preview} aboutLinks={aboutLinks} />;
}
