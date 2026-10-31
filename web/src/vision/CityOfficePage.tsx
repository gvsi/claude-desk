import { useId } from 'react';

import { Button, Card, ConceptFooter, FactCard, Greeting, Icon, MarginReceipt, Pill, SectionHeader, TextLink } from '../ds/index.ts';
import {
  CITY_ALWAYS_ON,
  CITY_LIVE,
  CITY_LIVE_NOW,
  CITY_OWNER,
  CITY_TODAY_HEADER,
  CITY_TODAY_SO_FAR,
  VISION_SIDEBAR_HREFS,
  type CityLiveRow,
} from './data.ts';
import { ClaudeWords, VisionFrame, VisionOwnerShell } from './VisionFrame.tsx';

const noop = () => undefined;

/**
 * `/vision/city-office` (N-R2-Vision-CityOffice): Today on a fictional city permits office's Desk,
 * Meridian Bay Permits, for its Permit Center supervisor. Live now's conversations, what can't be
 * switched off on the city's Desk, and today's numbers. Every fee, date and permit status is in a
 * fact card, never in Claude's words.
 */
export function CityOfficePage() {
  const liveId = useId();
  return (
    <VisionFrame title={CITY_OWNER.business}>
      {(bar) => (
        <VisionOwnerShell bar={bar} {...CITY_OWNER}>
          <div className="cd-vision-page">
            <Greeting
              text={CITY_TODAY_HEADER.greeting}
              presence={{ line: CITY_TODAY_HEADER.presence, people: [] }}
              link={{ label: CITY_TODAY_HEADER.link, onCopy: noop }}
            />
            <div className="cd-vision-city">
              <section className="cd-vision-city__live" aria-labelledby={liveId}>
                <SectionHeader
                  id={liveId}
                  title={CITY_LIVE_NOW.title}
                  count={CITY_LIVE_NOW.count}
                  caption={<TextLink href={VISION_SIDEBAR_HREFS.conversations}>{CITY_LIVE_NOW.seeAll}</TextLink>}
                />
                <ul role="list" className="cd-vision-live">
                  {CITY_LIVE.map((row) => (
                    <LiveRow key={row.name} row={row} ownerName={CITY_OWNER.owner.name} />
                  ))}
                </ul>
              </section>
              <div className="cd-vision-city__side">
                <Card as="section" label={CITY_ALWAYS_ON.title} padding={16}>
                  <h2 className="cd-type-section cd-vision-city__title">
                    {CITY_ALWAYS_ON.title}
                  </h2>
                  <p className="cd-vision-quiet cd-type-caption cd-vision-city__caption">{CITY_ALWAYS_ON.caption}</p>
                  <ul role="list" className="cd-vision-always">
                    {CITY_ALWAYS_ON.lines.map((line) => (
                      <li key={line.title} className="cd-vision-always__item">
                        <Icon name="lock" size={14} className="cd-vision-always__lock" />
                        <span>
                          <span className="cd-type-control cd-vision-always__title">{line.title}</span>
                          <span className="cd-vision-quiet cd-type-meta cd-vision-always__detail">{line.detail}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="cd-vision-quiet cd-type-caption cd-vision-always__also">{CITY_ALWAYS_ON.also}</p>
                </Card>
                <Card as="section" label={CITY_TODAY_SO_FAR.title} padding={16}>
                  <h2 className="cd-type-section cd-vision-city__title">
                    {CITY_TODAY_SO_FAR.title}
                  </h2>
                  <ul role="list" className="cd-vision-today">
                    {CITY_TODAY_SO_FAR.lines.map((line) => (
                      <li key={line} className="cd-type-meta">
                        {line}
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>
            </div>
            <ConceptFooter />
          </div>
        </VisionOwnerShell>
      )}
    </VisionFrame>
  );
}

/**
 * One live conversation: who, their level and what it is about; Claude's words, then the fact card
 * they lead into; the receipt; and the one thing the supervisor can do. A row under a hairline, not
 * a card, so its fact card never sits in a card.
 */
function LiveRow({ row, ownerName }: { row: CityLiveRow; ownerName: string }) {
  return (
    <li className="cd-vision-live__item">
      <div className="cd-vision-live__head">
        <span className="cd-type-control" data-copy="user">
          {row.name}
        </span>
        <Pill>{row.level}</Pill>
        <span className="cd-vision-quiet cd-type-meta">{row.about}</span>
      </div>
      <ClaudeWords text={row.reply} language={row.language} ownerName={ownerName} />
      {row.fact ? <FactCard {...row.fact} /> : null}
      <MarginReceipt source={row.receipt.source} plain={row.receipt.plain} ledgerSeq={0} />
      {row.action ? (
        <div className="cd-vision-live__action">
          <Button variant="secondary" onClick={noop}>
            {row.action}
          </Button>
        </div>
      ) : null}
    </li>
  );
}
