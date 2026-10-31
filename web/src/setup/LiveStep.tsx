import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError, isUncertain, ownerErrorCopy, request } from '../api/http.ts';
import type { SetupState, WentLive } from '../api/views.ts';
import { Button, Card, Notice, PageHeader, Pill, StatusDot } from '../ds/index.ts';
import { PublicChat } from '../public/PublicChat.tsx';
import { CopyLink } from '../owner/share/CopyLink.tsx';
import { QrCode } from '../owner/share/QrCode.tsx';
import { DESKS_KEY } from '../owner/useDesks.ts';
import { SETUP_COPY, stillCheckingLine } from './copy.ts';
import { gaveUp } from './shared.ts';

const copy = SETUP_COPY.live;

export interface LiveStepProps {
  state: SetupState;
  /** The business's name, once known. */
  business: string;
  /** Answering is on: the Desk went live on this page, or the Desks say so. */
  answering: boolean;
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
 * "Answering now" under the title, its handled dot breathing, while the Desk answers; the link to
 * share with "Copy link" and "Open"; "Go to Today"; and under them "Share it" as N-R2-Setup-14-Live
 * draws it: the link's QR code, and the website embed, coming later. It is built from the link
 * alone; the printable card and the ready-made words are on Share.
 */
export function LiveStep({ state, business, answering, onLive, reread }: LiveStepProps) {
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
        <div className="cd-setup-live__head">
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
          {answering ? (
            <p className="cd-setup-live__answering cd-type-meta">
              <StatusDot tone="handled" />
              {copy.answeringNow}
            </p>
          ) : null}
        </div>
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
        <Card as="section" label={copy.shareIt} padding={16}>
          <h2 className="cd-setup-live__share-title cd-type-control">{copy.shareIt}</h2>
          <div className="cd-setup-live__share">
            <div className="cd-setup-live__qr">
              <QrCode url={url} />
            </div>
            <div className="cd-setup-live__embed">
              <div className="cd-setup-live__embed-text">
                <p className="cd-setup-live__embed-title cd-type-body">{copy.websiteEmbed}</p>
                <p className="cd-setup-live__embed-line cd-type-meta">{copy.websiteEmbedLine}</p>
              </div>
              <Pill>{copy.comingLater}</Pill>
            </div>
          </div>
        </Card>
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
