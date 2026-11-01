/**
 * Share (N-Run2-Share): the Desk's public link, from its slug, with everything an owner needs to put
 * it where customers already look. The business and the Desk come with the owner's frame, and the
 * page draws at once. It reads one thing of its own, the Desk's tools (the same rules read Rules
 * makes), only to know whether the voicemail may promise an emergency callback. Each visit makes
 * that read itself, under a key of its own, so neither Rules' kept answer nor a Rules read still out
 * as Share opens can decide it: until the visit's own read lands, or if it fails or waits for the
 * network, the voicemail is drawn without that sentence, so it never promises one and takes it back.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { request } from '../../api/http.ts';
import { PageHeader } from '../../ds/index.ts';
import { inApp, useDocumentTitle } from '../../lib/useDocumentTitle.ts';
import { publicLink } from '../customerLink.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { ShareKit } from './ShareKit.tsx';
import { urgentCallbackOn } from './shareCopy.ts';

import './SharePage.css';

const TITLE = 'Share';

/** Counts Share's visits in this page's lifetime: each one's read of the tools has a key of its own. */
let visits = 0;

export function SharePage() {
  const { business, desk } = useOwnerDesk();
  const [visit] = useState(() => (visits += 1));
  // This visit's own read of the Desk's tools, kept for nobody else and gone once Share closes.
  const tools = useQuery({
    queryKey: ['shareTools', desk.desk_id, visit],
    queryFn: () => request('rules', { params: { desk_id: desk.desk_id } }),
    staleTime: 0,
    gcTime: 0,
  });
  // That read landed, with no failed read since, and none waiting for the network.
  const current = tools.isSuccess && tools.fetchStatus !== 'paused';
  useDocumentTitle(inApp(TITLE));
  return (
    <div className="cd-share-page">
      <PageHeader title={TITLE} subtitle="Put your Desk where customers already look for you." />
      <ShareKit
        publicUrl={publicLink(desk.slug)}
        business={business.name}
        ownerName={business.owner_display_name}
        urgentCallback={current && tools.data !== undefined && urgentCallbackOn(tools.data.tools)}
      />
    </div>
  );
}
