import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import { ApiError, isUncertain, ownerErrorCopy, request } from '../api/http.ts';
import type { BusinessOut, SetupState, WentLive } from '../api/views.ts';
import { Button, Card, ConnectorIcon, Notice, PageHeader, Pill, StatusDot, StatusLabel } from '../ds/index.ts';
import { useFocusOnArrival } from '../lib/useFocusOnArrival.ts';
import { PublicChat } from '../public/PublicChat.tsx';
import { COMING_LATER_CHANNELS, WEBSITE_EMBED } from '../lib/channels.ts';
import { CopyLink } from '../owner/share/CopyLink.tsx';
import { QrCode } from '../owner/share/QrCode.tsx';
import { DESKS_KEY, withAnswering } from '../owner/useDesks.ts';
import { SETUP_COPY, stillCheckingLine } from './copy.ts';
import { gaveUp } from './shared.ts';

const copy = SETUP_COPY.live;

export interface LiveStepProps {
  state: SetupState;
  /** The business's name, once known. */
  business: string;
  /** Answering is on, as the latest Desks read says. */
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
 * in a frame, on the owner's own preview chat, while Answering is off; under it the launch bar, that
 * Answering stays off and only the owner sees the preview, and "Go live", which turns it on. Live:
 * "Acting for you now" under the title, its handled dot breathing, while the Desk answers; the link to
 * share with "Copy link" and "Open"; "Go to Today"; and under them "Share it" as N-R2-Setup-14-Live
 * draws it: the link's QR code, and the website embed, coming later; then "More channels", each
 * coming later (`COMING_LATER_CHANNELS`). It is built from the link alone; the printable card and
 * the ready-made words are on Share.
 */
export function LiveStep({ state, business, answering, onLive, reread }: LiveStepProps) {
  const queryClient = useQueryClient();
  const id = state.interview_id;
  const [wentLive, setWentLive] = useState<WentLive | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The preview's composer takes focus once its chat can be written in, for the owner to try it at once.
  const preview = useRef<HTMLDivElement>(null);
  useFocusOnArrival(preview, '.cd-public-shell__composer textarea');

  const goLive = async () => {
    setPending(true);
    setError(null);
    try {
      setWentLive(await request('goLive', { params: { id } }));
      // It went live here, so this Desk answers now: the Desks say so at once. Setup carries the live
      // step into them as it moves on (`onLive`), which reads them again.
      queryClient.setQueryData<BusinessOut[]>(DESKS_KEY, (now) => withAnswering(now, state.desk_id, true));
      onLive();
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      // A lost answer, the give-up, or a 409 (it is live already): the interview says whether the Desk
      // is live. The Desks are read again first, so a step that turns live draws with "Acting for you now"
      // as they say, rather than gaining it a moment later and moving down.
      const recover = isUncertain(err) || (err instanceof ApiError && err.kind === 'conflict');
      if (recover) await queryClient.refetchQueries({ queryKey: DESKS_KEY });
      const now = recover ? await reread() : null;
      if (now?.step !== 'live') setError(gaveUp(err) ? stillCheckingLine() : ownerErrorCopy(err));
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
              <ConnectorIcon icon="quotes" glyph={WEBSITE_EMBED.icon} size="section" />
              <div className="cd-setup-live__embed-text">
                <p className="cd-setup-live__embed-title cd-type-body">{WEBSITE_EMBED.name}</p>
                <p className="cd-setup-live__embed-line cd-type-meta">{WEBSITE_EMBED.line}</p>
              </div>
              <Pill>{copy.comingLater}</Pill>
            </div>
          </div>
        </Card>
        <Card as="section" label={copy.moreChannels} padding={16}>
          <h2 className="cd-setup-live__share-title cd-type-control">{copy.moreChannels}</h2>
          <ul role="list" className="cd-setup-live__channels">
            {COMING_LATER_CHANNELS.map((channel) => (
              <li key={channel.key} className="cd-setup-live__embed cd-setup-live__channel">
                <ConnectorIcon icon="quotes" glyph={channel.icon} size="section" />
                <div className="cd-setup-live__embed-text">
                  <p className="cd-setup-live__embed-title cd-type-body">{channel.name}</p>
                  <p className="cd-setup-live__embed-line cd-type-meta">{channel.line}</p>
                </div>
                <Pill>{copy.comingLater}</Pill>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    );
  }

  return (
    <div className="cd-setup-step">
      <PageHeader title={copy.previewTitle} />
      <div className="cd-setup-live__preview" ref={preview}>
        <PublicChat slug={state.slug} previewDeskId={state.desk_id} embedded />
      </div>
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      <div className="cd-setup-live__launch">
        <div className="cd-setup-live__launch-text">
          <p className="cd-setup-live__launch-line cd-type-section">
            <StatusLabel tone="info">{copy.previewAnsweringOff}</StatusLabel>
          </p>
          <p className="cd-setup-live__launch-note cd-type-meta">{copy.previewOnlyYou}</p>
        </div>
        <div className="cd-setup-live__go">
          <Button variant="primary" size="main" busy={pending} onClick={() => void goLive()}>
            {copy.goLive}
          </Button>
        </div>
      </div>
    </div>
  );
}
