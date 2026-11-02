import { Button, Card, CopyList, Pill, SHARE_CARD_QR_COLORS, ShareCard } from '../../ds/index.ts';
import { SHARE_CHANNELS } from '../../lib/channels.ts';
import { CopyLink } from './CopyLink.tsx';
import { QrCode } from './QrCode.tsx';
import { SHARE_COPY, displayLink } from './shareCopy.ts';

import './ShareKit.css';

export interface ShareKitProps {
  /** The Desk's public link, the one to share: `{origin}/d/{slug}`, or `go_live`'s `public_url`. */
  publicUrl: string;
  /** The business's name. */
  business: string;
  /** The owner's display name, whom a customer can ask for. */
  ownerName: string;
  /**
   * Whether the Desk has a tool for urgent callbacks on (`urgentCallbackOn`), so the voicemail can
   * say the owner calls back about an emergency; false until the Desk's tools are read.
   */
  urgentCallback: boolean;
}

/** Marks the page while the browser prints, so the print styles leave only the card on paper. */
const PRINT_ONLY = 'data-print-only';

/** Prints the printable card alone, and clears the mark once the browser has printed. */
function printCard(): void {
  const root = document.documentElement;
  root.setAttribute(PRINT_ONLY, 'share-card');
  window.addEventListener('afterprint', () => root.removeAttribute(PRINT_ONLY), { once: true });
  window.print();
}

/** Writes words to the clipboard; a browser without one, or one that refuses, throws. */
async function writeToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/**
 * What an owner needs to put their Desk where customers already look (N-Run2-Share): the link with
 * Copy link and Open, a printable card with its QR code, the ready-made words with Copy for each,
 * and the channels coming later. Each is built from `publicUrl`; a link under the
 * API's paths, a document link among them, throws before anything shows.
 */
export function ShareKit({ publicUrl, business, ownerName, urgentCallback }: ShareKitProps) {
  const words = SHARE_COPY(business, ownerName, publicUrl, { urgentCallback });
  return (
    <div className="cd-share-kit">
      <Card as="section" label="Your link">
        <p className="cd-share-kit__caption cd-type-caption">Your link</p>
        <CopyLink
          url={publicUrl}
          look="text"
          actions={
            <Button variant="secondary" size="main" href={publicUrl} external>
              Open
            </Button>
          }
        />
      </Card>
      <div className="cd-share-kit__kit">
        <div className="cd-share-kit__card">
          <ShareCard name={business} url={displayLink(publicUrl)} ownerName={ownerName} language="en" qr={<QrCode url={publicUrl} colors={SHARE_CARD_QR_COLORS} />} onPrint={printCard} />
        </div>
        <div className="cd-share-kit__words">
          <h2 className="cd-share-kit__heading cd-type-section">
            Ready-made words
          </h2>
          <CopyList label="Ready-made words" items={words} onCopy={writeToClipboard} />
          <section className="cd-share-kit__channels" aria-label="More channels">
            <h2 className="cd-share-kit__heading cd-type-section">More channels</h2>
            <Card padding={0}>
              <ul role="list" className="cd-share-kit__channel-list">
                {SHARE_CHANNELS.map((channel) => (
                  <li key={channel.key} className="cd-share-kit__later">
                    <div className="cd-share-kit__later-text">
                      <p className="cd-share-kit__later-title cd-type-control">{channel.name}</p>
                      <p className="cd-share-kit__later-line cd-type-meta">{channel.line}</p>
                    </div>
                    <Pill>Coming later</Pill>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        </div>
      </div>
    </div>
  );
}
