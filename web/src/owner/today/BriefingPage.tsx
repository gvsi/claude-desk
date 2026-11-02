import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';

import { ownerErrorCopy, request } from '../../api/http.ts';
import { Button, Card, Notice, PageHeader, TextLink } from '../../ds/index.ts';
import { inApp, useDocumentTitle } from '../../lib/useDocumentTitle.ts';
import { followInAppLinks } from '../inAppLinks.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { todayPath } from '../useDesks.ts';
import { BriefingRows, QuietNight } from './SinceLastNight.tsx';

import './Today.css';

const TITLE = 'Since last night';

/**
 * `/app/:deskId/today/briefing`: everything since last night, newest first, read once when the
 * page opens. Today's short form shows one row of each kind and links here.
 */
export function BriefingPage() {
  const { desk } = useOwnerDesk();
  useDocumentTitle(inApp(TITLE));
  const deskId = desk.desk_id;
  const navigate = useNavigate();
  const location = useLocation();
  const briefing = useQuery({
    queryKey: ['briefing', deskId],
    queryFn: () => request('briefing', { params: { desk_id: deskId } }),
    // The full list is read when the page opens, not polled; Today's short form is the live one.
    refetchOnWindowFocus: false,
  });
  const back = <TextLink href={todayPath(deskId)}>Back to Today</TextLink>;

  let body;
  if (briefing.data === undefined) {
    body = briefing.isError ? (
      <Notice
        tone="error"
        action={
          <Button variant="secondary" onClick={() => void briefing.refetch()}>
            Try again
          </Button>
        }
      >
        {ownerErrorCopy(briefing.error)}
      </Notice>
    ) : (
      <p className="cd-today__loading cd-type-meta" role="status">
        Reading what happened since last night
      </p>
    );
  } else if (briefing.data.items.length === 0) {
    body = <QuietNight since={briefing.data.since} action={back} />;
  } else {
    body = <BriefingRows items={briefing.data.items} label="Since last night, newest first" />;
  }

  const quiet = briefing.data !== undefined && briefing.data.items.length === 0;
  return (
    <div className="cd-briefing-page" onClick={followInAppLinks(navigate)} onClickCapture={(event) => {
      if (location.state?.fromToday !== true || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement) || link.target !== '' || link.getAttribute('href') !== todayPath(deskId)) return;
      // This briefing was opened by Today: return to that entry, whose scroll place it kept.
      event.preventDefault();
      void navigate(-1);
    }}>
      <PageHeader title={TITLE} />
      <Card>{body}</Card>
      {quiet ? null : <div className="cd-briefing-page__back cd-type-meta">{back}</div>}
    </div>
  );
}
