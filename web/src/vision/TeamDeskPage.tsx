import { useId } from 'react';

import {
  AccessPanel,
  Button,
  ConceptFooter,
  FactCard,
  MarginReceipt,
  PageHeader,
  Pill,
  Transcript,
  TranscriptRow,
  VisitorMessage,
} from '../ds/index.ts';
import { JORDAN_ACCESS, TEAM_CHAT, TEAM_EVERYONE, TEAM_HEADER, TEAM_OWNER, TEAM_TODAY, TEAM_TURNS, TEAMMATES, type TeamTurn } from './data.ts';
import { ClaudeWords, noop, VisionFrame, VisionOwnerShell } from './VisionFrame.tsx';

/** "Jordan Lee" is "JL": the first letters of the first and last names. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  return [words[0], words.length > 1 ? words[words.length - 1] : undefined].map((word) => Array.from(word ?? '')[0] ?? '').join('');
}

/**
 * `/vision/team-desk` (N-R2-Vision-TeamDesk): Sam Patel's Desk at Lumen Labs, with
 * Jordan's conversation open and the calendar, docs and notes his access lets him open beside it.
 */
export function TeamDeskPage() {
  const chatId = useId();
  return (
    <VisionFrame title="Sam Patel’s Desk">
      {(bar) => (
        <VisionOwnerShell bar={bar} {...TEAM_OWNER}>
          <div className="cd-vision-page cd-vision-team">
            <div>
              <PageHeader
                title={TEAM_HEADER.title}
                actions={
                  <Button variant="secondary" onClick={noop}>
                    {TEAM_HEADER.action}
                  </Button>
                }
              />
              <p className="cd-vision-quiet cd-type-meta cd-vision-team__lead">{TEAM_HEADER.lead}</p>
            </div>
            <div className="cd-vision-team__columns">
              <nav aria-label={TEAM_OWNER.peopleLabel} className="cd-vision-team__people">
                <a href="#everyone" className="cd-vision-team__person">
                  <span>
                    <span className="cd-type-control cd-vision-team__name">{TEAM_EVERYONE.name}</span>
                    <span className="cd-vision-quiet cd-type-caption cd-vision-team__line">{TEAM_EVERYONE.line}</span>
                  </span>
                </a>
                {TEAMMATES.map((person, index) => (
                  <a
                    key={person.name}
                    href={`#teammate-${index + 1}`}
                    className="cd-vision-team__person"
                    {...(person.name === TEAM_CHAT.name ? { 'aria-current': 'page' as const } : {})}
                  >
                    <span className="cd-vision-team__avatar cd-type-count" aria-hidden="true">
                      {initials(person.name)}
                    </span>
                    <span>
                      <span className="cd-type-control cd-vision-team__name" data-copy="user">
                        {person.name}
                      </span>
                      <span className="cd-vision-quiet cd-type-caption cd-vision-team__line">{person.line}</span>
                    </span>
                  </a>
                ))}
              </nav>
              <section className="cd-vision-team__chat" aria-labelledby={chatId}>
                <div className="cd-vision-team__head">
                  <h2 id={chatId} className="cd-type-section" data-copy="user">
                    {TEAM_CHAT.name}
                  </h2>
                  <Pill>{TEAM_CHAT.level}</Pill>
                  <span className="cd-vision-quiet cd-type-meta">{TEAM_CHAT.where}</span>
                  <span className="cd-vision-team__actions">
                    {TEAM_CHAT.actions.map((action) => (
                      <Button key={action} variant="secondary" onClick={noop}>
                        {action}
                      </Button>
                    ))}
                  </span>
                </div>
                <Transcript label={`Conversation with ${TEAM_CHAT.name}`}>
                  {TEAM_TURNS.map((turn) => (
                    <Turn key={turn.asked} turn={turn} ownerName={TEAM_OWNER.owner.name} />
                  ))}
                </Transcript>
              </section>
              <div className="cd-vision-team__access">
                <AccessPanel name={JORDAN_ACCESS.name} canOpen={JORDAN_ACCESS.canOpen} cantOpen={JORDAN_ACCESS.cantOpen} onEditAccess={noop} />
              </div>
            </div>
            <div className="cd-vision-team__foot">
              <p className="cd-vision-quiet cd-type-caption">{TEAM_TODAY}</p>
              <ConceptFooter />
            </div>
          </div>
        </VisionOwnerShell>
      )}
    </VisionFrame>
  );
}

/** A colleague's message, then Claude's answer with its cards, and the receipts under it. */
function Turn({ turn, ownerName }: { turn: TeamTurn; ownerName: string }) {
  return (
    <>
      <TranscriptRow>
        <VisitorMessage text={turn.asked} />
      </TranscriptRow>
      <TranscriptRow margin={turn.receipts.map((receipt) => <MarginReceipt key={receipt.plain} source={receipt.source} plain={receipt.plain} ledgerSeq={0} />)}>
        <div className="cd-vision-reply">
          <ClaudeWords text={turn.reply} ownerName={ownerName} />
          {turn.facts.map((fact) => (
            <FactCard key={fact.label} {...fact} />
          ))}
        </div>
      </TranscriptRow>
    </>
  );
}
