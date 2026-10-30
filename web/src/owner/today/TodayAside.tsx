import { Button, Card } from '../../ds/index.ts';
import { customerLink, publicLink } from '../customerLink.ts';
import { ThisWeek } from './ThisWeek.tsx';

export interface TodayAsideProps {
  deskId: string;
  slug: string;
}

/**
 * Today's right column: the Desk's public page, which "Chat as a customer" opens in a new tab as
 * this Desk's owner sees it, and under it the last 7 days. Nothing here opens a chat on Today.
 */
export function TodayAside({ deskId, slug }: TodayAsideProps) {
  return (
    <div className="cd-today-aside">
      <Card as="section" padding={16}>
        <div className="cd-today-aside__public">
          <h2 className="cd-today-aside__title cd-type-section">
            Your public page
          </h2>
          <p className="cd-today-aside__link cd-type-meta">{publicLink(slug)}</p>
          <p className="cd-today-aside__text cd-type-meta">Chats on it are real conversations with your Desk. They show up in Conversations.</p>
          <div className="cd-today-aside__action">
            <Button variant="secondary" href={customerLink(slug, deskId)} external>
              Chat as a customer
            </Button>
          </div>
        </div>
      </Card>
      <ThisWeek deskId={deskId} />
    </div>
  );
}
