import { useId } from 'react';

import {
  ApprovalCard,
  ClaudeMessage,
  Composer,
  ConceptFooter,
  MarginReceipt,
  PhoneFrame,
  PhoneTabBar,
  StatusDot,
  Transcript,
  TranscriptRow,
  VisitorMessage,
} from '../ds/index.ts';
import { brandFrom } from '../public/brand.ts';
import { PHONE_CHAT, PHONE_PAGE, PHONE_TAB_HREFS, PHONE_TODAY, RIVERA_PUBLIC_DESK } from './data.ts';
import { noop, VisionFrame } from './VisionFrame.tsx';

/**
 * `/vision/phone` (N-R2-Vision-Phone): Claude Desk as phone apps, side by side under the title. The
 * owner's Today (the greeting, the held quote, who is talking to the Desk) over the five tabs, and
 * a visitor's public chat, where the booking is confirmed only next to its card.
 */
export function PhonePage() {
  return (
    <VisionFrame title={PHONE_PAGE.title}>
      {(bar) => (
        <div className="cd-vision-phone-page">
          {bar}
          <main className="cd-vision-phone">
            <div className="cd-vision-phone__head">
              <h1 className="cd-type-page-title">{PHONE_PAGE.title}</h1>
              <p className="cd-vision-quiet cd-type-meta">{PHONE_PAGE.lead}</p>
            </div>
            <div className="cd-vision-phone__phones">
              <OwnerPhone />
              <VisitorPhone />
            </div>
            <ConceptFooter />
          </main>
        </div>
      )}
    </VisionFrame>
  );
}

/** Today on the owner's phone: the greeting, the held quote and Live now, over the tab bar. */
function OwnerPhone() {
  const liveId = useId();
  return (
    <PhoneFrame caption={PHONE_PAGE.ownerCaption}>
      <div className="cd-vision-phone__screen">
        <div>
          <p className="cd-vision-phone__business cd-vision-quiet cd-type-caption">{PHONE_TODAY.business}</p>
          <h2 className="cd-type-greeting cd-vision-phone__greeting">{PHONE_TODAY.greeting}</h2>
        </div>
        {/* A vision page sends nothing: the answers keep their look and do nothing. */}
        <ApprovalCard decision={PHONE_TODAY.held} rule={PHONE_TODAY.rule} waiting={PHONE_TODAY.waiting} onAnswer={noop} inertAnswers />
        <section aria-labelledby={liveId}>
          <h3 id={liveId} className="cd-type-control cd-vision-phone__live-title">
            {PHONE_TODAY.liveTitle}
          </h3>
          <ul role="list" className="cd-vision-phone__live">
            {PHONE_TODAY.live.map((row) => (
              <li key={row.name} className="cd-vision-phone__live-row">
                <StatusDot tone={row.tone} />
                <span className="cd-type-control" data-copy="user">
                  {row.name}
                </span>
                <span className="cd-vision-quiet cd-type-caption cd-vision-phone__kind">{row.kind}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <PhoneTabBar current="today" hrefs={PHONE_TAB_HREFS} />
    </PhoneFrame>
  );
}

/** A visitor's chat on a phone: the business's header, the booking and its card, and the composer. */
function VisitorPhone() {
  const { brand } = brandFrom(RIVERA_PUBLIC_DESK);
  const composerLabel = PHONE_CHAT.composer;
  return (
    <PhoneFrame caption={PHONE_PAGE.visitorCaption}>
      {/* The business's own field and inks, as its public page's header draws them. */}
      <div className="cd-vision-phone__brand" style={{ background: brand.field, color: brand.ink }}>
        <span className="cd-vision-phone__monogram cd-type-control" aria-hidden="true">
          {brand.monogram}
        </span>
        <span>
          <span className="cd-type-control cd-vision-phone__brand-name" data-copy="user">
            {brand.name}
          </span>
          <span className="cd-type-caption cd-vision-phone__brand-line" style={{ color: brand.inkSecondary }}>
            {PHONE_CHAT.disclosureUnderName}
          </span>
        </span>
      </div>
      <div className="cd-vision-phone__chat">
        <Transcript label={`Conversation with ${brand.name}`}>
          <TranscriptRow>
            <VisitorMessage text={PHONE_CHAT.asked} />
          </TranscriptRow>
          <TranscriptRow margin={<MarginReceipt source={PHONE_CHAT.receipt.source} plain={PHONE_CHAT.receipt.plain} ledgerSeq={0} />}>
            <ClaudeMessage plainProse blocks={PHONE_CHAT.reply} language="en" ownerName={RIVERA_PUBLIC_DESK.owner_display_name} />
          </TranscriptRow>
        </Transcript>
      </div>
      <div className="cd-vision-phone__composer">
        <Composer variant="visitor" label={composerLabel} placeholder={composerLabel} maxLength={2000} onSend={noop} inertSend />
        <p className="cd-vision-quiet cd-type-caption cd-vision-phone__disclosure">{PHONE_CHAT.disclosure}</p>
      </div>
    </PhoneFrame>
  );
}
