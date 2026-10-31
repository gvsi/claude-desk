import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError, isUncertain, ownerErrorCopy, request } from '../api/http.ts';
import type { SetupState, WentLive } from '../api/views.ts';
import { Button, Notice, PageHeader } from '../ds/index.ts';
import { PublicChat } from '../public/PublicChat.tsx';
import { CopyLink } from '../owner/share/CopyLink.tsx';
import { DESKS_KEY } from '../owner/useDesks.ts';
import { SETUP_COPY, stillCheckingLine } from './copy.ts';
import { gaveUp } from './shared.ts';

const copy = SETUP_COPY.live;

export interface LiveStepProps {
  state: SetupState;
  /** The business's name, once known. */
  business: string;
  /** The Desk went live. */
  onLive: () => void;
  /** Reads the interview again after a write whose answer was lost; null when it can't be read. */
  reread: () => Promise<SetupState | null>;
}

/**
 * The Desk's public link: the API's `public_url` when it is a web address, else (after a reload,
 * with no answer to read it from) the public page on this site, which is where the API's points.
 */
function publicLink(wentLive: WentLive | null, slug: string): string {
  const own = new URL(`/d/${encodeURIComponent(slug)}`, window.location.origin).href;
  if (wentLive === null) return own;
  try {
    const url = new URL(wentLive.public_url, window.location.origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : own;
  } catch {
    return own;
  }
}

/**
 * The last step, opened by a confirmed setup. Before going live (step `preview`): the public page
 * in a frame, on the owner's own preview chat, while Answering is off; "Go live" turns it on. Live:
 * the link to share with "Copy link" and "Open", and "Go to Today".
 */
export function LiveStep({ state, business, onLive, reread }: LiveStepProps) {
  const queryClient = useQueryClient();
  const id = state.interview_id;
  const [wentLive, setWentLive] = useState<WentLive | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const goLive = async () => {
    setPending(true);
    setError(null);
    // Answering is on now: the Desks the app read before say it's off, so they are read again.
    const answering = () => void queryClient.invalidateQueries({ queryKey: DESKS_KEY });
    try {
      setWentLive(await request('goLive', { params: { id } }));
      answering();
      onLive();
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      // A lost answer, the give-up, or a 409 (it is live already): the interview says whether the Desk is live.
      const now = isUncertain(err) || (err instanceof ApiError && err.kind === 'conflict') ? await reread() : null;
      if (now?.step === 'live') answering();
      else setError(gaveUp(err) ? stillCheckingLine() : ownerErrorCopy(err));
    } finally {
      setPending(false);
    }
  };

  if (state.step === 'live') {
    const url = publicLink(wentLive, state.slug);
    return (
      <div className="cd-setup-step">
        <PageHeader
          title={
            business === '' ? (
              copy.yourDeskIsLive
            ) : (
              <>
                <span data-copy="user">{business}</span>
                {copy.isLive}
              </>
            )
          }
          subtitle={copy.liveSubtitle}
        />
        <CopyLink
          url={url}
          actions={
            <Button variant="secondary" size="main" href={url} external>
              {copy.open}
            </Button>
          }
        />
        <div className="cd-setup-step__actions">
          <Button variant="primary" size="main" href={`/app/${encodeURIComponent(state.desk_id)}/today`}>
            {copy.goToToday}
          </Button>
        </div>
        {/* The share kit (QR card, share texts, website embed) joins here with the People, share and knowledge task. */}
      </div>
    );
  }

  return (
    <div className="cd-setup-step">
      <PageHeader title={copy.previewTitle} subtitle={copy.previewSubtitle} />
      <div className="cd-setup-live__preview">
        <PublicChat slug={state.slug} previewDeskId={state.desk_id} embedded />
      </div>
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      <div className="cd-setup-step__actions">
        <Button variant="primary" size="main" busy={pending} onClick={() => void goLive()}>
          {copy.goLive}
        </Button>
      </div>
    </div>
  );
}
