/**
 * Share (N-Run2-Share): the Desk's public link, from its slug, with everything an owner needs to put
 * it where customers already look. It reads nothing of its own: the business and the Desk come
 * with the owner's frame.
 */
import { PageHeader } from '../../ds/index.ts';
import { publicLink } from '../customerLink.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { ShareKit } from './ShareKit.tsx';

export function SharePage() {
  const { business, desk } = useOwnerDesk();
  return (
    <div className="cd-share-page">
      <PageHeader title="Share" subtitle="Put your Desk where customers already look for you." />
      <ShareKit publicUrl={publicLink(desk.slug)} business={business.name} ownerName={business.owner_display_name} />
    </div>
  );
}
