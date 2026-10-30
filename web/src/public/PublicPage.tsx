/**
 * `/d/:slug`: a Desk's public page. Today's "Chat as a customer" link adds `?preview=<desk>`, which
 * opens the owner's preview of that Desk; for anyone else it falls back to a visitor's chat.
 */
import { useParams, useSearchParams } from 'react-router';

import { PublicChat } from './PublicChat.tsx';

export function PublicPage() {
  const { slug = '' } = useParams();
  const [params] = useSearchParams();
  const preview = params.get('preview') ?? '';
  return <PublicChat key={slug} slug={slug} previewDeskId={preview === '' ? undefined : preview} />;
}
