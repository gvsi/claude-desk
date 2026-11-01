/**
 * Share (N-Run2-Share): the Desk's public link, from its slug, with everything an owner needs to put
 * it where customers already look. The business and the Desk come with the owner's frame, and the
 * page draws at once. It reads one thing of its own, the Desk's tools (the rules read Rules makes),
 * only to know whether the voicemail may promise an emergency callback. Only a read that lands while
 * Share is open counts, never one kept from an earlier page: until it lands, or if it fails or waits
 * for the network, the voicemail is drawn without that sentence, so it never promises one and takes
 * it back.
 */
import { useQuery } from '@tanstack/react-query';

import { PageHeader } from '../../ds/index.ts';
import { inApp, useDocumentTitle } from '../../lib/useDocumentTitle.ts';
import { publicLink } from '../customerLink.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { rulesQuery } from '../rules/RuleDraftReview.tsx';
import { ShareKit } from './ShareKit.tsx';
import { urgentCallbackOn } from './shareCopy.ts';

import './SharePage.css';

const TITLE = 'Share';

export function SharePage() {
  const { business, desk } = useOwnerDesk();
  const rules = useQuery(rulesQuery(desk.desk_id));
  // A read made since the page opened, with no failed read since, and none waiting for the network.
  const current = rules.isFetchedAfterMount && rules.errorUpdatedAt <= rules.dataUpdatedAt && rules.fetchStatus !== 'paused';
  useDocumentTitle(inApp(TITLE));
  return (
    <div className="cd-share-page">
      <PageHeader title={TITLE} subtitle="Put your Desk where customers already look for you." />
      <ShareKit
        publicUrl={publicLink(desk.slug)}
        business={business.name}
        ownerName={business.owner_display_name}
        urgentCallback={current && rules.data !== undefined && urgentCallbackOn(rules.data.tools)}
      />
    </div>
  );
}
